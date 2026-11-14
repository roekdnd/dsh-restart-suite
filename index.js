/**
 * dsh-auto-restart —— Host 半边。
 *
 * 只做四件事：
 *   1. 注册唯一的工具入口 `restart_dsh`；
 *   2. 判断**整个 DSH** 是否空闲（任一 agent 在跑 / 任一 job 在跑 = 忙）；
 *   3. 空闲时进入倒计时，倒计时期间任何真实键鼠输入都能取消；
 *   4. 倒计时走完 → 拉起外部脚本 `Restart-DSH.ps1 -Detach`，然后立刻返回。
 *
 * 插件**不碰进程**：杀端口、执行命令、重启、唤醒那一整套全在脚本里。
 * 插件也**不判断**脚本那边是否执行成功 —— 它只负责「什么时候可以动手」。
 *
 * 状态通过一条 fenced HTTP 路由暴露给 Client 半边（正式 bundle 的 Client 不能
 * 直接调 Host，`host.call` 是动态插件专有通道；官方做法就是 Host 注册路由、
 * Client 用 fetch 访问 —— 与本机 dsh-preset-switcher / dsh-flow-runtime 一致）。
 *
 * 注意：HTTP 路由只服务于**本插件自己的界面**，不是给外部脚本轮询的公开 API。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  createRoster,
  readRoster,
  rosterPath,
  upsertSession,
  writeRoster,
  clearRoster,
  requestIdFor,
} from './core/roster.js'
import { deliverAll } from './after/deliver.js'
import {
  buildLaunchPlan,
  planFilePath,
  readHostFacts,
  validatePlan,
  writePlanFile,
} from './engine/plan.js'

/** 本插件包的根目录（本文件就在包根）。 */
const PACKAGE_ROOT = import.meta.dirname

/** 唯一的取名处：读本包 package.json 的 name，改包名不用改代码。 */
function readPackageName() {
  try {
    const raw = readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.name === 'string' && parsed.name.length > 0) return parsed.name
  } catch {
    // 读不到就退回占位，绝不让取名失败拖垮插件
  }
  return 'dsh-auto-restart'
}

export const name = readPackageName()

/** `tools` 是核心服务，硬依赖安全；`webServer` 可能还没就绪 ⇒ 走 ctx.inject。 */
export const inject = ['tools']

/** 面板/状态 API 路径（只给本插件自己的 Client 用）。 */
const API_PATH = '/dsh-restart-suite/api'

/**
 * UI 端点的门禁：本机回环 + 自定义请求头 + 同源。
 *
 * 宿主的 webServer **不做** Origin / 鉴权检查（实测：带外源 Origin 的 POST 照样进得来），
 * 而这个前缀下全是会改动状态的操作（取消倒计时、关提示页、写设置），门不做就等于
 * 本机随便哪个网页都能拨弄插件的状态机。三层：
 *   ① 带反向代理头的请求直接拒：说明来源已经过中间层，不可信；
 *   ② 来源必须是回环地址；
 *   ③ 必须带 `x-auto-restart: 1` —— 跨源请求带自定义头会先触发浏览器预检，而宿主
 *      不放行 CORS，所以别的网页打不进来（挡的是浏览器，不是本机的其它程序）；
 *   ④ 带了 Origin 就必须与 Host 同源（同源 fetch 不一定带 Origin，所以是「带了才查」）。
 */
const REQUEST_HEADER = 'x-dsh-restart-suite'

function checkRequestSource(req) {
  const headers = (req && req.headers) || {}
  for (const key of ['x-forwarded-for', 'x-real-ip', 'forwarded']) {
    if (headers[key] !== undefined) {
      return { ok: false, reason: `带了反向代理头 ${key}，来源不可信` }
    }
  }
  const addr = String((req && req.socket && req.socket.remoteAddress) || '')
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  if (!loopback) return { ok: false, reason: `来源不是本机回环地址（${addr || '未知'}）` }
  if (String(headers[REQUEST_HEADER] ?? '') !== '1') {
    return { ok: false, reason: `缺少 ${REQUEST_HEADER} 请求头` }
  }
  const origin = String(headers.origin ?? '').trim()
  if (origin !== '') {
    let sameOrigin = false
    try {
      sameOrigin = new URL(origin).host === String(headers.host ?? '').trim()
    } catch {
      sameOrigin = false
    }
    if (sameOrigin !== true) return { ok: false, reason: `Origin 与 Host 不同源（${origin}）` }
  }
  return { ok: true }
}

/** 外部重启脚本。随包附带，默认取包内的 scripts/，可用 config.scriptPath 覆盖。 */
const DEFAULT_SCRIPT = join(PACKAGE_ROOT, 'scripts', 'Restart-DSH.ps1')

/** 脚本默认唤醒词。 */
const DEFAULT_AUTOSAY = '已通过插件重启'

/**
 * 默认唤醒方式：'plugin' = Host 直投（不等渲染、不碰页面），'script' = 脚本用
 * CDP 往输入框打字（退路，要先等 React 挂载）。
 */
const DEFAULT_WAKE_MODE = 'plugin'

/**
 * 默认倒计时秒数。
 *
 * 5 秒是日常值。理由：方案 B 的 5 秒保护期已经能挡住「手滑」，倒计时再长就是纯冗余。
 * 需要更长取消窗口时由调用方当次传 countdownSec（验证用 10，复杂场景自定义）。
 */
const DEFAULT_COUNTDOWN = 5

/** 倒计时允许的范围。 */
const MIN_COUNTDOWN = 3
const MAX_COUNTDOWN = 600

/**
 * 本机开发用的 `POST /restart` 是否开启。
 *
 * 发布版没有这条路由：能让外部凭空重启一次 DSH 的入口，不该出现在交给别人的代码里。
 * 但开发时需要它——`restart_dsh` 有过「在工具表里、却进不了模型看到的定义」的毛病，
 * 那时只能从 HTTP 触发。所以留一个只认环境变量的开关，默认关闭。
 */
const LOCAL_RESTART_ENABLED = process.env.DSH_AUTO_RESTART_LOCAL_RESTART === '1'

/**
 * 倒计时末尾多给的缓冲（毫秒）。
 *
 * 显示侧用 ceil - 1 向下取整，所以 10 秒实际等待 = 10000 + 这段缓冲，
 * 屏幕上仍然是 10→9→…→0 每个数字各占 1 秒，最后这点缓冲是快动手前的余量。
 * 不要给到 1000：那会让第一个数字之前先闪一个多余的值。
 */
const COUNTDOWN_TAIL_MS = 500

/**
 * 进入倒计时后，最多等多久让页面把自己画出来。
 *
 * 为什么要等：倒计时是给人看的，表从「人看见第一个数字」那一刻起才有意义。
 * 从 Host 决定倒计时到浏览器画出第一帧，中间还有一次轮询、一次渲染，
 * 实测能吃掉将近 1 秒 —— 设置 10 秒却从 9 秒开始数，就是这段时间。
 *
 * 兜底的意义：页面可能根本没开（纯 CLI、网页端标签页关了）。那时候不能永远等，
 * 超过这个时间就照常开始走。
 */
const VIEWER_WAIT_MS = 10_000

/** 自定义命令的超时默认值（秒），以及允许的范围。 */
const DEFAULT_TIMEOUT_SEC = 600
const MIN_TIMEOUT_SEC = 10
const MAX_TIMEOUT_SEC = 3600

/** 日志保留份数默认值，以及允许的范围。 */
const DEFAULT_LOG_KEEP = 5
const MIN_LOG_KEEP = 1
const MAX_LOG_KEEP = 50

/** 等脚本注册完计划任务并返回的上限。 */
const LAUNCH_TIMEOUT_MS = 30_000

/**
 * launching 状态的看门狗。
 *
 * 正常路径下走不到这里：脚本拉起后 8～16 秒就会把本进程杀掉，定时器根本没机会
 * 触发。它只兜一种情况——脚本已经被拉起、但重启始终没发生（脚本被外部杀掉、
 * 计划任务没跑起来、权限不足等）。没有它，状态会永远停在 launching，遮罩一直
 * 挂在页面上，而页面又拦着所有键鼠操作，人只能等下一次重启才能恢复。
 */
const LAUNCH_WATCHDOG_MS = 90_000

/**
 * 「只有发起这次重启的那个会话自己还在跑」时，到点后再给它多久。
 *
 * 工具是秒回的：调用它的那一轮拿到 ok 之后还要继续写回复，而倒计时结束时
 * 它往往仍是 running（日志里两次 blocked 全是这个原因，不是别人在忙）。
 * 直接判忙等于「自己把自己拦下」，所以这里再等一小段，让它把这一轮说完。
 *
 * 只给一档、不无限等：等太久等于把「什么时候动手」交给一个不可控的回合长度。
 * 超过这段就作废并回投说明，人还来得及决定要不要再来一次。
 */
const SELF_SETTLE_MS = 30_000

/**
 * 失败回投的重试窗口。
 *
 * 回投走的是 `sessionController.prompt()`（和唤醒同一条通道），它在同一进程内、
 * 服务都已就绪，正常一次就成；留这段窗口只为兜「刚重启过的包还没把路由注册好」。
 */
const REPORT_RETRY_MS = 10_000

/**
 * 凑齐「所有想一起重启的会话」最多等多久。
 *
 * 多会话同时开发时，A 请求重启、B 还在写文件 —— 旧行为是 A 直接作废，
 * 于是谁先请求谁吃亏，最后只剩最后一个能成（木桶效应）。现在改成：A 进入
 * 「等人齐」状态，只要还有别的会话在跑就继续等，全空时一次性重启，
 * 然后把**所有等待中的会话**一起唤醒。
 *
 * 为什么要设上限：没有上限就等于「这台机器随时可能在未来某个时刻突然重启」，
 * 而那时的上下文早就不对了。给一档明确的上限，超了就如实报告并作废。
 */
const GATHER_MAX_MS = 10 * 60 * 1000

/**
 * 等人齐期间的**兜底**轮询间隔。
 *
 * 主判据改为**事件驱动**：`turn/end`（谁跑完了）和 `agent/status`（忙闲变了）
 * 一发生就立刻重判一次，所以正常情况下根本不用等这个定时器。
 *
 * 它只为兜三种情况：事件链路断了、`turn/end` 没落盘、或状态变化没有对应事件。
 * 因此间隔可以放得很慢 —— 之前是 1.5 秒（5 会话 × 10 分钟约 4400 次服务调用），
 * 现在 15 秒已经把最坏情况压到原来的 1/10。
 */
const GATHER_SWEEP_MS = 15_000

/**
 * 倒计时期间的「最短保护期」**上限**。
 *
 * 为什么需要它：倒计时原本是留给人的取消窗口（防手滑）。但实测（2026-11-09 10:37、
 * 11:24 两次）发现更大的浪费 —— 调用后 5 秒我就把这一轮说完了、机器也空闲，
 * 却还得干等倒计时走满（60 秒里白等 56 秒）。
 *
 * 折中：事件（发起会话的 turn/end）+ 全机空闲一起满足时，**只要已经过了保护期**
 * 就提前动手。
 *
 * ⚠️ 保护期必须随 countdownSec 自适应，不能固定 5 秒：
 *    min countdownSec = 3 秒，若保护期固定 5 秒，则「保护期永远压过倒计时」——
 *    用户设 3 秒，实际却要等 5 秒，设置形同虚设。
 *
 * 规则：保护期 = min(5 秒, countdownSec 的一半)。这样
 *    3 秒 → 保护期 1.5 秒（仍留一瞬取消窗口，但不会盖过设置）
 *    5 秒 → 保护期 2.5 秒
 *   10 秒 → 保护期 5 秒（上限）
 *   60 秒 → 保护期 5 秒（不必再长，事件到了就该走）
 */
const EARLY_GO_GRACE_MAX_MS = 5_000

/** 按这次倒计时的秒数算出本轮保护期。 */
function earlyGoGraceFor(countdownSec) {
  const n = Number(countdownSec)
  const 总长 = Number.isFinite(n) && n > 0 ? n * 1000 : 10_000
  return Math.min(EARLY_GO_GRACE_MAX_MS, Math.floor(总长 / 2))
}

/**
 * 「刚起不久」的窗口：非意向会话如果在这段时间内才开跑，硬拦。
 *
 * 为什么区别对待：刚开始的会话最可能在做**初始化动作**（读配置、建连接、
 * 写文件、装依赖），此刻打断最伤，而且它还没来得及把进度落到对话里；
 * 而跑了二十分钟的会话往往在等模型输出，打断损失小，且 interrupted-resume
 * 能靠「核对状态」续上。
 *
 * 这是启发式，不是硬判据 —— 所以它只会让**非意向**会话被拦，
 * 意向者（明确说过要重启的）永远不受影响。
 */
const FRESH_AGENT_MS = 5 * 60 * 1000

/**
 * 插件自己的状态目录（日志、待唤醒记录）。
 *
 * `DSHAR_STATE_DIR` 可覆盖：离线测试（`test/idle-check.mjs`）用它把日志和交接
 * 文件挪到临时目录，否则每跑一次测试都会往真正的 `plugin.log` 里插两行
 * 「已加载」，而 agent 排查时正是靠读这份日志。
 */
/**
 * 状态目录。
 *
 * **沿用旧的 dsh-auto-restart**，不是偷懒 —— 那个目录里有：
 *   - settings.json（用户改过的倒计时、唤醒词、launchCommand）
 *   - logs/（历史排查记录）
 *   - wake-request.json（脚本写 ready 的信号文件）
 * 换目录等于这些全部丢失，而用户不会知道要去哪找。
 *
 * roster.json 也放同一目录：它和 wake-request.json 靠 runId 关联，
 * 分两个目录只会增加出错概率。
 */
const STATE_DIR =
  typeof process.env.AR_STATE_DIR === 'string' && process.env.AR_STATE_DIR.trim().length > 0
    ? process.env.AR_STATE_DIR.trim()
    : join(homedir(), '.dsh', 'dsh-auto-restart')
/** 日志目录。 */
const LOG_DIR = join(STATE_DIR, 'logs')

/**
 * 「重启后要唤醒谁、说哪句话」的落盘位置。
 *
 * 动手杀进程的脚本在**另一个进程**里，插件没法把内存里的东西交给它；
 * 而重启之后新进程需要知道该回到哪个会话。落一个 json 是最省事、也最经得起
 * 崩溃的方式：写不进去就别用 plugin 模式（见工具里的 wakeMode）。
 */
const PENDING_FILE = join(STATE_DIR, 'pending-wake.json')

/**
 * 两阶段交接文件：插件写前半（唤醒谁、说什么），脚本写后半（成没成、什么时候成的）。
 *
 * 为什么要分两次写：
 * - 插件在**被杀之前**必须先落盘，否则「唤醒谁」就丢了；
 * - 只有脚本知道 DSH 到底有没有被拉起来，所以「成没成 + 启动时间」只能由它写。
 *
 * 字段：`{ runId, phase: 'starting'|'ready'|'failed'|'delivered', sessionId, text, requestedAt, startedAt, error }`
 */
const WAKE_REQUEST_FILE = join(STATE_DIR, 'wake-request.json')

/**
 * 「除发起者之外，还要唤醒哪些会话」的名单。
 *
 * 为什么不塞进 wake-request.json：那份文件由 `Restart-应用.ps1` 在写 ready
 * 阶段时**整个重建**（只保留它认识的字段），我们加的字段会被丢掉。所以单独
 * 一个文件，脚本从不碰它。
 *
 * 字段：`{ runId, sessions: [{ sessionId, text }] }`
 */
const EXTRA_WAKE_FILE = join(STATE_DIR, 'wake-extra.json')

/**
 * 脚本跑完命令后的结果，由 `Restart-DSH.ps1` 写在同一个目录。
 *
 * 为什么要有这个文件：命令失败或超时也照样重启，这件事发生在**另一个进程**里，
 * 插件只有读它的结果，才能在唤醒词后面补一句「（命令失败：退出码 N）」。
 */
const RUN_RESULT_FILE = join(STATE_DIR, 'last-run.json')

/**
 * 设置页里那几项「默认值」的落盘位置。
 *
 * 为什么要落盘：它承载的是**用户偏好**，不是一次调用的参数。不存的话，DSH 一重启
 * 就退回代码默认值，用户改过的倒计时、唤醒词等于白改——踩过一次。
 */
const SETTINGS_FILE = join(STATE_DIR, 'settings.json')

/**
 * 启动计划：宿主把自己「怎么跑起来的」写在这，脚本照着它重启。
 *
 * 为什么不放在 settings.json 里：它是**观察结果**（argv/execPath/端口），不是偏好，
 * 每次重启前都要重写一遍；混进设置文件会让「用户改过什么」变得看不出来。
 * 生成逻辑在 `lib/launch-plan.js`，这里只负责落盘和路径传递。
 */
const PLAN_FILE = planFilePath(STATE_DIR)

/** 落盘记录的有效期：超过这个时间还没投递就当它陈旧了。 */
const PENDING_TTL_MS = 15 * 60 * 1000

/** 新进程起来后，最多花这么久去把欠下的那句唤醒词投递掉。 */
const WAKE_RETRY_MS = 120_000

