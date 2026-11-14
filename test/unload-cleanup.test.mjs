/**
 * 回归测试：插件卸载后不得再执行倒计时的后续动作。
 *
 * 针对的真实缺陷：`stopCountdown()` 写得很完整，但 `apply()` 从来没有注册过
 * 一个"卸载时停表"的 effect，所以插件被热重载/关掉之后 `setInterval(tick, 200)`
 * 仍在跑。`tick` 只看 `state.phase`，而卸载不改状态机 —— 于是到点会真的走到
 * `finishCountdown()`，对一个**已经卸载的插件**去拉重启脚本。
 *
 * 这里用「卸载 + 把时间推过 deadline + 断言没有拉起脚本」来证明它：
 * 旧代码会通过 `launchScript` 真的去 spawn，测试立刻失败。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, mock } from 'node:test'

const 包根 = dirname(dirname(fileURLToPath(import.meta.url)))
const STATE = mkdtempSync(join(tmpdir(), 'rs-unload-'))
process.env['AR_STATE_DIR'] = STATE

const { apply } = await import('../index.js')

/**
 * 会**记住** effect disposer 的假 ctx。
 *
 * 与 suite-integration 的 `effect(fn) { return fn() }` 不同：那个写法把返回值
 * 丢掉了，于是"卸载时到底发生了什么"完全观察不到。
 */
function 搭({ 记录拉起 }) {
  try {
    mock.timers.reset()
  } catch {}
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })

  const disposers = []
  const 已注册工具 = []
  const ctx = {
    tools: {
      register(t) {
        已注册工具.push(t)
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject(_n, fn) {
      fn({
        webServer: undefined,
        effect: (f) => {
          const d = f()
          if (typeof d === 'function') disposers.push(d)
          return d
        },
      })
      return () => {}
    },
    get(k) {
      if (k === 'sessionController') {
        return {
          async prompt() {
            return { accepted: true }
          },
          async list() {
            return { items: [] }
          },
          async events() {
            return { records: [] }
          },
        }
      }
      if (k === 'agents') return { list: () => [], get: () => undefined }
      return undefined
    },
    logger: { info() {}, warn() {} },
    waterfall: async () => [],
    on() {
      return () => {}
    },
  }

  // 注入一个假的拉起函数：真的 spawn 会去关应用，绝不能在测试里发生。
  apply(ctx, {
    launchScript: async (...args) => {
      记录拉起.push(args)
      return { ok: false, error: 'test: launch script must not run' }
    },
  })
  return { ctx, disposers, 按名字: (n) => 已注册工具.find((t) => t.name === n) }
}

test('卸载后倒计时不得继续推进（否则会对已卸载的插件拉起脚本）', async () => {
  const 记录拉起 = []
  const { disposers, 按名字 } = 搭({ 记录拉起 })

  assert.ok(disposers.length > 0, 'apply 必须至少注册一个 effect 清理函数')

  const tool = 按名字('restart_dsh')
  assert.ok(tool, 'restart_dsh 工具应当已注册')

  // 起一个很短的倒计时，让它有机会在"卸载之后"到点。
  await tool.execute({ countdownSec: 3 }, { sessionId: 'session-unload-1' })

  // 卸载：cordis 按"后注册先执行"的顺序调用 disposer。
  for (const d of [...disposers].reverse()) d()

  const 卸载前 = 记录拉起.length

  // 把时间推过原来的 deadline（3 秒）以及更远。旧代码在这里会真的走到
  // finishCountdown → 拉起脚本；新代码的定时器已经停了，什么都不会发生。
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
    mock.timers.tick(1000)
  }
  await Promise.resolve()

  assert.equal(
    记录拉起.length,
    卸载前,
    '卸载后不得再拉起重启脚本（说明倒计时定时器没被停掉）',
  )

  // ⚠ 必须复位：这个测试用 mock.timers 伪造了 Date 和 setTimeout，
  // 不复位会污染同文件里后面的测试 —— 它们的 setTimeout 永远不会触发，
  // 整个测试文件会卡到超时（2026-11-10 实测踩到两次）。
  mock.timers.reset()
})

test('plugin.log 超过上限会滚成 .1，不会无限增长', async () => {
  // 直接测 appendLogLine 的行为：写入前若已超上限，应先滚成 .1 再写。
  const { appendFileSync, existsSync, statSync, rmSync } = await import('node:fs')
  const { appendLogLine } = await import('../index.js')
  assert.equal(typeof appendLogLine, 'function', 'appendLogLine 需可测（导出）')

  const dir = mkdtempSync(join(tmpdir(), 'rs-log-'))
  const file = join(dir, 'plugin.log')
  // 造一个刚好超过 2 MB 的文件
  appendFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 10), 'utf8')
  const before = statSync(file).size
  assert.ok(before > 2 * 1024 * 1024)

  appendLogLine(file, 'a new line' + String.fromCharCode(10))

  // 滚过之后原文件应当是新的小文件，历史留在 .1
  assert.ok(statSync(file).size < 1024, `滚动后当前文件应很小，实际 ${statSync(file).size}`)
  assert.ok(existsSync(`${file}.1`), '应保留一份 .1 历史')
})

