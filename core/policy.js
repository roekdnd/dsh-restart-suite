/**
 * restart-suite —— 判定策略（core/policy.js）。
 *
 * 从 dsh-autonomous-restart **原样搬来**，注释里的教训一字未改。
 * 这一层不含 I/O，只吃「服务快照」，因此可以完全离线测。
 */

/** 插件自己创建的后台任务 / 子代理 —— 不算阻塞项，否则插件会把自己锁死。 */
const OWN_JOB_IDS = new Set()

/**
 * 倒计时期间「最短保护期」的上限。
 *
 * 保护期本身由 earlyGoGraceFor 按 countdownSec 算（min(上限, 倒计时/2)），
 * 所以这里只需要一个上界。
 */
const EARLY_GO_GRACE_MAX_MS = 5_000

function safeList(service) {
  if (!service || typeof service.list !== 'function') return []
  try {
    const list = service.list.bind(service)()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

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

function isWaiterBlocker(blocker, 等待者id) {
  if (!blocker || !blocker.id) return true // 没有 id 的（如服务不可用）一律算别人
  if (!(blocker.kind === 'agent' || blocker.kind === 'queued' || blocker.kind === 'schedule')) {
    return true // job 等一律算别人
  }
  return !等待者id.has(blocker.id)
}

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

function earlyGoGraceFor(countdownSec) {
  const n = Number(countdownSec)
  const 总长 = Number.isFinite(n) && n > 0 ? n * 1000 : 10_000
  return Math.min(EARLY_GO_GRACE_MAX_MS, Math.floor(总长 / 2))
}

export {
  OWN_JOB_IDS,
  safeList,
  collectBlockers,
  isWaiterBlocker,
  classifyStrangers,
  isSelfBlocker,
  earlyGoGraceFor,
}