/** 插件运行时状态。Client 每次轮询拿到的就是它。 */
function createState() {
  return {
    /**
     * idle | counting | settling | waiting | launching | blocked | cancelled | failed
     *
     * settling = 倒计时到点时只有发起会话自己还在跑，正在等它把这一轮说完。
     * waiting  = 还有别的会话在忙，等人齐了一起重启（多会话同步点）。
     */
    phase: 'idle',
    /** counting 阶段的截止时间（epoch ms） */
    deadline: 0,
    /** 本次倒计时总秒数 */
    countdownSec: 0,
    /** 取消原因：input | api | abort */
    cancelReason: '',
    /** 将要执行的命令 */
    command: '',
    /** 唤醒词 */
    autoSay: '',
    /** 发起这次重启的会话 */
    sessionId: '',
    /** phase === 'blocked' 时：谁在忙 */
    blockers: [],
    /** 方案 3：被允许打断的无关会话数量（只在 waiting 阶段有意义） */
    strangerCount: 0,
    /** 最近一次结果（给界面显示） */
    last: null,
  }
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 没有任何历史设置文件时，七项设置各取什么。 */
const SETTINGS_DEFAULTS = {
  autoSay: DEFAULT_AUTOSAY,
  timeoutSec: DEFAULT_TIMEOUT_SEC,
  countdownSec: DEFAULT_COUNTDOWN,
  logKeep: DEFAULT_LOG_KEEP,
  wakeMode: DEFAULT_WAKE_MODE,
  /**
   * 启动命令覆盖。空字符串 = 自动（宿主自述 + argv 重放），这是默认路径。
   * 只有重放不可行时（npx 缓存被清、自制 bat 包装、容器）才由 agent 写一条完整命令。
   */
  launchCommand: '',
  /** 总开关。false 时 `restart_dsh` 直接拒绝，连倒计时都不进。 */
  allowAutoRestart: true,
}

/**
 * 读回设置：以代码默认值打底，再用文件里**通过校验**的字段覆盖。
 *
 * 逐字段校验而不是整体信任——手工改坏的文件只该丢掉那一个字段，
 * 不该把其余四项一起打回默认；范围外的值按 clamp 收进来，而不是整份作废。
 */
function loadSettings() {
  const merged = { ...SETTINGS_DEFAULTS }
  const saved = readSettingsFile()
  if (!saved) return merged
  if (typeof saved.autoSay === 'string' && saved.autoSay.trim().length > 0) {
    merged.autoSay = saved.autoSay.trim().slice(0, 200)
  }
  if (saved.timeoutSec !== undefined) {
    merged.timeoutSec = clampInt(saved.timeoutSec, MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC)
  }
  if (saved.countdownSec !== undefined) {
    merged.countdownSec = clampInt(saved.countdownSec, MIN_COUNTDOWN, MAX_COUNTDOWN, DEFAULT_COUNTDOWN)
  }
  if (saved.logKeep !== undefined) {
    merged.logKeep = clampInt(saved.logKeep, MIN_LOG_KEEP, MAX_LOG_KEEP, DEFAULT_LOG_KEEP)
  }
  if (saved.wakeMode === 'plugin' || saved.wakeMode === 'script') {
    merged.wakeMode = saved.wakeMode
  }
  if (typeof saved.launchCommand === 'string') {
    // 空串是合法值（= 回到自动），所以这里不判长度，只裁长度上限。
    merged.launchCommand = saved.launchCommand.trim().slice(0, 2000)
  }
  if (saved.allowAutoRestart === false || saved.allowAutoRestart === true) {
    merged.allowAutoRestart = saved.allowAutoRestart
  }
  return merged
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** 读一个服务的 `list()`（原型方法要 bind，不能丢 this）。 */
function safeList(service) {
  if (!service || typeof service.list !== 'function') return []
  try {
    const list = service.list.bind(service)()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 收集「谁在忙」。
 * 取不到某个服务时**按忙处理** —— 宁可不动手，也不要杀正在干活的进程。
 */
/**
 * 插件自己创建的后台任务 / 子代理 —— 它们不算阻塞项，否则插件会把自己锁死。
 * 目前插件不建任何 job；留着这个集合，是为了以后真加了也不会自锁。
 */
const OWN_JOB_IDS = new Set()

/**
 * 现在有哪些东西在忙。
 *
 * 这里**不排除调用工具的那个 agent**：规则是「倒计时结束时除了插件自己，
 * 谁在跑都不重启」。工具已经秒回、本轮回复也发完了，它要是还在 running，
 * 说明这一轮确实没说完，该拦。
 */
async function collectBlockers(services) {
  const blockers = []
  let sawAgentService = false
  const roster = []

  const agents = services.agents
  if (agents) {
    sawAgentService = true
    for (const agent of safeList(agents)) {
      if (!agent) continue
      roster.push(agent)
      let status
      try {
        status = agent.status
      } catch {
        status = 'running' // 读不到状态 = 当它在跑
      }
      if (status === 'running') {
        blockers.push({ kind: 'agent', id: String(agent.id ?? ''), label: '有会话正在跑' })
      }
    }
  }
  if (!sawAgentService) {
    blockers.push({ kind: 'agent', id: '', label: '拿不到 agents 服务，无法确认空闲' })
  }

  // 排队消息：agent 看起来 idle，但信箱里压着一条，这时候动手就是把它吞了。
  // 判据对齐宿主自己的 hasDesktopActiveTasks（dsh-desktop-host/lib/index.js:100）。
  for (const agent of roster) {
    let queued = 0
    try {
      const inbox = agent.inbox || {}
      queued = (inbox.nextTurn?.length ?? 0) + (inbox.nextStep?.length ?? 0)
    } catch {
      queued = 0
    }
    if (queued > 0) {
      blockers.push({ kind: 'queued', id: String(agent.id ?? ''), label: '有排队消息待处理' })
      break
    }
  }

  // 已武装的定时提醒：到点会真的开跑，也算「有人在等这台机器」。
  // 宿主只在退出检查里查这个（quit-inspection），这里照抄同一条瀑布。
  if (roster.length > 0 && typeof services.sessionActivity === 'function') {
    for (const agent of roster) {
      const rows = await services.sessionActivity(agent.id)
      if (!Array.isArray(rows)) continue
      if (rows.some((entry) => entry && entry.kind === 'schedule')) {
        blockers.push({ kind: 'schedule', id: String(agent.id ?? ''), label: '有已武装的定时提醒' })
        break
      }
    }
  }

  const jobs = services.jobs
  if (jobs) {
    const seen = new Map()
    const remember = (list) => {
      for (const job of list ?? []) {
        if (job && job.id !== undefined) seen.set(job.id, job)
      }
    }
    remember(safeList(jobs))
    for (const agent of safeList(services.agents)) {
      if (!agent || agent.id === undefined) continue
      try {
        remember(jobs.list ? jobs.list.bind(jobs)(agent.id) : [])
      } catch {
        // 查不动的那个 owner 忽略掉即可；agents 那边已经覆盖了它的忙闲
      }
    }
    for (const job of seen.values()) {
      if (job.status === 'running' || job.status === 'stopping') {
        // 插件自己起的任务不算忙，否则它永远等不到自己空闲。
        if (job.id !== undefined && OWN_JOB_IDS.has(String(job.id))) continue
        // 后台任务的 label 常常是整段命令：取首行 + 截断，否则提示页会被撑爆
        const raw = String(job.label || job.kind || '后台任务')
        const label = raw.split('\n')[0].trim().slice(0, 60)
        blockers.push({
          kind: 'job',
          id: String(job.id),
          label: label.length > 0 ? label : '后台任务',
        })
      }
    }
  }

  return blockers
}

/**
 * Windows PowerShell 5.1 往控制台写中文用的是 OEM 代码页（本机 936 = GBK），
 * 按 UTF-8 直接解会得到一屏问号。先按**严格** UTF-8 试一次（纯 ASCII 和本来
 * 就是 UTF-8 的输出都能过），解不了才退回 GBK。
 */
function decodeConsole(buffer) {
  if (buffer.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer)
    } catch {
      return buffer.toString('utf8')
    }
  }
}

/**
 * 拉起外部脚本。
 * `-Detach` 让脚本自己注册计划任务、把真正的工作交给独立进程，然后立刻返回；
 * 所以这里通常 1-2 秒就能拿到退出码。
 *
 * `-Mode` 不传：脚本自己判断载体（有主窗口=桌面端，没有=网页端）。
 * `-WebPort` 传当前端口：网页端重启后必须绑回同一个端口，页面才连得回来。
 *
 * `planPath` 是**必给**的：脚本只照计划执行，不再自己猜 dsh 装在哪。
 * 没有计划就什么都不杀（见 `finishCountdown` 的校验门）。
 */
function launchScript(scriptPath, command, autoSay, commandTimeoutSec, webPort, planPath) {
  return new Promise((resolve) => {
    let settled = false
    /** 收集原始字节，最后再决定用哪种编码解 —— 见 decodeConsole 的注释。 */
    const chunks = []
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const scriptArgs = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Command',
      command,
      '-AutoSay',
      autoSay,
      '-CommandTimeoutSec',
      String(commandTimeoutSec),
      '-Detach',
    ]
    if (Number.isInteger(webPort) && webPort > 0) {
      scriptArgs.push('-WebPort', String(webPort))
    }
    if (typeof planPath === 'string' && planPath.length > 0) {
      scriptArgs.push('-PlanPath', planPath)
    }
    // 把自己的 pid 交给脚本：载体（桌面端/网页端）由脚本猜会猜错 ——
    // 两个实例并存时「有窗口=桌面端」这条判据会把网页端内核一起杀掉。
    // 直接告诉它「我就在这个进程里」，脚本就能精确判定、精确关进程。
    scriptArgs.push('-OwnerPid', String(process.pid))

    let child
    try {
      child = spawn('powershell.exe', scriptArgs, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      finish({ ok: false, error: '拉起脚本失败：' + String(err) })
      return
    }

    /**
     * 输出上限：只保留尾部这么多字节。
     *
     * `finish()` 最终只用最后 4000 字节，但原来是把**全量**输出先攒进
     * `chunks`、最后才 `slice(-4000)`——峰值是整份输出 + 一份拼接副本。
     * 脚本卡住时（超时且 kill 不掉），这个缓冲区会一直涨。这里改成边收边裁。
     */
    const 输出上限 = 64 * 1024
    let 已收字节 = 0
    const 收输出 = (chunk) => {
      // finish() 之后流可能还会来数据（超时路径已经把 Promise 结了），
      // 不再收，否则缓冲区在结论给出后仍然被人写。
      if (settled) return
      chunks.push(chunk)
      已收字节 += chunk.length
      while (已收字节 > 输出上限 && chunks.length > 1) {
        已收字节 -= chunks.shift().length
      }
      // 单块就超上限时，只留尾部
      if (chunks.length === 1 && chunks[0].length > 输出上限) {
        chunks[0] = chunks[0].subarray(chunks[0].length - 输出上限)
        已收字节 = 输出上限
      }
    }

    const timer = setTimeout(() => {
      // 先给结论，再拆管道：这样 destroy() 触发的 close 会因为 settled 直接返回。
      finish({ ok: false, error: `脚本 ${LAUNCH_TIMEOUT_MS / 1000} 秒内没有返回` })
      try {
        child.kill()
      } catch {
        // 杀不掉也没关系，下面照样断开引用
      }
      // kill 失败时，子进程和它的管道句柄会一直挂在父进程上 —— 断开流引用并
      // unref，至少让它们不再钉住这个进程和这块内存。
      try {
        child.stdout?.destroy()
        child.stderr?.destroy()
      } catch {
        /* 已经关了 */
      }
      if (typeof child.unref === 'function') child.unref()
    }, LAUNCH_TIMEOUT_MS)

    if (child.stdout) child.stdout.on('data', 收输出)
    if (child.stderr) child.stderr.on('data', 收输出)
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: '脚本进程异常：' + String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ ok: code === 0, code, output: decodeConsole(Buffer.concat(chunks)).slice(-4000) })
    })
  })
}

// ── 待唤醒记录：跨进程交接 ────────────────────────────────────────────
// 写：倒计时走完、拉起脚本之前；读：新进程 apply() 之后。
//
// 两阶段协议：插件写「唤醒谁、说什么」，脚本补「成没成、什么时候成的」。
// 只有读到 ready 才真正投递 —— 脚本没成功拉起 DSH 时，投递也投不到。

function makeRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 去掉 UTF-8 BOM。
 *
 * 这些 json 有一半是外部脚本写的，而 Windows PowerShell 5.1 的
 * `Set-Content -Encoding UTF8` **会写 BOM**；`JSON.parse` 遇到 BOM 直接抛
 * `Unexpected token ''`。脚本那边已经改成无 BOM 写入了，这里再兜一层，
 * 免得旧文件或别人手写的文件把唤醒流程卡死。
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function parseJsonFile(file) {
  return JSON.parse(stripBom(readFileSync(file, 'utf8')))
}

/**
 * 读设置文件。**任何异常都返回 `null`**：设置是最不该让插件起不来的一类数据，
 * 文件不存在、权限不够、内容被人手改坏，一律当作「没设过」，由代码默认值兜底。
 */