test('readJsonBody 拒绝超过上限的请求体', async () => {
  // 真实缺陷：这个函数把请求体全量攒进内存再解析，没有上限。门禁挡住了
  // 外部网页，但本机任意进程都能 POST 一个超大 body 把宿主堆打满。
  const { readJsonBody, MAX_JSON_BODY_BYTES } = (await import('../index.js')).__test
  assert.equal(typeof readJsonBody, 'function')
  assert.ok(MAX_JSON_BODY_BYTES > 0)

  // 造一个可异步迭代的假 req
  const 造假req = (chunks) => {
    let i = 0
    let destroyed = false
    return {
      [Symbol.asyncIterator]: () => ({ next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) }),
      destroy() { destroyed = true },
      get 已销毁() { return destroyed },
    }
  }

  // 1) 正常大小：应当解析成功
  const 小 = 造假req([Buffer.from(JSON.stringify({ countdownSec: 5 }))])
  assert.deepEqual(await readJsonBody(小), { countdownSec: 5 })
  assert.equal(小.已销毁, false, '正常请求不应被销毁')

  // 2) 超限：应当返回 {}，并且连接被销毁
  const 大 = 造假req([Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 0x61)])
  assert.deepEqual(await readJsonBody(大), {}, '超限请求体必须被拒绝')
  assert.equal(大.已销毁, true, '超限时必须主动断开连接')

  // 3) 分块累计超限也要拦住（不能只看单块大小）
  const 分块 = 造假req([Buffer.alloc(40 * 1024, 0x61), Buffer.alloc(40 * 1024, 0x61)])
  assert.deepEqual(await readJsonBody(分块), {}, '分块累计超限也必须拒绝')
  assert.equal(分块.已销毁, true)
})

test('坏清单隔离文件只保留最近 3 份，不会无限累积', async () => {
  // 真实缺陷：每次读到坏清单就 rename 成 roster.json.corrupt-<时间戳> 留证，
  // 但从不清扫 —— 反复损坏会在 state 目录里堆出一堆同名前缀文件。
  const { readRoster, rosterPath, ROSTER_FILE_NAME } = await import('../core/roster.js')
  const { writeFileSync, readdirSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'rs-corrupt-'))
  const 前缀 = `${ROSTER_FILE_NAME}.corrupt-`

  // 连续写坏 8 次，每次都会产生一个隔离文件
  for (let i = 0; i < 8; i += 1) {
    writeFileSync(rosterPath(dir), '{ this is not json', 'utf8')
    const { roster, warnings } = readRoster(dir)
    assert.equal(roster, null)
    assert.ok(warnings.some((w) => w.includes('坏清单')), `第 ${i + 1} 次应报告坏清单`)
    // 时间戳是 Date.now()，同一毫秒内可能重名，稍等一下保证排序可区分
    await new Promise((r) => setTimeout(r, 2))
  }

  const 剩余 = readdirSync(dir).filter((n) => n.startsWith(前缀))
  assert.ok(
    剩余.length <= 3,
    `隔离文件应最多保留 3 份，实际 ${剩余.length} 份：${剩余.join(', ')}`,
  )
  assert.ok(剩余.length > 0, '至少应保留 1 份供排查')
})

test('收尾窗口放行后必须真正往下走，不能出现「0 处在忙却放弃重启」', async () => {
  // 真实缺陷（2026-11-10 实测）：放行逻辑原本写在 `if (blockersAtEnd.length > 0)`
  // 块**内部**——它把数组清空了，但控制流仍在块内，于是接着执行了「放弃重启」
  // 分支，日志出现荒谬的「倒计时结束时仍有 0 处在忙，放弃重启」。
  //
  // 这里用源码结构断言钉住顺序：放行判断必须在那个 if 之前。
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(包根, 'index.js'), 'utf8')

  const 放行 = src.indexOf('if (options.fromSettle && blockersAtEnd.length > 0)')
  const if块 = src.indexOf('if (blockersAtEnd.length > 0) {')

  assert.ok(放行 > 0, '必须存在收尾窗口放行判断')
  assert.ok(if块 > 0, '必须存在 blockersAtEnd 判空块')
  assert.ok(
    放行 < if块,
    '放行判断必须写在 `if (blockersAtEnd.length > 0)` 之前，' +
      '否则清空数组后仍会执行块内的「放弃重启」分支',
  )

  // 并且放行分支里必须真的清空，不能只打日志
  const 片段 = src.slice(放行, if块)
  assert.match(片段, /blockersAtEnd\.length = 0/, '放行时必须清空阻塞项，否则会继续走放弃分支')
})