function readSettingsFile() {
  try {
    const raw = parseJsonFile(SETTINGS_FILE)
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * 写设置文件。失败只返回 `false`，**不影响内存里已经生效的值**——
 * 用户刚点的保存，不该因为磁盘问题而看起来没生效。
 */
function writeSettingsFile(value) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function writeWakeRequest(payload) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(WAKE_REQUEST_FILE, JSON.stringify(payload, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function readWakeRequest() {
  try {
    const parsed = parseJsonFile(WAKE_REQUEST_FILE)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      runId: typeof parsed.runId === 'string' ? parsed.runId : '',
      phase: typeof parsed.phase === 'string' ? parsed.phase : '',
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '',
      text: typeof parsed.text === 'string' ? parsed.text : '',
      requestedAt: typeof parsed.requestedAt === 'number' ? parsed.requestedAt : 0,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      deliveredAt: typeof parsed.deliveredAt === 'number' ? parsed.deliveredAt : 0,
      error: typeof parsed.error === 'string' ? parsed.error : '',
    }
  } catch {
    return null
  }
}

function clearWakeRequest() {
  try {
    rmSync(WAKE_REQUEST_FILE, { force: true })
  } catch {
    // 删不掉就留着，靠 runId 去重
  }
}

function writeExtraWake(payload) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(EXTRA_WAKE_FILE, JSON.stringify(payload, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function readExtraWake() {
  try {
    const parsed = parseJsonFile(EXTRA_WAKE_FILE)
    if (!parsed || typeof parsed !== 'object') return null
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions
          .filter((x) => x && typeof x.sessionId === 'string' && x.sessionId.trim() !== '')
          .map((x) => ({
            sessionId: x.sessionId.trim(),
            text: typeof x.text === 'string' ? x.text : '',
          }))
      : []
    return { runId: typeof parsed.runId === 'string' ? parsed.runId : '', sessions }
  } catch {
    return null
  }
}

function clearExtraWake() {
  try {
    rmSync(EXTRA_WAKE_FILE, { force: true })
  } catch {
    // 删不掉就留着，靠 runId 去重
  }
}

/**
 * 交接文件是**一次性的**：插件一旦看过，不论最后有没有投出去，都把它删掉。
 *
 * 用户定下的模型：**只保留最近一次的运行状态，做完就改状态**。最初的做法是投递成功后
 * 把 phase 改成 `delivered` 留着，但那样会留下一个「已经处理完」的残骸，下次启动还得
 * 再判一次它到底做过没做。清空更干净：
 * - 文件在 = 有欠账（要么还没到 ready，要么还没投出去）；
 * - 文件不在 = 没有欠账。
 * 投递失败也删，宁可漏一次唤醒，也不让一份过期的欠条在下次启动时被误投出去。
 */

/** 旧版单阶段记录：只读不写，留给升级前留下的文件兜底。 */
function readPendingWake() {
  try {
    const parsed = parseJsonFile(PENDING_FILE)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function clearPendingWake() {
  try {
    rmSync(PENDING_FILE, { force: true })
  } catch {
    // 删不掉就留着，下次启动多半还能用
  }
}

/**
 * 读脚本写下的命令执行结果。没跑命令、或文件还没写出来，都返回 null。
 *
 * 字段：`{ at: 毫秒, exitCode: 数字|null, timedOut: 布尔, command: 字符串 }`
 */
function readRunResult() {
  try {
    const parsed = parseJsonFile(RUN_RESULT_FILE)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      at: typeof parsed.at === 'number' ? parsed.at : 0,
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
      timedOut: parsed.timedOut === true,
      command: typeof parsed.command === 'string' ? parsed.command : '',
    }
  } catch {
    return null
  }
}

/**
 * 按脚本的执行结果，给唤醒词补一句后缀。
 *
 * 只认**这次**的结果：`result.at` 必须不早于待唤醒记录的写入时间，
 * 否则就是上一轮留下的旧账，补上去只会让人误会。
 */
function decorateWakeText(text, sinceAt, reader = readRunResult) {
  const result = reader()
  if (!result || result.at < sinceAt) return text
  if (result.timedOut) return `${text}（命令超时被中止）`
  if (result.exitCode !== null && result.exitCode !== 0) {
    return `${text}（命令失败：退出码 ${result.exitCode}）`
  }
  return text
}

/**
 * 把上一轮欠下的那句唤醒词投递到原会话。
 *
 * 入口只看两件事：有交接文件就走两阶段协议（等脚本写 ready 再发），
 * 只有旧的 pending-wake.json 才走单阶段兜底。
 */
async function deliverPendingWake(getService, log) {
  const request = readWakeRequest()
  if (request && request.sessionId && request.runId) {
    await deliverTwoPhase(request, getService, log)
    return
  }
  await deliverLegacyPending(getService, log)
}

/**
 * 两阶段交接文件的主流程：等 ready → 投递 → 把状态改成 delivered。
 *
 * 为什么不能读到 starting 就发：DSH 还没起来，`sessionController` 根本不在，
 * 发出去只会白等；而且脚本失败时（failed）压根不该发。
 *
 * 「只投一次」不靠账本，靠 phase 自己：投完立刻改成 `delivered`，
 * 下次启动读到 delivered 就什么都不做。
 */
/**
 * 把「一起等的其它会话」逐个唤醒。
 *
 * 只在发起者的唤醒词投递成功之后才做——它成功就说明服务已就绪，
 * 后面的投递几乎不会再失败。单个失败不影响其它人：每个都独立 try 一次。
 *
 * 文案沿用各自的 autoSay；若它没写，用一条通用说明（因为各会话的改动不同，
 * 不能替它们编造「该验证什么」）。
 */
async function 投递附加唤醒(getService, log, runId, sinceAt) {
  const extra = readExtraWake()
  if (!extra || extra.sessions.length === 0) return
  if (runId && extra.runId && extra.runId !== runId) {
    log(`附加唤醒名单的 runId 不匹配（${extra.runId} ≠ ${runId}），忽略`)
    return
  }
  log(`开始投递附加唤醒：${extra.sessions.length} 个会话`)
  for (const item of extra.sessions) {
    const base =
      item.text.trim().length > 0
        ? item.text.trim()
        : '应用 已经重启（你和其它会话一起等的这次）。请确认你刚改的东西是否已生效，再继续。'
    const text = decorateWakeText(base, sinceAt)
    let ok = false
    for (let i = 0; i < 6 && !ok; i += 1) {
      ok = await pushWake(getService, log, item.sessionId, text, i + 1, '附加唤醒', runId)
      if (!ok) {
        log(`投递未成功【附加唤醒】target=${item.sessionId} runId=${runId} 第 ${i + 1} 次，500ms 后重试`)
        await sleep(500)
      }
    }
    if (!ok) log(`附加唤醒失败：${item.sessionId}（其它会话不受影响）`)
  }
}

async function deliverTwoPhase(request, getService, log) {
  const requestedAt = request.requestedAt > 0 ? request.requestedAt : Date.now()
  if (Date.now() - requestedAt > PENDING_TTL_MS) {
    clearWakeRequest()
    log(`交接文件里的请求是 ${Math.round((Date.now() - requestedAt) / 60000)} 分钟前的，已过期，丢弃`)
    return
  }

  let phase = request.phase
  log(`发现交接文件：runId ${request.runId}，阶段 ${phase || '空'}，目标会话 ${request.sessionId}`)

  if (phase === 'delivered') {
    clearWakeRequest()
    log('这轮唤醒已经投递过了（旧版留下的 phase = delivered，已删除）')
    return
  }

  if (phase === 'failed') {
    log(`上一轮重启失败（${request.error || '原因未知'}），不唤醒`)
    clearWakeRequest()
    return
  }

  const deadline = Date.now() + WAKE_RETRY_MS
  let attempt = 0
  let delay = 250
  let lastError = ''

  while (Date.now() < deadline) {
    attempt += 1

    if (phase !== 'ready') {
      const fresh = readWakeRequest()
      if (fresh && fresh.runId === request.runId) {
        phase = fresh.phase
        if (fresh.phase === 'failed') {
          log(`重启失败（${fresh.error || '原因未知'}），不唤醒`)
          clearWakeRequest()
          return
        }
        if (fresh.startedAt > 0) request.startedAt = fresh.startedAt
      }
      if (phase !== 'ready') {
        lastError = `脚本还没写 ready（当前 ${phase || '空'}）`
        // 这一支以前只更新 lastError、不写日志 —— 于是「尝试=10」时看不到前 9 次
        // 为什么失败。重启后 sessionController 注册有延迟是常态，必须能查。
        log(
          `等待就绪【唤醒】runId=${request.runId} 第 ${attempt} 次检查：` +
            `交接文件 phase=${phase || '空'}（还不是 ready），${Math.round(delay)}ms 后重试`,
        )
        await sleep(delay)
        delay = Math.min(2000, delay * 2)
        continue
      }
      log(
        `交接文件已就绪（第 ${attempt} 次检查）：DSH 启动于 ${new Date(
          request.startedAt > 0 ? request.startedAt : Date.now(),
        ).toISOString()}`,
      )
    }

    const base = request.text.trim().length > 0 ? request.text.trim() : DEFAULT_AUTOSAY
    const text = decorateWakeText(base, requestedAt)
    if (await pushWake(getService, log, request.sessionId, text, attempt, '唤醒', request.runId)) {
      // 发起者已唤醒 → 接着把一起等的其它会话也叫起来。
      await 投递附加唤醒(getService, log, request.runId, requestedAt)
      clearWakeRequest()
      clearExtraWake()
      log(`已投递，交接文件已删除（runId ${request.runId}）`)
      return
    }
    lastError = '服务还没就绪'
    log(
      `投递未成功【唤醒】runId=${request.runId} 第 ${attempt} 次尝试失败` +
        `（sessionController 可能还没注册好），${Math.round(delay)}ms 后重试`,
    )
    await sleep(delay)
    delay = Math.min(2000, delay * 2)
  }

  log(
    `唤醒失败【总结】target=${request.sessionId} runId=${request.runId} ` +
      `共尝试=${attempt} 次 ${WAKE_RETRY_MS / 1000} 秒内未成功（最后一次：${lastError}）`,
  )
  clearWakeRequest()
  log('交接文件已删除：宁可漏这一次，也不留一份过期的欠条给下次启动')
}

/** 旧版单阶段记录（升级前留下的 pending-wake.json）——只投递，不再写新文件。 */
async function deliverLegacyPending(getService, log) {
  const pending = readPendingWake()
  if (!pending) return

  const at = typeof pending.at === 'number' ? pending.at : 0
  if (Date.now() - at > PENDING_TTL_MS) {
    clearPendingWake()
    log(`发现一条 ${Math.round((Date.now() - at) / 60000)} 分钟前的待唤醒记录，已过期，丢弃`)
    return
  }

  const sessionId = typeof pending.sessionId === 'string' ? pending.sessionId.trim() : ''
  if (!sessionId) {
    clearPendingWake()
    log('待唤醒记录里没有会话 id，丢弃')
    return
  }

  const base = typeof pending.text === 'string' && pending.text.trim().length > 0 ? pending.text.trim() : DEFAULT_AUTOSAY
  const text = decorateWakeText(base, at)

  const deadline = Date.now() + WAKE_RETRY_MS
  let attempt = 0
  let delay = 250
  while (Date.now() < deadline) {
    attempt += 1
    if (await pushWake(getService, log, sessionId, text, attempt, '唤醒', `legacy-${at}`)) {
      clearPendingWake()
      return
    }
    log(`投递未成功【旧版唤醒】target=${sessionId} 第 ${attempt} 次，${Math.round(delay)}ms 后重试`)
    await sleep(delay)
    delay = Math.min(2000, delay * 2)
  }
  log(`唤醒没成功：${WAKE_RETRY_MS / 1000} 秒内没能把「${text}」投给会话 ${sessionId}；记录留在 ${PENDING_FILE}`)
}

/**
 * 真正把一句话投进会话。成功返回 true。
 *
 * 优先 `sessionController.prompt()` —— 它会自己把冷会话 resume 起来；
 * 没有这个服务时退回 `agent.followup()`，但那要求 agent 已经在跑，只当兜底。
 */
/**
 * 投递一次性消息到某个会话。成功返回 true。
 *
 * ⚠️ requestId 必须**跨重试保持不变**（2026-11-09 修）。
 *
 * 之前这里是 `...-${Date.now()}-${attempt}`，每次重试都是新 id ——
 * 那等于把这层幂等彻底关掉了：宿主认不出「这是同一条消息的重复投递」，
 * 重启途中崩掉再重试时，同一条唤醒词会被投两次。
 *
 * 现在的算法：`restart-wake-<runId>-<sessionId>`，同一次重启里对同一个
 * 会话永远同一个 id，换 attempt 也不变。宿主按 requestId 去重。
 */
async function pushWake(getService, log, sessionId, text, attempt, label = '唤醒', runId = '') {
  const kind = label === '唤醒' || label === '附加唤醒' ? 'wake' : 'report'
  const requestId = runId
    ? `restart-${kind}-${runId}-${sessionId}`
    : `restart-${kind}-adhoc-${sessionId}`
  const 详情 = `requestId=${requestId} 尝试=${attempt} 通道=`
  try {
    const controller = getService('sessionController')
    if (controller && typeof controller.prompt === 'function') {
      // 签名是 prompt(request, signal)：signal 只用来在**受理前**中断，
      // 受理之后就交给 agent 了，所以这里给一个永不触发的中断器。
      await controller.prompt(
        { sessionId, content: [{ type: 'text', text }], requestId },
        new AbortController().signal,
      )
      // 结构化：目标会话 + requestId + 通道 + 尝试次数，便于事后核对有没有重复投递
      log(`投递完成【${label}】target=${sessionId} ${详情}sessionController 文长=${text.length}`)
      return true
    }

    const agent = getService('agents')?.get?.(sessionId)
    if (agent && typeof agent.followup === 'function') {
      await agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      log(`投递完成【${label}】target=${sessionId} ${详情}agent.followup 文长=${text.length}`)
      return true
    }
    log(`投递失败【${label}】target=${sessionId} ${详情}无可用通道（既无 sessionController.prompt，也无 agent.followup）`)
    return false
  } catch (err) {
    log(`投递失败【${label}】target=${sessionId} ${详情}错误：${String(err?.message ?? err)}`)
    return false
  }
}

/**
 * 把「这次重启没发生」告诉发起它的那个会话。
 *
 * 为什么必须有这一步：`restart_dsh` 只能秒回（等倒计时会让调用它的那一轮永远
 * 把自己判成忙），于是倒计时之后的所有终态——忙、计划不可用、脚本没起来、
 * 看门狗超时——都发生在工具返回**之后**。不主动回投，agent 那边就只看到
 * 「倒计时已开始」，收完尾就断了，而重启其实早就作废了，只有用户看得到卡片。
 *
 * 走的是与唤醒完全相同的通道（`sessionController.prompt()`，退回
 * `agent.followup()`），只是文案不同。同一进程、服务已就绪，正常一次就成。
 */
async function reportToSession(getService, log, sessionId, text, label = '回投') {
  if (!sessionId) {
    log(`${label}跳过：这次调用没有会话 id（不是从会话里发起的）`)
    return false
  }
  // 这次回投的稳定标识：同一轮 reportToSession 内的所有重试共用一个 id，
  // 不同次的回投才换新（否则两次不同原因的失败会被宿主误判成同一条而只投一次）。
  const 本次回投id = `report-${Date.now()}`
  const deadline = Date.now() + REPORT_RETRY_MS
  let attempt = 0
  let delay = 300
  while (Date.now() < deadline) {
    attempt += 1
    if (await pushWake(getService, log, sessionId, text, attempt, label, 本次回投id)) return true
    log(
      `投递未成功【${label}】target=${sessionId} 第 ${attempt} 次尝试失败，${Math.round(delay)}ms 后重试`,
    )
    await sleep(delay)
    delay = Math.min(2000, delay * 2)
  }
  log(
    `${label}失败：${REPORT_RETRY_MS / 1000} 秒内没能把结果投给会话 ${sessionId}；` +
      '这次失败的完整原因仍可在 plugin.log 与界面卡片里看到',
  )
  return false
}

/**
 * 这个阻塞项是不是「发起重启的那个会话自己」。
 *
 * 只有 agent / queued / schedule 这三类带 sessionId 的才算；job 的 id 是任务 id、
 * 归属不清，一律按「别人」处理（宁可不给收尾窗口，也不要把后台任务当成自己）。
 */
/**
 * 「这个阻塞项是不是某个正在等待的会话」。
 *
 * 等待者自己几乎总是还在 running（调用完工具后还要把这一轮说完），
 * 但它属于队列，不算「别人还没到」。只有队列外的阻塞项才真的挡着重启。
 */
function isWaiterBlocker(blocker, 等待者id) {
  if (!blocker || !blocker.id) return true // 没有 id 的（如服务不可用）一律算别人
  if (!(blocker.kind === 'agent' || blocker.kind === 'queued' || blocker.kind === 'schedule')) {
    return true // job 等一律算别人
  }
  return !等待者id.has(blocker.id)
}

/**
 * 把「非意向会话」分成两档：硬拦 vs 软拦。
 *
 * - 硬拦：后台 job、定时提醒、刚起不久的会话 —— 打断的代价不可控，或者无法自愈；
 * - 软拦：跑了一阵的普通会话 —— 允许打断，理由是 interrupted-resume 会在重启后
 *   注入「先核对状态再继续」的指令，能接上；代价是它要花一轮核对。
 *
 * 软拦不阻挡重启，只记日志、并在界面提示「有 N 个无关会话在跑」。
 */
function classifyStrangers(blockers, 等待者id, 本轮起点, now = Date.now(), 本轮结束 = new Map()) {
  const 硬拦 = []
  const 软拦 = []
  for (const b of blockers) {
    if (!b) continue
    const id = String(b.id ?? '')
    // 队列里的自己人：不算陌生人。
    if (id && 等待者id.has(id)) continue

    // 没有 id 的（服务不可用等）：无法确认，硬拦。
    if (!id) {
      硬拦.push(b)
      continue
    }
    // job 永远硬拦：它的 id 是任务 id，归属不清，且不会自愈。
    if (b.kind === 'job' || b.kind === 'queued' || b.kind === 'schedule') {
      硬拦.push(b)
      continue
    }
    // agent：**只在「这一轮确实结束了」时才允许软拦放行**。
    //
    // 为什么不能拿「跑了多久」当判据（上一版的做法，已推翻）：
    // 2026-11-09 10:21 实测放行一个已跑 5 分钟的会话，它被打断后
    // resume.log 显示 `0 resumed` —— 用户看到「引擎重启过，本轮已中断」，
    // 只能手动点继续。跑了多久跟「能不能安全打断」没有因果关系。
    //
    // 正确判据是「它的 turn 有没有结束」：只有观测到这一轮的 turn/end，
    // 才说明它此刻不在半路（可能在收尾，不会再写文件），杀掉才不丢工作。
    // 这和 `status === 'idle'` 等价 —— 只是 blockers 里根本收不到 idle 条目
    // （collectBlockers 只在 running 时才记 kind:'agent'），所以只能靠事件确认。
    if (b.kind === 'agent') {
      const startedAt = 本轮起点.get(id) ?? 0
      const endedAt = 本轮结束.get(id) ?? 0
      const 这一轮已结束 = endedAt > 0 && endedAt >= startedAt
      if (这一轮已结束) {
        软拦.push(b)
      } else {
        硬拦.push(b)
      }
      continue
    }
    硬拦.push(b)
  }
  return { 硬拦, 软拦 }
}

function isSelfBlocker(blocker, sessionId) {
  if (!sessionId) return false
  if (!blocker || blocker.id !== sessionId) return false
  return blocker.kind === 'agent' || blocker.kind === 'queued' || blocker.kind === 'schedule'
}

function createLogger(options = {}) {
  let file = ''
  const keep = () => {
    const value = typeof options.keep === 'function' ? Number(options.keep()) : DEFAULT_LOG_KEEP
    if (!Number.isFinite(value)) return DEFAULT_LOG_KEEP
    return Math.max(MIN_LOG_KEEP, Math.min(MAX_LOG_KEEP, Math.trunc(value)))
  }
  /** 只留最近 N 个流程日志（文件名里的 stamp 是可按字典序排的）。 */
  const prune = () => {
    try {
      const names = readdirSync(LOG_DIR)
        .filter((name) => name.startsWith('restart-') && name.endsWith('.log'))
        .sort()
      const extra = names.length - keep()
      for (let i = 0; i < extra; i += 1) {
        try {
          unlinkSync(join(LOG_DIR, names[i]))
        } catch {
          // 删不掉就留着，不影响这次流程
        }
      }
    } catch {
      // 目录还不存在时无需清理
    }
  }
  const write = (to, text) => {
    try {
      mkdirSync(LOG_DIR, { recursive: true })
      if (!file) file = join(LOG_DIR, `restart-${stamp()}.log`)
      appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`, 'utf8')
    } catch {
      // 日志失败绝不能让插件挂掉
    }
    void to
  }
  return {
    /** 开始一次新流程 = 换一个新文件（顺手清掉超出保留份数的旧文件） */
    begin() {
      prune()
      file = join(LOG_DIR, `restart-${stamp()}.log`)
      return file
    },
    line(text) {
      write('log', text)
    },
    file() {
      return file
    },
  }
}

function jsonResponse(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  } catch {
    // 连接已经断了就算了
  }
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 有长度上限：这个接口只服务设置页（几个标量字段），正常请求不过几百字节。
 * 原来会把请求体全量攒进内存，本机任意进程都能 POST 一个超大 body 把宿主堆打满。
 * 门禁（回环地址 + 自定义头 + 同源）挡住了外部网页，但挡不住本机进程。
 *
 * 超限时直接销毁连接并返回空对象 —— 交给调用方按「没给参数」处理，
 * 而不是让一个畸形请求把进程拖垮。
 */
const MAX_JSON_BODY_BYTES = 64 * 1024

async function readJsonBody(req, 上限 = MAX_JSON_BODY_BYTES) {
  if (typeof req[Symbol.asyncIterator] !== 'function') return {}
  const chunks = []
  let 已收字节 = 0
  for await (const chunk of req) {
    已收字节 += chunk.length
    if (已收字节 > 上限) {
      // 主动断开，不要继续读 —— 继续读等于帮对方把内存吃满。
      try {
        req.destroy()
      } catch {
        /* 已经断了 */
      }
      return {}
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 单个日志文件的上限。超过就滚成 `.1`（只留一份历史）。
 *
 * 为什么需要：`prune()` 只清 `restart-*.log`（每次重启一个文件，按数量留最近
 * N 个），而 `plugin.log` / `plugin-load.log` 是**同一个文件跨重启一直追加**的
 * 常驻日志。这个插件每次重启前会写好十几行，再加上每次 apply 都写 `trace`，
 * 两个文件只增不减，没有任何上限。这是磁盘增长，不是堆增长，但同属"无界"。
 */
const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024

/** 追加一行；文件超过上限就先滚成 `.1` 再写。失败一律忽略。 */
export function appendLogLine(file, line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    try {
      if (statSync(file).size > LOG_FILE_MAX_BYTES) {
        // renameSync 在目标已存在时会覆盖（Windows 上会抛，所以先删）。
        try {
          rmSync(`${file}.1`, { force: true })
        } catch {
          /* 删不掉就让下面的 rename 自己失败 */
        }
        try {
          renameSync(file, `${file}.1`)
        } catch {
          // 滚不动就直接清空，总比无限增长好
          rmSync(file, { force: true })
        }
      }
    } catch {
      // statSync 失败通常表示文件还不存在 —— 正常
    }
    appendFileSync(file, line, 'utf8')
  } catch {
    // 写不进去不影响插件
  }
}

export function apply(ctx, config = {}) {
  // 加载痕迹：热重载时最容易出问题的地方就是这里“悄悄没跑”，
  // 所以每一步都往 plugin-load.log 里落一行。写不进去也不影响插件。
  const trace = (text) => {
    appendLogLine(join(LOG_DIR, 'plugin-load.log'), `[${new Date().toISOString()}] ${text}\n`)
  }

  trace(`apply 开始 pid=${process.pid}`)

  const log = (message) => {
    const line = `[${name}] ${message}`
    try {
      ctx.logger?.info?.(line)
    } catch {
      // ignore
    }
    try {
      console.log(line)
    } catch {
      // ignore
    }
    // 再落地一份：宿主控制台在重启、崩溃之后就没了，文件还能查。
    appendLogLine(join(LOG_DIR, 'plugin.log'), `[${new Date().toISOString()}] ${message}\n`)
  }

  const scriptPath =
    typeof config.scriptPath === 'string' && config.scriptPath.trim().length > 0
      ? config.scriptPath.trim()
      : DEFAULT_SCRIPT

  /**
   * 拉起脚本的方式。默认就是真的 spawn powershell；**只给离线测试替换**。
   *
   * 为什么留这个口子：状态机里「到点判闲 → 拉脚本」这一段是必须被测的，
   * 但它一旦真跑起来就是去关整台 应用。没有注入点，测试要么不覆盖这一段，
   * 要么就得在测试进程里祈祷脚本自己拒绝 —— 后者已经真的发生过一次
   * （2026-11-08：测试意外拉起 Restart-应用.ps1，靠脚本的 no-plan 校验才没关机）。
   */
  const launch = typeof config.launchScript === 'function' ? config.launchScript : launchScript

  const state = createState()

  /**
   * 设置页存的「默认值」。**落盘**在 `SETTINGS_FILE`，启动时读回，
   * 缺字段或读坏一律用代码默认值兜底（见 `readSettingsFile`）。每次调用仍以工具参数为准。
   *
   * 刻意**没有** `command`：命令只能由调用方当次传入，不能有「默认命令」。
   * 一条留在设置页里的命令，在最坏的情况下会在某次纯重启时被悄悄执行，
   * 而没人记得自己设过它。工具里也没有回退到这里的逻辑。
   */
  const settings = loadSettings()

  /**
   * 只读的「现状」：设置页要显示的不只是可编辑的默认值，还有它到底在用
   * 哪个脚本、把日志写到哪、交接文件叫什么。这些不给改，只用来对照。
   */
  const settingsMeta = () => ({
    wakeModes: [
      { value: 'plugin', label: '插件直投（推荐）', hint: 'Host 直接往会话发，不碰页面，不用等渲染' },
      { value: 'script', label: '脚本页面输入（退路）', hint: 'CDP 往输入框打字，要先等 12 秒渲染' },
    ],
    scriptPath,
    stateDir: STATE_DIR,
    logDir: LOG_DIR,
    logs: {
      plugin: join(LOG_DIR, 'plugin.log'),
      run: join(LOG_DIR, 'restart-*.log'),
    },
    files: {
      wakeRequest: WAKE_REQUEST_FILE,
      lastRun: RUN_RESULT_FILE,
      plan: PLAN_FILE,
      settings: SETTINGS_FILE,
    },
    limits: {
      countdownSec: [MIN_COUNTDOWN, MAX_COUNTDOWN],
      timeoutSec: [MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC],
      logKeep: [MIN_LOG_KEEP, MAX_LOG_KEEP],
    },
    defaults: {
      autoSay: DEFAULT_AUTOSAY,
      timeoutSec: DEFAULT_TIMEOUT_SEC,
      countdownSec: DEFAULT_COUNTDOWN,
      logKeep: DEFAULT_LOG_KEEP,
      wakeMode: DEFAULT_WAKE_MODE,
      launchCommand: '',
      allowAutoRestart: true,
    },
  })

  /** 把一次 POST 的载荷校验后并进 settings，返回本次实际改动的项。 */
  const applySettings = (payload) => {
    const p = payload && typeof payload === 'object' ? payload : {}
    const changed = []
    if (typeof p.autoSay === 'string') {
      const text = p.autoSay.trim().slice(0, 200)
      settings.autoSay = text.length > 0 ? text : DEFAULT_AUTOSAY
      changed.push('autoSay')
    }
    if (p.timeoutSec !== undefined) {
      settings.timeoutSec = clampInt(p.timeoutSec, MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC)
      changed.push('timeoutSec')
    }
    if (p.countdownSec !== undefined) {
      settings.countdownSec = clampInt(p.countdownSec, MIN_COUNTDOWN, MAX_COUNTDOWN, DEFAULT_COUNTDOWN)
      changed.push('countdownSec')
    }
    if (p.logKeep !== undefined) {
      settings.logKeep = clampInt(p.logKeep, MIN_LOG_KEEP, MAX_LOG_KEEP, DEFAULT_LOG_KEEP)
      changed.push('logKeep')
    }
    if (p.wakeMode === 'plugin' || p.wakeMode === 'script') {
      settings.wakeMode = p.wakeMode
      changed.push('wakeMode')
    }
    if (typeof p.launchCommand === 'string') {
      // 空串也接受：那是「清掉覆盖、回到自动」的合法写法。
      settings.launchCommand = p.launchCommand.trim().slice(0, 2000)
      changed.push('launchCommand')
    }
    if (p.allowAutoRestart === false || p.allowAutoRestart === true) {
      settings.allowAutoRestart = p.allowAutoRestart
      changed.push('allowAutoRestart')
    }
    // 内存里先生效，再落盘：写盘失败只是"下次重启会丢"，不该让这次保存看起来没成功。
    if (changed.length > 0 && !writeSettingsFile(settings)) {
      logger.line(`设置写盘失败（${SETTINGS_FILE}），本次仍按新值工作，但下次启动会回落到文件里的旧值`)
    }
    return changed
  }

  const logger = createLogger({ keep: () => settings.logKeep })
  /**
   * 取消来源：'' | 'input'（前端检测到键鼠）| 'api'（直接调接口）
   * | 'abort'（发起会话的回合被打断）
   */
  let cancelSource = ''

  const setState = (patch) => {
    Object.assign(state, patch)
    // 只要离开 counting，「等页面起表」这件事就作废，别让残留标志把下一次重启卡在
    // 「永远等页面」。正常情况下 beginFromViewer 会先把它清掉。
    if (patch && patch.phase && patch.phase !== 'counting') awaitingViewer = false
  }

  const getService = (key) => {
    try {
      return ctx.get(key)
    } catch {
      return undefined
    }
  }

  const services = {
    get agents() {
      return getService('agents')
    },
    get jobs() {
      return getService('jobs')
    },
    // 脚本重启网页端时要绑回同一个端口：cookie 和页面地址都绑在 host:port 上，
    // 换端口等于把已经开着的页面全废掉。
    get webServer() {
      return getService('webServer')
    },
    /**
     * 某个会话上「还挂着什么」（定时提醒走这条瀑布）。
     *
     * 宿主自己的退出检查就是这么问的（dsh-desktop-host 的 quit-inspection），
     * 查不到就当没有：宁可漏一条提醒，也不要因为瀑布没就绪把重启永久卡死。
     */
    async sessionActivity(sessionId) {
      try {
        if (typeof ctx.waterfall !== 'function') return []
        const rows = await ctx.waterfall(
          'workspace/session-activity',
          { sessionId },
          () => Promise.resolve([]),
        )
        return Array.isArray(rows) ? rows : []
      } catch {
        return []
      }
    },
  }

  /**
   * 会话显示名缓存：sessionId → { title, at }。
   *
   * 为什么需要：界面上把 `session-ff55a53b-…` 这种 id 直接摆出来没人看得懂。
   * 用户想看的是会话标题（比如「重启应用验证」）。
   *
   * 标题来自 `ctx.get('sessionTitle').get(session)`，它需要一个**活的 session 对象**，
   * 所以先 `ctx.sessions.get(id)`。取不到就退回「会话名短 id」。
   *
   * 缓存 30 秒：标题可能被用户改名，但没必要每次都读日志折叠。
   */
  /**
   * 等清单进入 ready。
   *
   * 脚本写 ready 表示「应用真起来了」。此前投递只会白等 ——
   * sessionController 那时还没注册好。
   *
   * @param {string} runId - 本轮运行的 id，用于确认读到的是自己的清单
   * @param {() => boolean} [还活着] - 每轮检查一次；返回 false 立即放弃。
   *   插件卸载后这个循环原本会继续跑满 120 秒，一来让进程迟迟退不掉，
   *   二来可能朝已经销毁的 ctx 投递消息。调用方传 `() => !stopped`。
   */
  const 等清单就绪 = async (runId, 还活着 = () => true) => {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      // 卸载即退出，不要把这个循环跑满超时。
      if (!还活着()) return null
      const { roster } = readRoster(STATE_DIR)
      if (!roster) return null
      if (roster.runId && runId && roster.runId !== runId) {
        logger.line(`清单 runId 不匹配（${roster.runId} ≠ ${runId}），放弃本轮投递`)
        return null
      }
      // 「应用起来了」这个信号由脚本写进 wake-request.json（它只会写它认识的字段）。
      const signal = readWakeRequest()
      if (signal && signal.runId === roster.runId) {
        if (signal.phase === 'failed') {
          logger.line(`重启失败（${signal.error || '原因未知'}），不投递`)
          clearRoster(STATE_DIR)
          clearWakeRequest()
          return null
        }
        if (signal.phase === 'ready') {
          roster.phase = 'ready'
          roster.startedAt = signal.startedAt || Date.now()
          writeRoster(STATE_DIR, roster)
          return roster
        }
      }
      await new Promise((r) => {
        const t = setTimeout(r, 500)
        // 别让这个等待独自撑住进程退出。
        if (typeof t.unref === 'function') t.unref()
      })
    }
    return null
  }

  /**
   * 当前活着的会话 id 列表（用于登记 bystander）。
   *
   * 只登记能确认「正在跑」的：拿不到的就不登记，由全量扫描兜底。
   * 宁可漏一个 bystander（扫描会补），也不要在清单里放一条幂等键不完整的记录。
   */
  const 活跃会话快照 = () => {
    const out = []
    try {
      const agents = getService('agents')
      for (const agent of safeList(agents)) {
        const id = String(agent?.id ?? '')
        if (!id) continue
        let status = 'running'
        try {
          status = agent.status
        } catch {
          status = 'running'
        }
        if (status === 'running') out.push(id)
      }
    } catch {
      // 拿不到就当没有
    }
    return out
  }

  const 标题缓存 = new Map()
  const 标题TTL_MS = 30_000
  /**
   * 上限。这个缓存的 key 是 sessionId，而每次 `snapshot()`（客户端每 300 ms～
   * 5 s 拉一次 `/state`）都会为当前阻塞项（最多 8 个）和发起会话各查一次标题。
   * 子代理每个都是独立 sessionId，所以 key 只增不减；TTL 只决定"读的时候算不算
   * 命中"，不会把别的 key 删掉。加一条硬上限，按插入顺序丢最老的。
   */
  const 标题缓存上限 = 200
  const 收标题 = (id, title) => {
    标题缓存.set(id, { title, at: Date.now() })
    if (标题缓存.size <= 标题缓存上限) return
    // 先清已经过期的，通常这一步就够了
    const 过期线 = Date.now() - 标题TTL_MS
    for (const [k, v] of 标题缓存) {
      if (v.at < 过期线) 标题缓存.delete(k)
    }
    // 还是超就按插入顺序丢最老的（Map 的迭代顺序即插入顺序）
    while (标题缓存.size > 标题缓存上限) {
      标题缓存.delete(标题缓存.keys().next().value)
    }
  }
  const 会话标题 = (sessionId) => {
    const id = String(sessionId || '')
    if (!id) return ''
    const 缓存 = 标题缓存.get(id)
    if (缓存 && Date.now() - 缓存.at < 标题TTL_MS) return 缓存.title
    let title = ''
    try {
      const sessions = getService('sessions')
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(id) : undefined
      const titles = getService('sessionTitle')
      if (session && titles && typeof titles.get === 'function') {
        const snap = titles.get(session)
        // get 返回 { text, source }；只取非空文本
        if (snap && typeof snap.text === 'string' && snap.text.trim()) title = snap.text.trim()
      }
    } catch {
      title = ''
    }
    收标题(id, title)
    return title
  }

  /** 给阻塞项补上可读名字（给界面用）。 */
  const 命名阻塞项 = (list) =>
    (Array.isArray(list) ? list : []).map((b) => ({
      kind: String(b?.kind ?? ''),
      id: String(b?.id ?? ''),
      label: String(b?.label ?? ''),
      name: b?.id ? 会话标题(b.id) || '' : '',
    }))

  /**
   * 宿主的自我描述，每次用都现读。
   *
   * 不缓存的原因：端口可能被桌面壳换掉、profile 可能被 rescue 换过、
   * 进程 cwd 也可能在会话里被切走。缓存一份等于拿旧事实去杀进程。
   */
  const hostFacts = () => readHostFacts(services.webServer)

  const snapshot = () => ({
    phase: state.phase,
    deadline: state.deadline,
    // 页面据此判断「表还没起」：此时显示完整秒数、不跳动，等 Host 定死 deadline 再走。
    awaitingViewer,
    countdownSec: state.countdownSec,
    cancelReason: state.cancelReason,
    command: state.command,
    autoSay: state.autoSay,
    blockerCount: state.blockers.length,
    /** 方案 3：有多少「无关会话」在跑但被允许打断（界面据此提示风险）。 */
    strangerCount: state.strangerCount || 0,
    /** 发起这次重启的会话（界面用来显示「谁在等」）。 */
    sessionId: state.sessionId || '',
    /** 发起者的可读名字（标题取不到时为空，界面自行退回短 id）。 */
    sessionName: state.sessionId ? 会话标题(state.sessionId) || '' : '',
    blockers: 命名阻塞项(state.blockers.slice(0, 8)),
    last: state.last,
    message: state.message || '',
    now: Date.now(),
    // 调试用：确认宿主把端口交出来了（网页端重启要绑回这个值）
    port: services.webServer?.port ?? 0,
  })

  /**
   * 后台倒计时句柄。
   *
   * 为什么不用 await 把工具挂住：工具没返回时，调用它的那一轮 agent 永远是
   * running。而规则是「倒计时结束时除了插件自己，谁在跑都不重启」——
   * 挂住就等于永远把自己判成忙，一次也重启不了。所以工具立刻返回，
   * 秒数由插件在后台走，走完再判。
   *
   * 副作用是好的：这几十秒里 agent 可以继续把这一轮说完。
   */
  let countdownTimer = null
  /** 已排队、等倒计时走完的那一次重启。 */
  let pendingRestart = null
  /**
   * 「想一起重启」的会话队列。
   *
   * 多会话同时开发时，几个会话可能前后脚都想要重启。旧行为是只有最后一个能成，
   * 前面的全部作废（木桶效应）。现在它们都进这个队列，人齐后一次性重启，
   * 重启完成后逐个唤醒。
   *
   * 每项：{ sessionId, autoSay, note, joinedAt }
   */
  const waiters = []
  /**
   * 兜底扫描的句柄（事件驱动的补充，不是主判据 —— 见 GATHER_SWEEP_MS）。
   */
  let gatherTimer = null
  /**
   * 「立刻重判一次」的防抖句柄。
   *
   * 事件可能成批到达（一次 turn/end 之后紧跟 agent/status），没必要每次都
   * 完整扫一遍全机；合并到同一拍里只判一次。
   */
  let gatherKick = null
  /** 等人齐的起始时刻（0 = 没在等）。 */
  let gatherSince = 0
  /**
   * 各会话「这一轮是什么时候开始的」，用于区分「刚起不久」和「跑了一阵」。
   *
   * 数据来源是会话日志里的 `turn/start` 事件（它带 `time` 毫秒时间戳），
   * 由下方 session/event 监听持续更新。取不到时按「刚起」保守处理。
   */
  const 本轮起点 = new Map()
  /**
   * 各会话「这一轮是什么时候结束的」（turn/end 的 time）。
   * 方案 3 用它判断「能不能安全打断」—— 只有这一轮已经结束的会话才允许放行。
   */
  const 本轮结束 = new Map()
  /**
   * 两个轮次表的上限与裁剪。
   *
   * 每收到一条 `turn/start` / `turn/end` 就会 `set` 一条，而 key 是 sessionId
   * —— 每个子代理都是独立 id，所以长时间开着的进程会稳定累积。这两张表只服务
   * 于 `waiting` 阶段的判定，历史条目没有价值，直接按插入顺序淘汰最老的即可。
   *
   * 注意：**不能**在 turn/end 里直接删 `本轮起点`。`classifyStrangers` 依赖
   * 「结束时刻 >= 开始时刻」的成对比较，拆掉一半会让那个判断失去依据。
   * 这里只在终点表超过上限时淘汰「连起点都早已不在」的 key。
   */
  const 轮次表上限 = 500
  const 裁剪轮次表 = () => {
    if (本轮结束.size <= 轮次表上限) return
    for (const 老id of 本轮结束.keys()) {
      if (本轮结束.size <= 轮次表上限) break
      if (!本轮起点.has(老id)) 本轮结束.delete(老id)
    }
    // 起点表同样封顶；它比终点表保留得久一点没有坏处，但不能无界。
    if (本轮起点.size > 轮次表上限) {
      for (const 老id of 本轮起点.keys()) {
        if (本轮起点.size <= 轮次表上限) break
        本轮起点.delete(老id)
      }
    }
  }
  /**
   * 倒计时是否还没起表（等页面把自己画出来）。
   *
   * 起表前 deadline 是 0，页面显示的是完整的设置秒数、且不跳动；
   * 页面第一次来读状态（或主动报到）时才把 deadline 定死，从那以后才开始倒数。
   */
  let awaitingViewer = false
  /** 进入「等页面」状态的时刻，用于兜底超时。 */
  let viewerArmedAt = 0
  /**
   * 倒计时真正起表的时刻（0 = 还没起表）。
   *
   * 方案 B 用它判断「最短保护期是否已过」：事件满足条件时，还要确认距起表
   * 已超过本轮保护期（earlyGoGraceFor，最多 5 秒），否则等于没有取消窗口。
   */
  let countdownStartedAt = 0
  /**
   * 收尾窗口是否已经用过。
   *
   * 只给一次：这一轮用完就作废，不再等第二次，否则「什么时候动手」就变成
   * 由回合长度决定的了。
   */
  let settleUsed = false

  const stopCountdown = () => {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
    if (gatherTimer !== null) {
      clearTimeout(gatherTimer)
      gatherTimer = null
    }
    if (gatherKick !== null) {
      clearTimeout(gatherKick)
      gatherKick = null
    }
    if (settleKick !== null) {
      clearTimeout(settleKick)
      settleKick = null
    }
    if (earlyKick !== null) {
      clearTimeout(earlyKick)
      earlyKick = null
    }
    gatherSince = 0
  }

  /**
   * 收尾窗口：只有发起会话自己还在跑时，等它把这一轮说完再动手。
   *
   * 复用同一个 ticker（startCountdown 的 tick 同时管 counting 与 settling），
   * 这样键鼠取消在 200ms 内就生效，而不是等到窗口结束才发现有人动过。
   */
  const waitForSelfToFinish = (pending, blockersAtEnd) => {
    const { sessionId } = pending
    settleUsed = true
    pendingRestart = pending
    setState({
      phase: 'settling',
      deadline: Date.now() + SELF_SETTLE_MS,
      countdownSec: Math.round(SELF_SETTLE_MS / 1000),
      cancelReason: '',
      blockers: blockersAtEnd,
      message:
        `倒计时走完时只有发起这次重启的会话自己还在收尾，正在等它把这一轮说完` +
        `（最多 ${Math.round(SELF_SETTLE_MS / 1000)} 秒），说完就动手。`,
    })
    logger.line(
      `倒计时结束时唯一的阻塞项是发起会话自己（${sessionId}），进入 ${Math.round(
        SELF_SETTLE_MS / 1000,
      )} 秒收尾窗口`,
    )
    startCountdown()
  }

  /**
   * 进入「等人齐」：还有别的会话在忙，但不作废，等全空了一起重启。
   *
   * 为什么这次不再直接作废：多会话同时开发时，A 请求重启时 B 往往还在写文件。
   * 旧的「有人忙就放弃」会让 A 永远重启不了，只有最后一个说完话的会话才可能成功
   * —— 谁先请求谁吃亏。既然这些会话的目标其实一致（都想让改动生效），
   * 就把它们当成一个同步点：全部到齐后重启一次，再逐个唤醒。
   *
   * 注意：**不主动给挡路的会话发消息**。发消息会往它 inbox 塞一条排队消息，
   * 而「inbox 非空」本身就是阻塞项，等于越催越忙（2026-11-09 实测确认）。
   * 所以这里只观察、不打扰。
   */
  const startGather = (pending, blockersAtEnd) => {
    const describe = (list) =>
      list.map((b) => `${b.label}${b.id ? `（${b.id}）` : ''}`).join(' / ')

    // 发起者进入等待队列（若已在队列里则更新它的唤醒词）。
    upsertWaiter(pending)
    // ⚠ 只在**首次**进入等待时记起点。回炉（人齐快照失效后重新等待）绝不能重置，
    // 否则会出现「快照失效 → 重新计时 → 又失效 → 又重计时」的死循环，
    // 10 分钟上限永远到不了（2026-11-09 实测：测试挂死）。
    if (gatherSince === 0) gatherSince = Date.now()
    setState({
      phase: 'waiting',
      deadline: 0,
      countdownSec: 0,
      cancelReason: '',
      blockers: blockersAtEnd,
      message:
        `还有 ${blockersAtEnd.length} 处在忙（${describe(blockersAtEnd)}），` +
        `等它们跑完就一起重启；目前有 ${waiters.length} 个会话在等。` +
        `最多等 ${Math.round(GATHER_MAX_MS / 60000)} 分钟。`,
    })
    logger.line(
      `进入等人齐：${blockersAtEnd.length} 处忙（${describe(blockersAtEnd)}），` +
        `队列 ${waiters.length} 人，上限 ${Math.round(GATHER_MAX_MS / 60000)} 分钟`,
    )
    // 延后一拍再起轮询：此刻可能还在上一次 gatherTick 的同步调用链里，
    // 立刻调用会被重入锁挡掉，轮询链就断了。
    clearTimeout(gatherTimer)
    gatherTimer = setTimeout(() => {
      gatherTimer = null
      void gatherTick()
    }, 0)
    if (typeof gatherTimer.unref === 'function') gatherTimer.unref()
  }

  /** 把一条「想重启」的请求放进队列（同一个会话只保留一条）。 */
  const upsertWaiter = (pending) => {
    const sessionId = pending.sessionId
    if (!sessionId) return
    const existing = waiters.find((w) => w.sessionId === sessionId)
    if (existing) {
      if (pending.autoSay) existing.autoSay = pending.autoSay
      if (pending.command) existing.command = pending.command
      if (pending.timeoutSec !== undefined) existing.timeoutSec = pending.timeoutSec
      if (pending.wakeMode) existing.wakeMode = pending.wakeMode
      return
    }
    waiters.push({
      sessionId,
      autoSay: pending.autoSay || '',
      // 发起者的原始参数也要留着：动手时用的是「第一个人」的配置，
      // 只存唤醒词会让 command / timeoutSec / wakeMode 全被设置页默认值替代。
      command: pending.command || '',
      timeoutSec: pending.timeoutSec,
      wakeMode: pending.wakeMode,
      joinedAt: Date.now(),
    })
  }

  /**
   * 事件驱动的「立刻重判一次」。
   *
   * 什么时候调：`turn/end`（某会话跑完）或 `agent/status`（忙闲变化）。
   * 这是等人齐的**主判据** —— 既然有明确事件告诉「有人跑完了」，
   * 就没有理由每 1.5 秒去轮询猜一次。
   *
   * 防抖 200ms：一次 turn 结束往往连着好几个事件（turn/end + agent/status +
   * inbox 变化），合并成一次判定就够了。
   */
  /**
   * `settling` 阶段的「这一轮说完了」→ 立刻进动手，不必等满 30 秒。
   *
   * 为什么必须有它：2026-11-09 实测，倒计时起表后 5 秒就收到 turn/end(completed)，
   * 但流程仍等到 30 秒收尾窗口到点才动手 —— 端到端 93 秒里有 55 秒是纯白等。
   * 收尾窗口的本意是「等这一轮说完」，既然已经说完，就没有理由再等。
   *
   * 30 秒只剩兜底作用：turn/end 丢事件、或会话卡住不结束时才吃满。
   */
  let settleKick = null
  const kickSettle = () => {
    if (state.phase !== 'settling') return
    if (settleKick !== null) return
    settleKick = setTimeout(() => {
      settleKick = null
      if (state.phase !== 'settling') return
      logger.line('收尾窗口：发起会话已结束这一轮，立刻动手（不必等满 30 秒）')
      stopCountdown()
      void finishCountdown({ fromSettle: true })
    }, 200)
    if (typeof settleKick.unref === 'function') settleKick.unref()
  }

  /**
   * 方案 B：倒计时期间，若「发起会话已说完 + 全机空闲 + 保护期已过」→ 提前动手。
   *
   * 由 turn/end 事件触发（debounce 200ms），每次都要重新查一次空闲，
   * 因为「这一轮说完」不等于「机器闲了」：可能还有别的会话在跑。
   */
  let earlyKick = null
  const maybeGoEarly = () => {
    if (state.phase !== 'counting') return
    if (awaitingViewer) return
    if (cancelSource) return
    if (earlyKick !== null) return
    earlyKick = setTimeout(() => {
      earlyKick = null
      void (async () => {
        if (state.phase !== 'counting' || awaitingViewer || cancelSource) return
        // 保护期：人得来得及取消。
        const 保护期 = earlyGoGraceFor(state.countdownSec)
        if (countdownStartedAt > 0 && Date.now() - countdownStartedAt < 保护期) {
          // 还没过保护期 → 等会儿再复查一次（不靠倒计时，仍由事件后自查）
          const 还差 = 保护期 - (Date.now() - countdownStartedAt)
          earlyKick = setTimeout(() => {
            earlyKick = null
            maybeGoEarly()
          }, Math.max(200, 还差))
          if (typeof earlyKick.unref === 'function') earlyKick.unref()
          return
        }
        const blockers = await collectBlockers(services)
        if (state.phase !== 'counting') return

        // 诊断行：把此刻的阻塞项全打出来。方案 B 在真机上不触发时，
        // 光看「有没有提前收工」分不清是「自己被算成忙」还是「别人在挡」。
        logger.line(
          `方案B 判定：blockers=${blockers.length}` +
            (blockers.length > 0
              ? ' [' + blockers.map((b) => `${b.kind}:${b.id || '-'}`).join(', ') + ']'
              : '') +
            ` 发起会话=${state.sessionId}`,
        )

        if (blockers.length > 0) {
          logger.line(
            `倒计时未走完，但发起会话已结束且仍有 ${blockers.length} 处忙，继续等倒计时：` +
              blockers.map((b) => `${b.label}${b.id ? `（${b.id}）` : ''}`).join(' / '),
          )
          return
        }
        logger.line('倒计时提前收工：发起会话已结束、全机空闲、保护期已过，立刻动手')
        stopCountdown()
        void finishCountdown()
      })()
    }, 200)
    if (typeof earlyKick.unref === 'function') earlyKick.unref()
  }

  const kickGather = (原因) => {
    if (state.phase !== 'waiting') return
    if (gatherKick !== null) return
    gatherKick = setTimeout(() => {
      gatherKick = null
      void gatherTick()
    }, 200)
    if (typeof gatherKick.unref === 'function') gatherKick.unref()
    // 只在第一次踢时记一行，避免日志被刷爆
  }

  /**
   * 等人齐期间的轮询：全空就动手，超时就如实报告。
   *
   * 重入保护是必须的：`startGather` 会 `void gatherTick()`，而 `gatherTick`
   * 触发 `launchAfterGather` 后，一旦人齐快照失效又会走回 `startGather`。
   * 没有这道锁时，这条链在 mock 计时器下会被同步展开成无限递归
   * （2026-11-09 实测：tick 一次就卡死，连循环的下一次迭代都到不了）。
   */
  let gathering = false
  const gatherTick = async () => {
    if (gathering) return
    if (state.phase !== 'waiting') return
    if (cancelSource) {
      cancelCountdown(cancelSource)
      return
    }
    if (gatherSince > 0 && Date.now() - gatherSince >= GATHER_MAX_MS) {
      const 还在忙 = state.blockers
      logger.line('等人齐超时，放弃重启')
      setState({
        phase: 'blocked',
        blockers: 还在忙,
        deadline: 0,
        countdownSec: 0,
        cancelReason: '',
        last: { at: Date.now(), ok: false, reason: 'gather-timeout' },
        message: `等了 ${Math.round(GATHER_MAX_MS / 60000)} 分钟还没等到全部空闲，这次重启作废。`,
      })
      const 名单 = waiters.splice(0, waiters.length)
      for (const w of 名单) {
        await reportFailure(
          w.sessionId,
          'busy',
          `等待 ${Math.round(GATHER_MAX_MS / 60000)} 分钟后仍有 ${还在忙.length} 处在忙：
` +
            还在忙.map((b) => `- ${b.label}${b.id ? `（${b.id}）` : ''}`).join('\n'),
        )
      }
      return
    }

    gathering = true
    try {
      const blockers = await collectBlockers(services)
      // 等的人自己也常常还在 running（它调用完工具还要把这一轮说完）。
      // 这里用「除等待者之外是否还有别的阻塞项」作为判据：等待者自己算「已到齐」。
      const 等待者id = new Set(waiters.map((w) => w.sessionId))
      const { 硬拦, 软拦 } = classifyStrangers(
        blockers,
        等待者id,
        本轮起点,
        Date.now(),
        本轮结束,
      )

      if (硬拦.length === 0) {
        // 硬拦为空就动手。软拦（跑了一阵的无关会话）不挡路：
        // 打断它是有代价的，但 interrupted-resume 会在重启后注入
        // 「先核对状态再继续」的指令，能接上；而继续等它会变成木桶效应。
        if (软拦.length > 0) {
          logger.line(
            `等人齐完成：队列 ${waiters.length} 人；` +
              `另有 ${软拦.length} 个无关会话在跑（已跑过 ${Math.round(
                FRESH_AGENT_MS / 60000,
              )} 分钟），按方案 3 不阻挡：${软拦
                .map((b) => `${b.label}${b.id ? `（${b.id}）` : ''}`)
                .join(' / ')}`,
          )
        } else {
          logger.line(`等人齐完成：队列 ${waiters.length} 人，全部空闲，开始重启`)
        }
        await launchAfterGather(软拦)
        return
      }

      setState({ blockers: blockers, strangerCount: 软拦.length })
      gatherTimer = setTimeout(() => {
        gatherTimer = null
        void gatherTick()
      }, GATHER_SWEEP_MS)
      if (typeof gatherTimer.unref === 'function') gatherTimer.unref()
    } finally {
      // 只在下一次轮询已经排上、或已经离开 waiting 时解锁。
      // 不能在 launchAfterGather 回炉的过程中解锁 —— 那条回炉路径要能重新起轮询，
      // 否则「快照失效 → 回到等待 → 再没人推进」会永久挂住（2026-11-09 实测）。
      gathering = false
    }
  }

  /** 人齐了：用队列里第一个人的参数动手，其他人只等着被唤醒。 */
  const launchAfterGather = async (软拦 = []) => {
    const 名单 = waiters.splice(0, waiters.length)
    // 注意：这里**不清** gatherSince。清掉的话，一旦人齐快照失效回到等待，
    // 就会从头重新计时，10 分钟上限永远到不了（见 startGather 里的注释）。
    const 主 = 名单[0]
    if (!主) {
      setState({ phase: 'idle', blockers: [], message: '' })
      return
    }
    setState({
      phase: 'counting',
      deadline: 0,
      countdownSec: 0,
      cancelReason: '',
      blockers: [],
      message: `人已齐（${名单.length} 个会话），立即重启，完成后一起唤醒。`,
    })
    // 走与普通路径完全相同的「动手」那一段：复用 finishCountdown 的后半段。
    pendingRestart = {
      command: 主.command || '',
      autoSay: 主.autoSay || settings.autoSay,
      timeoutSec: 主.timeoutSec ?? settings.timeoutSec,
      wakeMode: 主.wakeMode === 'script' ? 'script' : 主.wakeMode === 'plugin' ? 'plugin' : settings.wakeMode,
      sessionId: 主.sessionId,
      // 存**完整**名单（含主发起者）：万一人齐快照失效要回到等待，
      // 只有 slice(1) 的话主发起者会被丢掉。真正写文件时会再过滤掉 sessionId 自己。
      extraWake: 名单,
    }
    await finishCountdown({ fromGather: true, allowStale: 软拦 })
  }

  /**
   * 终态回投：告诉发起这次重启的会话「它没发生」，并说明为什么。
   *
   * 只在**真的没重启**时用（忙 / 计划不可用 / 脚本没起来 / 看门狗）。
   * 取消不回投：人就在机器前，他做了取消这个动作，自己知道；回投只会多出一轮
   * 没必要的对话。成功重启更不用回投——唤醒词本来就是干这个的。
   *
   * 文案里刻意写「不会自动重试」：agent 收到这条之后的正确反应是报告并等指令，
   * 而不是立刻再调一次 restart_dsh（那样很可能又撞上同一个阻塞项）。
   */
  const reportFailure = async (sessionId, reason, detail) => {
    const why =
      reason === 'busy'
        ? '这台机器上还有东西在跑'
        : reason === 'no-launch-plan'
          ? '插件没法确定在这台机器上怎么重新启动 应用'
          : reason === 'plan-write-failed'
            ? '启动计划写不进磁盘'
            : reason === 'launch-failed'
              ? '拉起重启脚本失败'
              : reason === 'launch-watchdog'
                ? '重启脚本拉起了，但 应用 一直没有退出'
                : '这次重启没有发生'
    const lines = [`重启没有发生：${why}。应用 仍在运行，这次不会自动重试。`]
    if (detail) lines.push('', detail)
    lines.push(
      '',
      '这是 restart_dsh 在倒计时结束后给出的结果（工具本身是秒回的，所以结果只能这样回投给你）。',
      '正确做法：把原因告诉用户，问他要不要稍后再试；不要自己立刻再调一次 restart_dsh。',
    )
    const text = lines.join('\n')
    await reportToSession(getService, log, sessionId, text, '失败回投')
  }

  /** 取消：状态与日志只在这里改，保证页面看到的和日志写的是同一件事。 */
  const cancelCountdown = (reason) => {
    stopCountdown()
    pendingRestart = null
    // 主动取消 = 这次「一起重启」整体作废，队列里等着的人也要被放下，
    // 否则他们会一直等一个永远不会发生的重启。
    const 被放下 = waiters.splice(0, waiters.length)
    if (被放下.length > 0) {
      logger.line(`取消：同时放下 ${被放下.length} 个等待中的会话`)
    }
    const why =
      reason === 'input'
        ? '检测到键鼠输入'
        : reason === 'abort'
          ? '发起这次重启的回合被打断'
          : '收到取消请求'
    logger.line(`倒计时取消（${reason}）：${why}`)
    setState({
      phase: 'cancelled',
      deadline: 0,
      cancelReason: reason,
      last: { at: Date.now(), ok: false, reason },
      message: `倒计时被取消（${why}），这次重启没有执行。`,
    })
  }

  /** 倒计时走完的唯一出口：此刻才判「整台机器现在能不能停」。 */
  const finishCountdown = async (options = {}) => {
    const pending = pendingRestart
    pendingRestart = null
    // 这一轮请求已经被取走，等待队列也随之作废。放在判空之前：即使
    // pending 是空的（重复调用、状态错乱），也不该让队列里的陈旧条目留到下一轮。
    //
    // 为什么清空不会漏唤醒 ——
    //   · 正常路径：`extraWake` 里已经装着完整名单（见 launchAfterGather：
    //     `extraWake: 名单`），投递时按它逐个唤醒；
    //   · 回炉路径（下面 `startGather(pending, ...)`）：显式重新
    //     `upsertWaiter(pending)` + 把 `extraWake` 逐条放回队列；
    //   · 取消/超时路径：本来就会把队列里的人逐个 reportFailure。
    //
    // 不清的后果：走普通工具入口时队列里若残留着上一次的条目，下次重启会把
    // 早已过期的会话当成"正在等的人"一起写进唤醒清单。
    waiters.length = 0
    if (!pending) return
    const { command, autoSay, timeoutSec, sessionId } = pending
    let wakeMode = pending.wakeMode
    const fromSettle = options.fromSettle === true
    const fromGather = options.fromGather === true
    const extraWake = Array.isArray(pending.extraWake) ? pending.extraWake : []

    // 倒计时走完了：这时候才真正判定「整台机器现在能不能停」。
    // 之所以放在这里而不是调用入口，是因为倒计时本身就是给在跑的任务的收尾窗口——
    // 调用时正忙、倒计时结束时已经跑完，就是可以重启的；反之就该放弃。
    //
    // fromGather 例外：调用它的 gatherTick **刚刚**已经判过一遍闲了，
    // 再判一次只会和那个快照打架 —— 实测会变成每 0.5 秒「人齐 → 失效 → 回炉」
    // 的密集空转，还会把 10 分钟上限白白烧掉。
    const blockersAtEnd = await collectBlockers(services)

    // fromGather 的复核要用**同一套三档判据**，否则刚判完的「软拦允许」会在这里
    // 被重新拦回去，等于方案 3 无效。
    if (options.fromGather) {
      const 等待者id = new Set(waiters.map((w) => w.sessionId))
      if (pending.extraWake) for (const w of pending.extraWake) 等待者id.add(String(w.sessionId))
      等待者id.add(String(sessionId))
      const { 硬拦 } = classifyStrangers(
        blockersAtEnd,
        等待者id,
        本轮起点,
        Date.now(),
        本轮结束,
      )
      if (硬拦.length === 0) {
        blockersAtEnd.length = 0 // 只剩软拦，允许动手
      }
    }

    // 收尾窗口的复核：如果剩下的阻塞项**只有发起会话自己**，放行。
    //
    // 为什么必须这么做：这条路径由 `kickSettle()` 触发 —— 而它只在收到该会话的
    // `turn/end(completed|error)` 时才调。也就是说，此刻我们已经拿到了
    // 「这一轮结束了」的**明确事件**；此时 `agents` 服务报的 `running` 是
    // 状态同步滞后，不是「还在干活」。
    //
    // 2026-11-10 实测：日志里连续出现「已收到 turn/end(completed)，立刻动手」
    // 紧跟着「仍有 1 处在忙，放弃重启」，重启永远无法通过收尾窗口完成。
    //
    // ⚠️ 必须放在 `if (blockersAtEnd.length > 0)` **之前**：放行意味着这一次
    // 不需要「等别人」也不需要「放弃」，而是直接往下走 launch。
    // 早先把它写在 if 块内部（只清空数组不跳出），日志会出现荒诞的
    // 「仍有 0 处在忙，放弃重启」—— 数组空了，却仍然执行了放弃分支。
    if (options.fromSettle && blockersAtEnd.length > 0) {
      const 只自己收尾 =
        sessionId !== '' && blockersAtEnd.every((b) => isSelfBlocker(b, sessionId))
      if (只自己收尾) {
        logger.line(
          `收尾窗口复核：只剩发起会话自己（${sessionId}）的滞后状态，` +
            '已收到它的 turn/end(completed)，放行',
        )
        blockersAtEnd.length = 0
      }
    }

    if (blockersAtEnd.length > 0) {
      const describe = (list) =>
        list
          .map((b) => `${b.kind}:${b.label}${b.id ? `（${b.id}）` : ''}`)
          .join(' / ')

      // 只有「发起这次重启的那个会话自己」还在跑 → 它多半只是在把刚拿到 ok 的
      // 这一轮说完，不是别人在忙。给一段收尾窗口再判一次，而不是直接作废。
      // 只给一次（fromSettle 之后不再等），否则「什么时候动手」就由回合长度说了算。
      const 只自己 =
        sessionId !== '' && blockersAtEnd.every((b) => isSelfBlocker(b, sessionId))
      if (只自己 && !fromSettle && !settleUsed) {
        logger.line(
          `倒计时结束时唯一在忙的是发起会话自己（${describe(blockersAtEnd)}），改等收尾窗口`,
        )
        waitForSelfToFinish(pending, blockersAtEnd)
        return
      }

      // 有**别人**在忙（不只是自己）→ 不作废，改成「等人齐」。
      // 多会话同时开发时这才是常态：A 请求重启时 B 往往还在写文件。
      // 旧的「有人忙就放弃」让先请求的会话永远吃亏，只有最后一个能成。
      //
      // ⚠ fromGather 的情况也要回到等待，**不能放弃**：人齐那一刻只是快照，
      // 下一个 1.5 秒里完全可能又冒出一个会话（实测：第 4 个会话插进来）。
      // 早先这里写成「fromGather 就直接放弃」，结果队列被静默清空、只有第一个人
      // 收到失败说明，其他等着的人永远等不到消息 —— 2026-11-09 实测踩到。
      if (!options.fromSettle) {
        logger.line(
          `倒计时结束时仍有 ${blockersAtEnd.length} 处在忙，` +
            `${fromGather ? '人齐快照已失效，回到等待' : '改等人齐'}：${describe(blockersAtEnd)}`,
        )
        // 队列刚才被 launchAfterGather 取走了，这里原样放回队列，
        // 否则这些人的唤醒词会随这次「回炉」一起丢掉。
        upsertWaiter(pending)
        for (const w of Array.isArray(pending.extraWake) ? pending.extraWake : []) {
          upsertWaiter(w)
        }
        startGather(pending, blockersAtEnd)
        return
      }

      logger.line(`倒计时结束时仍有 ${blockersAtEnd.length} 处在忙，放弃重启：${describe(blockersAtEnd)}`)
      setState({
        phase: 'blocked',
        blockers: blockersAtEnd,
        deadline: 0,
        countdownSec: 0,
        cancelReason: '',
        last: { at: Date.now(), ok: false, reason: 'busy-at-deadline' },
      })
      // 工具早就返回了，这里是它返回**之后**才发生的事：不回投的话，agent 那边
      // 还在按「马上会重启」安排下一步，而实际上重启已经作废了。
      await reportFailure(
        sessionId,
        'busy',
        `${fromSettle ? '收尾窗口结束后' : '倒计时结束时'}这台机器上还有 ${
          blockersAtEnd.length
        } 处在忙：\n` +
          blockersAtEnd.map((b) => `- ${b.label}${b.id ? `（${b.id}）` : ''}`).join('\n') +
          (只自己 || blockersAtEnd.some((b) => isSelfBlocker(b, sessionId))
            ? '\n\n其中包含发起这次重启的会话自己：它的这一轮还没说完。'
            : '\n\n这些都不是发起本次重启的会话；只在它们跑完后才能重启。'),
      )
      return
    }

    setState({ phase: 'launching', deadline: 0, blockers: [] })

    // 动手之前最后一道门：把「怎么再拉起一次」落成计划文件，脚本照计划执行。
    //
    // 计划由宿主自述生成（argv/execPath/cwd/getOrigin），不猜安装路径。
    // 计划不可用就**什么都不杀** —— 这一次重启作废，但 DSH 还活着；
    // 反过来（先杀再发现起不来）就是用户最痛的那个失败：服务没了，只能手动开。
    const plan = buildLaunchPlan(hostFacts(), loadSettings().launchCommand)
    const planCheck = validatePlan(plan)
    if (!planCheck.ok) {
      logger.line(`启动计划不可用（${planCheck.reason} ${planCheck.detail ?? ''}），放弃重启，DSH 未关闭`)
      setState({
        phase: 'failed',
        deadline: 0,
        countdownSec: 0,
        last: { at: Date.now(), ok: false, reason: 'no-launch-plan' },
        message:
          `无法确定这台机器上该怎么重新启动 DSH（${planCheck.reason}` +
          `${planCheck.detail ? '：' + planCheck.detail : ''}），这次重启已取消，DSH 仍在运行。` +
          `请让 agent 读插件包里的 SETUP.md，把启动命令写进 ${SETTINGS_FILE} 的 launchCommand 再来一次。`,
      })
      await reportFailure(
        sessionId,
        'no-launch-plan',
        '要修的话：读插件包里的 SETUP.md，按其中的三步把启动命令写进 ' +
          `${SETTINGS_FILE} 的 launchCommand（需要用户明确同意这条命令），然后再调一次 restart_dsh。`,
      )
      return
    }
    if (!writePlanFile(PLAN_FILE, plan)) {
      logger.line(`计划写不进去（${PLAN_FILE}），放弃重启，DSH 未关闭`)
      setState({
        phase: 'failed',
        deadline: 0,
        countdownSec: 0,
        last: { at: Date.now(), ok: false, reason: 'plan-write-failed' },
        message: `启动计划写不进 ${PLAN_FILE}，这次重启已取消，DSH 仍在运行。`,
      })
      await reportFailure(
        sessionId,
        'plan-write-failed',
        `写盘目标是 ${PLAN_FILE}。先确认这个目录可写（权限、磁盘空间、或别的东西占着同名文件），再重试。`,
      )
      return
    }
    logger.line(`启动计划：${PLAN_FILE}（mode=${plan.mode} exe=${plan.exe} 端口=${plan.port}）`)

    // 先落盘再动手：万一脚本把 DSH 杀了而我们自己没来得及写，唤醒就丢了。
    // 写的是两阶段文件的前半段（唤醒谁、说什么）；后半段（成没成、何时成）
    // 由脚本在拉起 DSH 之后补上，插件再来读。
    // 先落盘再动手：万一脚本把 应用 杀了而我们自己没来得及写，唤醒就丢了。
    //
    // 合并后不再用 wake-request.json + wake-extra.json 两份文件，
    // 而是一份 roster.json —— 一份清单同时表达「唤醒谁、说什么、是哪种角色」，
    // 结构上杜绝同一会话被投两次。
    let pendingRunId = ''
    if (wakeMode === 'plugin') {
      pendingRunId = makeRunId()
      const roster = createRoster({
        runId: pendingRunId,
        trigger: 'tool',
        command,
        requestedAt: Date.now(),
      })
      // 发起者
      upsertSession(roster, { id: sessionId, role: 'initiator', text: autoSay })
      // 一起等着的其它会话：作为 waiter 入清单（它们也表达过重启意愿）
      for (const w of extraWake) {
        if (!w || typeof w.sessionId !== 'string' || !w.sessionId) continue
        if (w.sessionId === sessionId) continue
        upsertSession(roster, { id: w.sessionId, role: 'waiter', text: w.autoSay || '' })
      }
      // 旁观者：会被这次重启打断、但没表达意愿的会话（尽量登记，拿不到 turn 就不登记）
      for (const sid of 活跃会话快照()) {
        if (sid === sessionId) continue
        upsertSession(roster, { id: sid, role: 'bystander', turn: 本轮起点.get(sid) ? 0 : 0 })
      }
      const written = writeRoster(STATE_DIR, roster)
      if (written) {
        // 脚本需要一份「它能认的」信号文件：它只理解 runId/phase/sessionId/text 这四个字段，
        // 而且会在写 ready 时整份重建 —— 所以 roster（含 sessions[] 数组）不能放在同一个文件里。
        // 两者靠 runId 关联：脚本写 ready 后，插件按 runId 找到对应的 roster。
        writeWakeRequest({
          runId: pendingRunId,
          phase: 'starting',
          sessionId,
          text: autoSay,
          requestedAt: roster.requestedAt,
          startedAt: 0,
          error: '',
        })
        logger.line(
          `已写重启清单：${rosterPath(STATE_DIR)}（runId=${pendingRunId} 共 ${roster.sessions.length} 个会话：` +
            roster.sessions.map((x) => `${x.role}:${x.id}`).join(', ') +
            '）',
        )
      } else {
        wakeMode = 'script'
        pendingRunId = ''
        logger.line('重启清单写不进去，本次降级为脚本注入')
      }
    }

    logger.line(`倒计时结束，拉起脚本：${scriptPath}（唤醒方式：${wakeMode}）`)

    const result = await launch(
      scriptPath,
      command,
      // plugin 模式下让脚本别插手唤醒（-AutoSay 留空 = 不发）
      wakeMode === 'plugin' ? '' : autoSay,
      timeoutSec,
      plan.port,
      PLAN_FILE,
    )
    logger.line(`脚本返回：${JSON.stringify(result)}`)

    if (!result.ok) {
      // 脚本压根没起来，这次重启不会发生 —— 把刚写的请求撤掉，
      // 否则下次启动会读到一条永远等不到 ready 的残账。
      if (pendingRunId && readWakeRequest()?.runId === pendingRunId) {
        clearWakeRequest()
        logger.line('脚本没起来，已撤销交接请求')
      }
      if (pendingRunId) {
        const extra = readExtraWake()
        if (extra && extra.runId === pendingRunId) {
          clearExtraWake()
          logger.line('脚本没起来，已撤销附加唤醒名单')
        }
      }
      setState({
        phase: 'failed',
        last: { at: Date.now(), ok: false, reason: 'launch-failed' },
        message: `拉起重启脚本失败：${result.error || '退出码 ' + String(result.code)}。DSH 没有重启。`,
      })
      await reportFailure(
        sessionId,
        'launch-failed',
        `脚本：${scriptPath}` +
          '\n返回：' + (result.error || '退出码 ' + String(result.code)) +
          `\n看 ${join(dirname(scriptPath), 'logs')} 里最新的 restart-*.log。`,
      )
      return
    }

    setState({
      phase: 'launching',
      last: { at: Date.now(), ok: true, reason: 'launched' },
    })

    // 兜底看门狗（见 LAUNCH_WATCHDOG_MS 的注释）：只在「脚本已拉起但重启
    // 始终没发生」时触发，把卡住的遮罩收回成一张失败页。
    const 看门狗 = setTimeout(() => {
      if (state.phase !== 'launching') return
      logger.line('看门狗：90 秒仍停在 launching，判为这次重启没有发生')
      setState({
        phase: 'failed',
        last: { at: Date.now(), ok: false, reason: 'launch-watchdog' },
        message:
          '重启脚本已经拉起，但 90 秒内 DSH 一直没有退出 —— 这次重启没有发生。' +
          `可以看一下 ${join(dirname(scriptPath), 'logs')} 里最新的 restart-*.log。`,
      })
      void reportFailure(
        sessionId,
        'launch-watchdog',
        `看 ${join(dirname(scriptPath), 'logs')} 里最新的 restart-*.log。`,
      )
    }, LAUNCH_WATCHDOG_MS)
    if (typeof 看门狗.unref === 'function') 看门狗.unref()
  }

  /**
   * 页面就绪，开始起表。
   *
   * 「就绪」的判据只有一个：页面来读了状态（GET /state）或者主动报到（POST /viewer）。
   * 倒计时是给人看的，所以表从人能看到数字那一刻起才有意义；从 Host 决定倒计时
   * 到浏览器画出第一帧之间的那段时间（一次轮询 + 一次渲染，实测接近 1 秒）
   * 不该算进倒计时里，否则设置 10 秒会从 9 秒开始数。
   */
  const beginFromViewer = (origin) => {
    if (state.phase !== 'counting' || !awaitingViewer) return false
    const now = Date.now()
    const deadline = now + state.countdownSec * 1000 + COUNTDOWN_TAIL_MS
    awaitingViewer = false
    // 保护期从「表真的开始走」那一刻算起 —— 之前等页面渲染的那段时间不该算进去。
    countdownStartedAt = now
    setState({ deadline })
    logger.line(`页面就绪（${origin}），倒计时开始：${state.countdownSec} 秒`)
    return true
  }

  const startCountdown = () => {
    stopCountdown()
    const tick = () => {
      // counting 与 settling 共用这一个表：两者都「还没动手、随时可取消」，区别
      // 只在到点之后做什么（counting → 判忙闲；settling → 直接动手）。
      if (state.phase !== 'counting' && state.phase !== 'settling') {
        stopCountdown()
        return
      }
      if (cancelSource) {
        cancelCountdown(cancelSource)
        return
      }
      if (state.phase === 'settling') {
        if (Date.now() >= state.deadline) {
          stopCountdown()
          void finishCountdown({ fromSettle: true })
        }
        return
      }
      if (awaitingViewer) {
        // 页面一直没出现（纯 CLI、标签页关着）也得能走：超时就当没人看，照常起表。
        if (viewerArmedAt && Date.now() - viewerArmedAt >= VIEWER_WAIT_MS) {
          beginFromViewer('无人查看，超时兜底')
        }
        return
      }
      if (Date.now() >= state.deadline) {
        stopCountdown()
        void finishCountdown()
      }
    }
    countdownTimer = setInterval(tick, 200)
    if (typeof countdownTimer.unref === 'function') countdownTimer.unref()
  }

  const tool = {
    name: 'restart_dsh',   // 工具名保持通用：调用方代码里写的是这个
    description:
      '确认整个 DSH 都空闲后，安全地重启它。会先检查所有会话与后台任务；有任何一个在忙就立刻返回 busy 且**不会**重启。' +
      '空闲时进入倒计时，倒计时期间任何真实键鼠输入都会取消本次重启。倒计时走完才拉起外部重启脚本。' +
      '`command` 只在「重启期间顺带做一件事」时才需要；纯重启就别传它，不要为了占位而传一条无害命令。' +
      '倒计时由插件在后台走秒，工具会立刻返回：这几十秒里你可以继续把这一轮说完。' +
      '秒数走完时再判一次 —— 除了插件自己，只要有会话或后台任务还在跑，这次重启就作废，' +
      '不会重启，也不会自动重试。' +
      '如果那一刻唯一的「忙」就是调用它的这个会话自己（这一轮还没说完），会再等最多 30 秒收尾窗口。' +
      '倒计时或收尾窗口期间，若发起会话的这一回合被打断（用户按 Esc），本次自动取消。' +
      '多个会话同时想重启时不会互相作废：它们会进同一个队列，等整机空闲后一次性重启，' +
      '然后把所有等待的会话一起唤醒。' +
      '**所有终态都会回投到这个会话里**：忙、计划不可用、脚本没起来、看门狗超时都会给你一条说明，' +
      '所以工具返回 ok 不代表重启一定发生 —— 收到「重启没有发生」的那条消息才是最终结果。' +
      '如果本机还没适配（返回 reason=needsSetup），先按 message 里的三步做：拿宿主自述拼命令 → ' +
      '让用户在对话里确认 → 写进 settings.json 的 launchCommand，再调一次。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'DSH 关闭之后、重新启动之前要执行的命令。**可以留空**：留空就是纯重启，不执行任何命令。' +
            '没有默认值 —— 不会在你没要求的时候跑任何东西。',
        },
        autoSay: {
          type: 'string',
          description: `重启后自动发给原会话的那句话，默认「${DEFAULT_AUTOSAY}」。`,
        },
        countdownSec: {
          type: 'number',
          description: `倒计时秒数，${MIN_COUNTDOWN}-${MAX_COUNTDOWN}，默认 ${DEFAULT_COUNTDOWN}。`,
        },
        timeoutSec: {
          type: 'number',
          description:
            `命令最多跑多少秒，${MIN_TIMEOUT_SEC}-${MAX_TIMEOUT_SEC}，默认 ${DEFAULT_TIMEOUT_SEC}。` +
            '超时就中止命令、照样启动 DSH —— 防止命令卡住把 DSH 晾在外面。',
        },
        wakeMode: {
          type: 'string',
          enum: ['plugin', 'script'],
          description:
            '重启后由谁把唤醒词发回原会话：plugin = 插件在重启后自己投递（默认，不碰页面、' +
            '不依赖调试端口，也省掉脚本那 12 秒等渲染）；script = 外部脚本用 CDP 往输入框注入，' +
            '仅在插件投递不可用时才需要。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          phase: { type: 'string' },
          message: { type: 'string' },
          blockers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                id: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['kind', 'label'],
            },
          },
        },
        required: ['ok', 'reason'],
      },
      render(args, value) {
        const text = typeof value?.message === 'string' ? value.message : JSON.stringify(value)
        return [{ type: 'text', text }]
      },
    },
    // 工具不再等倒计时，几毫秒就返回，所以超时给宽一点就够。
    timeoutMs: 15_000,
    isConcurrencySafe() {
      return false
    },

    async execute(args, exec) {
      // command 可以留空：空就是「纯重启」，不假装跑一条无害命令。
      // 不设默认值 —— 默认值一旦非空，就意味着"没人要求执行的东西也在执行"。
      const command = typeof args?.command === 'string' ? args.command.trim() : ''
      const autoSay =
        typeof args?.autoSay === 'string' && args.autoSay.trim().length > 0
          ? args.autoSay.trim()
          : settings.autoSay
      // 调用方没传就落回设置页的默认值（DESIGN 第十节：设置页只提供默认值）
      const countdownSec = clampInt(
        args?.countdownSec === undefined ? settings.countdownSec : args.countdownSec,
        MIN_COUNTDOWN,
        MAX_COUNTDOWN,
        settings.countdownSec,
      )
      // 命令超时：只管"命令卡住"这一种情况，超时即中止并照常启动 DSH。
      const timeoutSec = clampInt(
        args?.timeoutSec === undefined ? settings.timeoutSec : args.timeoutSec,
        MIN_TIMEOUT_SEC,
        MAX_TIMEOUT_SEC,
        settings.timeoutSec,
      )
      // 优先级：本次调用的参数 > 设置页的默认值 > 代码默认值（plugin）。
      // 默认走 plugin：直投不碰页面、不用等渲染，比脚本注入快十几秒。
      const 想要的方式 = args?.wakeMode === 'script' || args?.wakeMode === 'plugin' ? args.wakeMode : settings.wakeMode
      let wakeMode = 想要的方式 === 'script' ? 'script' : 'plugin'

      // 已经在等人齐 → 直接把调用方加进队列，不打扰它。
      if (state.phase === 'waiting') {
        const selfId = exec?.agent?.id !== undefined ? String(exec.agent.id) : ''
        if (selfId) {
          upsertWaiter({ sessionId: selfId, autoSay: autoSay || settings.autoSay })
          logger.line(`新增等待者：${selfId}（队列现有 ${waiters.length} 人）`)
          return {
            ok: true,
            reason: 'queued',
            phase: 'waiting',
            message:
              `已加入重启队列（当前 ${waiters.length} 个会话在等）。` +
              '等其他会话都跑完会一次性重启，然后把你们一起唤醒，不需要再调一次。',
          }
        }
        return {
          ok: false,
          reason: 'already-running',
          phase: state.phase,
          message: '已经有一次重启在等人齐，但这次调用没有会话 id，无法入队。',
        }
      }

      if (state.phase === 'counting' || state.phase === 'settling' || state.phase === 'launching') {
        // 已经有一次重启在进行 → 把调用方记进队列，这样它会和发起者一起被唤醒。
        // 旧行为是直接忽略这次调用，于是第二个会话的改动等于白做。
        const selfId = exec?.agent?.id !== undefined ? String(exec.agent.id) : ''
        if (selfId) upsertWaiter({ sessionId: selfId, autoSay: autoSay || settings.autoSay })
        return {
          ok: false,
          reason: 'already-running',
          phase: state.phase,
          message:
            '已经有一次重启在进行中，这次调用没有另起一次。' +
            (selfId ? '已把当前会话记进唤醒名单，重启后会被一起唤醒。' : ''),
        }
      }

      // 现读设置：agent 可能刚把 launchCommand 写进文件，而内存里那份还是旧的。
      const fresh = loadSettings()

      // 总开关。关掉之后连倒计时都不进 —— 这是「我不想让任何东西自动重启 DSH」的表达。
      if (fresh.allowAutoRestart === false) {
        return {
          ok: false,
          reason: 'disabled',
          phase: state.phase,
          message:
            '自动重启已关闭（settings.json 里 allowAutoRestart=false）。需要重启请手动操作，' +
            '或把该字段改成 true（删掉也等于 true）后再调用 restart_dsh。',
        }
      }

      // 进场先确认「这台机器上确实存在一种能把它再拉起来的办法」。
      //
      // 这一步必须在倒计时之前做：倒计时走完才发现起不来，等于把人骗到遮罩页上再告诉他重启失败，
      // 而那时候进程已经被杀了。
      const planNow = buildLaunchPlan(hostFacts(), fresh.launchCommand)
      const planCheck = validatePlan(planNow)
      if (!planCheck.ok) {
        const facts = hostFacts()
        const 自述 = [
          `argv: ${JSON.stringify(facts.argv)}`,
          `execPath: ${facts.execPath || '（空）'}`,
          `cwd: ${facts.cwd || '（空）'}`,
          `origin: ${facts.origin || '（空）'}  ← 重启后必须还是这个地址，页面才连得回来`,
          `profile: ${facts.profile || '（空）'}`,
          `dshVersion: ${facts.dshVersion || '（未知）'}`,
          `electron: ${facts.electron ? '是（跑在桌面端外壳里）' : '否'}`,
        ].join('\n')
        logger.line(`启动计划不可用（${planCheck.reason} ${planCheck.detail ?? ''}），返回 needsSetup`)
        return {
          ok: false,
          reason: 'needsSetup',
          phase: state.phase,
          message: [
            `重启被拦下：插件没法确定在这台机器上怎么重新启动 DSH（${planCheck.reason}` +
              `${planCheck.detail ? '：' + planCheck.detail : ''}）。DSH 没有被关闭，也没有进入倒计时。`,
            '',
            '宿主自述（真实值，不要自己猜）：',
            自述,
            '',
            '接下来由你完成，一共三步：',
            '1. 用上面的自述拼一条「把同样形态的 DSH 从零拉起来」的命令。别改 profile，别改端口 ——',
            '   端口变了页面就连不回来；profile 变了就不是同一个 DSH 了。',
            '2. 在对话里把这条命令的原文发给用户，明确告诉他：这条命令会在每次重启时以他的权限执行。',
            '   必须等到他明确同意再往下走。',
            `3. 用户确认后，把命令写进 ${SETTINGS_FILE} 的 launchCommand 字段（JSON 字符串，`,
            '   反斜杠要转义），然后再次调用 restart_dsh。',
            '',
            '不要改插件里的 .ps1，不要自己结束进程。写完之后可以再调一次本工具，它会先验证再动手。',
            '细则见插件包里的 SETUP.md。',
          ].join('\n'),
        }
      }

      const self = exec?.agent
      const sessionId = self?.id !== undefined ? String(self.id) : ''

      // ── 只允许根会话（Lead）触发重启，子代理一律拒绝 ──────────────────
      //
      // 为什么：子代理的职责是「把结果交回 Lead」，它重启宿主等于把整棵树
      // 连同自己的父代理一起打断 —— 而父代理正等着它的结果，两边会互相等死。
      //
      // 判据用两个，任一成立即为子代理（都和官方实现一致）：
      //   session.header.origin === 'subagent'
      //   session.header.parentSession 存在
      // session-controller 内部就是用 origin === 'subagent' 判断的。
      if (self) {
        let 是子代理 = false
        let 父会话 = ''
        try {
          const header = self.session?.header
          if (header) {
            if (header.origin === 'subagent') 是子代理 = true
            if (typeof header.parentSession === 'string' && header.parentSession) {
              是子代理 = true
              父会话 = String(header.parentSession)
            }
          }
        } catch {
          // 读不到 header 就当根会话处理（宁可让 Lead 能重启，也不要误拒）
        }
        if (是子代理) {
          logger.line(
            `拒绝子代理重启：session=${sessionId || '(未知)'} 父会话=${父会话 || '(未知)'}`,
          )
          return {
            ok: false,
            reason: 'subagent-forbidden',
            phase: state.phase,
            message: [
              '子代理不能自己重启 应用。原因：你的父代理正在等你返回结果，',
              '重启会把整棵树一起打断，父代理和你会互相等死。',
              '',
              父会话 ? `你的父会话：${父会话}` : '（未能读出父会话 id）',
              '',
              '正确做法：把「需要重启才能验证」这件事**写进你返回给 Lead 的结果里**，',
              '由 Lead 汇总所有子代理结果后，自己调一次 restart_dsh。',
              '这样一次重启能让所有人的改动一起生效。',
            ].join('\n'),
          }
        }
      }

      const flowLog = logger.begin()
      logger.line(
        `工具调用：command=${command ? JSON.stringify(command) : '（无，纯重启）'} autoSay=${JSON.stringify(autoSay)} 倒计时=${countdownSec}s 命令超时=${timeoutSec}s 会话=${sessionId}`,
      )

      // 空闲判定只在倒计时结束那一刻做（见下面）。入口不判，也不预扫：
      // 调用它的这个 agent 此刻必然是 running，扫出来的「忙」里永远有它自己，
      // 除了在日志里写一句噪音，改变不了任何行为。
      cancelSource = ''
      // 每次新的重启都重新给一次收尾窗口：它是「这一轮」的宽限，不是全局开关。
      settleUsed = false
      // 先不起表：deadline 留 0，等页面把自己画出来（来读状态）那一刻再定。
      // 实际等待 = 设置值 + 999ms：多出来的不到 1 秒，页面上不会先蹦出一个「设置值+1」。
      // 显示侧（client.js 剩余秒）用 ceil - 1 做向下取整，所以设置 3 秒看到的是 3→2→1→0，
      // 每个数字各占 1 秒，最后那 999ms 是快动手前的缓冲。
      awaitingViewer = true
      viewerArmedAt = Date.now()
      setState({
        phase: 'counting',
        deadline: 0,
        countdownSec,
        cancelReason: '',
        command,
        autoSay,
        sessionId,
        blockers: [],
      })
      logger.line(`进入 ${countdownSec} 秒倒计时，等页面画出来再起表`)

      pendingRestart = { command, autoSay, timeoutSec, wakeMode, sessionId }
      startCountdown()

      return {
        ok: true,
        reason: 'counting',
        phase: 'counting',
        message:
          `倒计时已开始：${countdownSec} 秒后判定一次。除了插件自己，只要有会话或后台任务还在跑，` +
          `这次重启就作废。这 ${countdownSec} 秒里你可以继续把这一轮说完 —— 说完再判，说不完就不重启。`,
      }
    },
  }

  // ── 回合被打断 → 取消这次重启 ──────────────────────────────────────────
  //
  // 为什么不能靠 `exec.signal`：那个信号只在工具体返回前有效。工具是秒回的，
  // 而这里要盯的是它返回**之后**的几十秒倒计时 —— 那时 fuseToolSignals 早就
  // dispose 了，监听不到任何东西。
  //
  // 所以改用会话日志里的 `turn/end` 事件：`reason.kind === 'aborted'` 正是
  // 「这一回合被 cancel 掉了」（用户按 Esc、或上层取消）。这和「正常说完」
  // 得到的 `completed` 必须区分开 —— 后者恰恰是该继续重启的那种。
  ctx.effect(() => {
    // 自证用的计数器：第一次收到**发起会话**的 turn/end 时往日志写一行。
    // 为什么留它：这条链路（cordis 事件 → 我们的 ctx）在没有真实取消发生时
    // 无法从外部观察。写一行 `turn/end=<kind>` 就能证明「监听器确实收到了、
    // 会话 id 也对上了」，不必非得等用户按一次 Esc 才知道接没接上。
    let 见过目标会话的回合结束 = false

    const onSessionEvent = (session, event) => {
      if (!event) return
      const sid = String(session?.header?.id ?? '')
      // 记录「这一轮何时开始」：方案 3 用它区分「刚起不久」和「跑了一阵」。
      if (event.type === 'turn/start' && sid) {
        const t = Number(event.time ?? 0)
        if (t > 0) 本轮起点.set(sid, t)
        裁剪轮次表()
        // 有人开跑 → 可能变成新的硬拦项，重判一次把状态与界面刷准。
        kickGather('turn/start')
        return
      }
      if (event.type !== 'turn/end') return
      const sessionId = sid
      if (sessionId === '') return
      // 记录「这一轮何时结束」：方案 3 只在轮次已结束的会话上允许软拦。
      {
        const t = Number(event.time ?? 0)
        if (t > 0) 本轮结束.set(sessionId, t)
        else 本轮结束.set(sessionId, Date.now())
        裁剪轮次表()
      }
      // 有人跑完了 → 这是等人齐的主信号，立刻重判一次（不用等兜底扫描）。
      kickGather('turn/end')
      // 用 state.sessionId 而不是 pendingRestart：后者在 finishCountdown 开头就被
      // 清掉了，而 turn/end 可能恰好落在这个缝里。
      const target = state.sessionId
      if (!target || target !== sessionId) return

      const kind = String(event.data?.reason?.kind ?? '')
      if (!见过目标会话的回合结束) {
        见过目标会话的回合结束 = true
        logger.line(`已收到发起会话的 turn/end（${sessionId}，kind=${kind || '空'}），打断判据可用`)
      }

      // 这一轮正常结束 → 若正处于等它收尾的窗口，立刻动手。
      // 必须先确认是**发起会话**（上面已用 state.sessionId 过滤），
      // 否则别的会话说完也会触发重启 —— 那是错的。
      if (kind === 'completed' || kind === 'error') {
        // 正在等它收尾 → 立刻动手；还在倒计时 → 走方案 B 的「保护期 + 全机空闲」提前收工。
        kickSettle()
        maybeGoEarly()
        return
      }

      // 只有 aborted 才算「被打断」。completed 是正常说完 —— 那恰恰是该继续重启的情形。
      if (kind !== 'aborted') return
      if (state.phase !== 'counting' && state.phase !== 'settling') return
      logger.line(`回合被打断（${sessionId}，turn/end=${kind}），取消这次重启`)
      cancelSource = 'abort'
    }
    return ctx.on('session/event', onSessionEvent)
  }, `${name}: 回合打断即取消`)

  // ── 忙闲变化 → 立刻重判「等人齐」────────────────────────────────────
  //
  // `agent/status` 是宿主自己发的：任何会话从 running 变 idle（或反过来）
  // 都会触发。这就是等人齐的主判据 —— 有事件就没必要轮询。
  ctx.effect(() => {
    const onAgentStatus = ({ agent, status }) => {
      if (state.phase !== 'waiting') return
      const id = String(agent?.id ?? '')
      if (id) {
        // 顺带把这个会话的起点记下来（拿不到 turn/start 时的兜底）。
        if (status === 'running' && !本轮起点.has(id)) 本轮起点.set(id, Date.now())
      }
      kickGather('agent/status')
    }
    return ctx.on('agent/status', onAgentStatus)
  }, `${name}: 忙闲变化即重判`)

  // ── 运维工具：查看 / 清理重启清单 ─────────────────────────────────────
  //
  // 这不是产品入口（产品入口是 restart_dsh）。它只用于排查：投递卡住时，
  // 看一眼清单里还有谁没投、然后手动清掉。
  ctx.effect(() => {
    try {
      return ctx.tools.register({
        name: 'dsh_restart_suite_roster',
        description:
          '查看或清理重启清单（roster.json）。' +
          'action 省略 = 查看；action="clear" = 删除清单（用于排查卡住的投递）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['show', 'clear'], description: 'show 或 clear' },
          },
          required: [],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              path: { type: 'string' },
              message: { type: 'string' },
              sessions: { type: 'array', items: { type: 'object' } },
            },
            required: ['ok'],
          },
          render(args, value) {
            return [{ type: 'text', text: value?.message || JSON.stringify(value) }]
          },
        },
        async execute(args) {
          const action = args?.action === 'clear' ? 'clear' : 'show'
          const file = rosterPath(STATE_DIR)
          if (action === 'clear') {
            const ok = clearRoster(STATE_DIR)
            logger.line('手动清理重启清单')
            return { ok, path: file, message: ok ? '清单已删除' : '清单删除失败（可能本来就不存在）' }
          }
          const { roster, warnings } = readRoster(STATE_DIR)
          return {
            ok: true,
            path: file,
            sessions: roster?.sessions ?? [],
            message: roster
              ? `清单：runId=${roster.runId} phase=${roster.phase} sessions=${roster.sessions.length}` +
                (warnings.length ? `（告警：${warnings.join('; ')}）` : '')
              : '当前没有清单',
          }
        },
      })
    } catch (err) {
      logger.line(`注册 dsh_restart_suite_roster 失败：${String(err?.message ?? err)}`)
      return () => {}
    }
  }, `${name}: 清单运维工具`)

  // ── 工具入口（唯一触发方式）──────────────────────────────────────────
  ctx.effect(() => {
    try {
      const dispose = ctx.tools.register(tool)
      trace('restart_dsh 注册成功')
      return dispose
    } catch (err) {
      trace(`restart_dsh 注册失败：${String(err?.message ?? err)}\n${String(err?.stack ?? '')}`)
      throw err
    }
  }, `${name}: restart_dsh 工具`)

  // ── 启动后善后：按 roster 清单投递 ────────────────────────────────────
  //
  // 只管「自己发起的那次重启」：重启前把「谁在等、说什么」写进清单，重启后
  // 对照清单投递。这是唯一的续跑路径。
  //
  // 曾经这里还有第二层「全量扫描兜底」（after/sweep.js，从 dsh-interrupted-resume
  // 搬来），用于断电/崩溃/强杀这类**没有清单**的场景。它已被移除，原因是：
  //
  //   1. 它从未被接上——`scanOnce` 没有任何调用方，日志却写着"只走全量扫描"，
  //      等于在报告一件没有发生的事；
  //   2. 接上的风险大于收益：它要求调用方先把「清单里已有的会话」过滤掉，否则
  //      清单投一次、扫描再投一次，同一个任务会被跑两遍（可能重复改文件、重复
  //      执行命令）。而两者的时间窗是重叠的（roster 在重启后几秒投递，扫描的
  //      静置期只有 30 秒）；
  //   3. 实际命中率很低：历史账本 124 次扫描只真正续跑 3 次。
  //
  // 代价：崩溃/强杀后被中断的会话不会自动续跑，需要手动继续。日常的主动重启
  // 不受影响。
  ctx.effect(() => {
    let stopped = false
    const timer = setTimeout(() => {
      void (async () => {
        if (stopped) return
        const { roster: initial, warnings } = readRoster(STATE_DIR)
        for (const w of warnings) logger.line(`清单告警：${w}`)

        if (initial) {
          logger.line(
            `发现重启清单：runId=${initial.runId} phase=${initial.phase} ` +
              `sessions=${initial.sessions.length}`,
          )
          const roster = await 等清单就绪(initial.runId, () => !stopped)
          if (roster) {
            const 结果 = await deliverAll({
              roster,
              getService,
              log: (m) => logger.line(m),
              requestIdFor,
              onDelivered: (r) => writeRoster(STATE_DIR, r),
            })
            logger.line(
              `清单投递结果：attempted=${结果.attempted} delivered=${结果.delivered} ` +
                `failed=${结果.failed} skipped=${结果.skipped}`,
            )
            if (结果.failed > 0) {
              logger.line('仍有投递失败的会话，清单保留等下次启动再试')
            } else {
              clearRoster(STATE_DIR)
              logger.line('清单已全部投递，清理完成')
            }
          } else {
            logger.line('等待清单就绪超时，本次不做 roster 投递')
          }
        } else {
          // 说清楚"没有做什么"，不要让人以为有兜底在跑。
          logger.line(
            '没有重启清单（可能是崩溃/外部重启）：本次没有会话需要唤醒。' +
              '被中断的会话需手动继续（自动续跑兜底已移除）',
          )
        }
      })()
    }, 200)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, `${name}: 启动后善后`)

  // ── 状态路由（只给本插件的 Client 用）───────────────────────────────
  ctx.inject(['webServer'], (scope) => {
    trace('webServer 注入回调已进入')
    const ws = scope.webServer
    if (!ws || typeof ws.register !== 'function') {
      log('webServer 不可用，倒计时界面拿不到状态')
      return
    }
    // ⚠ 必须 scope.effect，不能用 ctx.effect：cordis 只收集 effect 的返回值，
    //   挂在根上的话热重载时这组路由拆不干净，而 webServer.register 对同一个
    //   路径二次注册会 throw（dsh-flow-v2 实测踩过）。
    scope.effect(() => {
      try {
      const dispose = ws.register({
        kind: 'prefix',
        path: API_PATH,
        handler: (req, res) => {
          void (async () => {
            // 门禁先过：这三层挡的是「别的网页/别的进程顺手把 DSH 关掉」。
            const guard = checkRequestSource(req)
            if (!guard.ok) {
              log(`拒绝一次 API 请求：${guard.reason}`)
              jsonResponse(res, 403, {
                ok: false,
                error: { code: 'forbidden', message: guard.reason },
              })
              return
            }
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const route = url.pathname.slice(API_PATH.length) || '/state'

            if (route === '/state' && (req.method === 'GET' || req.method === 'HEAD')) {
              // 也有人是页面主动报到（POST /viewer），这里兜一手：
              // 只要求读状态就说明有人在看，可以起表了。
              beginFromViewer('GET /state')
              jsonResponse(res, 200, { ok: true, value: snapshot() })
              return
            }

            if (route === '/viewer' && req.method === 'POST') {
              // 页面把自己画出来之后主动报到：这一刻起表，人看到的就是完整的设置秒数。
              const started = beginFromViewer('页面报到')
              jsonResponse(res, 200, { ok: true, value: { started, ...snapshot() } })
              return
            }

            if (route === '/probe' && (req.method === 'GET' || req.method === 'HEAD')) {
              // 实时扫描：state 只是状态机的记忆，这里现查一遍宿主，给调试和验证用。
              const live = await collectBlockers(services)
              const agents = []
              for (const agent of safeList(services.agents)) {
                let status = 'unknown'
                try {
                  status = String(agent?.status ?? 'unknown')
                } catch {
                  status = 'unreadable'
                }
                agents.push({ id: String(agent?.id ?? ''), status })
              }
              jsonResponse(res, 200, { ok: true, value: { at: Date.now(), blockers: live, agents } })
              return
            }

            if (route === '/settings' && (req.method === 'GET' || req.method === 'HEAD')) {
              jsonResponse(res, 200, { ok: true, value: { ...settings }, meta: settingsMeta() })
              return
            }

            if (route === '/settings' && req.method === 'POST') {
              const payload = await readJsonBody(req)
              const changed = applySettings(payload)
              logger.line(`设置页更新：${changed.join(', ') || '（无变化）'}`)
              jsonResponse(res, 200, { ok: true, value: { ...settings }, meta: settingsMeta() })
              return
            }

            if (route === '/last-run' && (req.method === 'GET' || req.method === 'HEAD')) {
              // 上一次脚本跑完留下的结果（命令退出码、是否超时、DSH 有没有起来）。
              // 交接文件是「处理完即删」的，这里读的是另一个只跑不删的收据。
              jsonResponse(res, 200, { ok: true, value: readRunResult() })
              return
            }

            if (route === '/cancel' && req.method === 'POST') {
              const payload = await readJsonBody(req)
              // settling（等发起会话自己收尾）也算「还没动手」，一样可以取消：
              // 那几十秒里人就坐在机器前，动一下键鼠同样意味着现在不该重启。
              if (state.phase === 'counting' || state.phase === 'settling' || state.phase === 'waiting') {
                // 前端在检测到键鼠时调用（source=input）；直接调接口的算 api。
                cancelSource = payload && payload.source === 'input' ? 'input' : 'api'
                logger.line('收到取消请求：' + cancelSource)
              }
              jsonResponse(res, 200, { ok: true, value: snapshot() })
              return
            }

            if (route === '/dismiss' && req.method === 'POST') {
              await readJsonBody(req)
              if (
                state.phase === 'blocked' ||
                state.phase === 'cancelled' ||
                state.phase === 'failed' ||
                state.phase === 'idle'
              ) {
                setState({ phase: 'idle', blockers: [], cancelReason: '', message: '' })
              }
              jsonResponse(res, 200, { ok: true, value: snapshot() })
              return
            }

            // 按钮入口（原 restart-now 的四处按钮都走这里）。
            //
            // 为什么从「仅开发」改成正式路由：场景二的按钮入口是产品功能，
            // 不是调试口。安全性不靠「藏起来」，靠门禁 —— 上面已经拦了
            // 反向代理头 / 非回环 / 缺自定义头 / 跨源，和 /cancel /settings 同一套。
            //
            // 这个口只调 tool.execute()，和 agent 调 restart_dsh 走完全相同的
            // 判定链路（判忙、倒计时、等人齐），不会绕过任何检查。
            if (route === '/restart' && req.method === 'POST') {
              // 按钮入口：client 的四个按钮（侧栏底部 / 会话标题栏 / 设置行 / 面板）
              // 都 POST 到这里。传 sessionId 时按该会话登记为 initiator；
              // 不传时走「无会话」模式 —— 唤醒词无处可投，但重启照常执行。
              const body = await readJsonBody(req)
              const payload = body && typeof body === 'object' ? body : {}
              const targetSession = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
              const result = await tool.execute(payload, {
                agent: targetSession ? { id: targetSession } : undefined,
                signal: new AbortController().signal,
              })
              jsonResponse(res, 200, { ok: true, value: result, state: snapshot() })
              return
            }

            jsonResponse(res, 404, {
              ok: false,
              error: { code: 'not-found', message: `不认识的路径：${route}` },
            })
          })()
        },
      })
      log('状态路由已注册：' + API_PATH)
      return dispose
      } catch (err) {
        log('注册状态路由失败（不影响工具本身）：' + String(err))
        return () => {}
      }
    })
  })

  // ── 卸载时释放定时器与本次 apply 的全部状态 ────────────────────────────
  //
  // 这一条不是"顺手清理"，而是**必需的**：`stopCountdown()` 原本只在业务路径
  // 里被调用，卸载时没人叫它，于是
  //
  //   · `setInterval(tick, 200)` 会继续跑（它只看 `state.phase`，而卸载不会
  //     改状态机，所以 phase 仍是 `counting`/`waiting`）；
  //   · `tick` 到点还会 `void finishCountdown()` —— **对已经卸载的插件真的去
  //     spawn 重启脚本**；
  //   · `waiting` 分支的 `gatherTimer` 每 15 秒自我续期，无上限地跑下去；
  //   · 定时器闭包把整个 apply 作用域（ctx / services / settings / state /
  //     logger / 两个轮次 Map / 标题缓存）一直钉在堆上。
  //
  // 也就是说：它同时是内存泄漏和"插件卸了还在重启应用"的行为事故。放在最后
  // 注册是有意的 —— 清理时先停表，再清状态，顺序与依赖方向一致。
  ctx.effect(
    () => () => {
      stopCountdown()
      gathering = false
      awaitingViewer = false
      settleUsed = false
      pendingRestart = null
      waiters.length = 0
      本轮起点.clear()
      本轮结束.clear()
      标题缓存.clear()
    },
    `${name}: 卸载时停止倒计时并释放状态`,
  )

  log(`已加载（脚本 ${scriptPath}）`)
}

/** 仅供 test/idle-check.mjs 直接测判定逻辑；不属于插件契约，Cordis 不会看它。 */
export const __test = {
  collectBlockers,
  createState,
  clampInt,
  decorateWakeText,
  readWakeRequest,
  writeWakeRequest,
  clearWakeRequest,
  WAKE_REQUEST_FILE,
  DEFAULT_COUNTDOWN,
  loadSettings,
  readSettingsFile,
  writeSettingsFile,
  SETTINGS_DEFAULTS,
  SETTINGS_FILE,
  // 投递幂等：直接测真实实现，不要测「规则副本」（那样测的是复制品，不是代码）
  pushWake,
  // 收尾窗口的判定：纯函数，用来保证「只有调用方自己在忙」才给宽限。
  isSelfBlocker,
  isWaiterBlocker,
  classifyStrangers,
  FRESH_AGENT_MS,
  // 保护期自适应：保护期必须 ≤ 倒计时的一半，否则设置页的短倒计时形同虚设
  earlyGoGraceFor,
  EARLY_GO_GRACE_MAX_MS,
  DEFAULT_COUNTDOWN,
  MIN_COUNTDOWN,
  // 附加唤醒名单（多会话一起重启时用）
  readExtraWake,
  writeExtraWake,
  clearExtraWake,
  EXTRA_WAKE_FILE,
  // 启动计划：判定逻辑纯函数，可以在没有宿主的环境里直接测。
  buildLaunchPlan,
  validatePlan,
  readHostFacts,
  planFilePath,
  writePlanFile,
  PLAN_FILE,
  // 请求体读取：超限必须丢弃，否则本机进程能 POST 一个巨体把堆打满。
  readJsonBody,
  MAX_JSON_BODY_BYTES,
}
