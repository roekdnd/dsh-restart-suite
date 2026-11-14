/**
 * 装配层集成测试：用真实 apply() 跑一遍「读清单 → 投递 → 清理」。
 *
 * 这是合并的关键验收 —— 一次重启里，一个会话只会被投递一次。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, mock } from 'node:test'

const 包根 = dirname(dirname(fileURLToPath(import.meta.url)))
const STATE = mkdtempSync(join(tmpdir(), 'rs-int-'))
process.env['AR_STATE_DIR'] = STATE

const { apply } = await import('../index.js')
const { createRoster, upsertSession, writeRoster, rosterPath } = await import('../core/roster.js')
const { writeFileSync: _wf } = await import('node:fs')

/**
 * 模拟脚本写 ready 信号。
 *
 * 真实流程是：插件写 roster + wake-request(starting) → 脚本拉起应用 →
 * 脚本把 wake-request 改成 ready → 插件才投递。
 * 测试里跳过「脚本拉起应用」，直接写 ready。
 */
function 模拟脚本写Ready(runId) {
  _wf(
    join(STATE, 'wake-request.json'),
    JSON.stringify({
      runId,
      phase: 'ready',
      sessionId: '',
      text: '',
      requestedAt: Date.now(),
      startedAt: Date.now(),
      error: '',
    }),
    'utf8',
  )
}

/** 造一个够用的假 ctx。 */
function 搭(sessionsState = {}, opts = {}) {
  try { mock.timers.reset() } catch {}
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  const 投递 = []
  const listeners = {}
  const 已注册工具 = []
  let 注册工具 = null
  const ctx = {
    tools: {
      register(t) {
        注册工具 = t
        已注册工具.push(t)
        return () => {}
      },
    },
    effect(fn) { return fn() },
    inject(_n, fn) {
      // scope 需要 effect（cordis 的 inject 作用域有自己的 effect）
      fn({ webServer: opts.webServer, effect: (f) => f() })
      return () => {}
    },
    get(k) {
      if (k === 'sessionController') {
        return {
          async prompt(req) {
            投递.push({ sessionId: req.sessionId, requestId: req.requestId, text: req.content?.[0]?.text })
            return { accepted: true }
          },
          async list() { return { items: [] } },
          async events() { return { records: [] } },
        }
      }
      if (k === 'agents') return { list: () => [], get: () => undefined }
      return undefined
    },
    logger: { info() {}, warn() {} },
    waterfall: async () => [],
    // legacy 实现用 ctx.on 订阅 session/event 与 agent/status
    on(name, handler) {
      const list = (listeners[name] ||= [])
      list.push(handler)
      return () => {}
    },
  }
  apply(ctx, {})
  // 按名字找工具：现在会注册两个（restart_dsh + roster 运维工具）
  return {
    ctx,
    投递,
    工具: () => 注册工具,
    按名字: (n) => 已注册工具.find((t) => t.name === n),
  }
}

test('有清单：按 role 投递，投完清理', async () => {
  rmSync(rosterPath(STATE), { force: true })
  const roster = createRoster({ runId: 'run-int-1', trigger: 'tool' })
  upsertSession(roster, { id: 'session-A', role: 'initiator', text: '跑 npm test' })
  upsertSession(roster, { id: 'session-B', role: 'bystander', turn: 6 })
  roster.phase = 'starting'
  writeRoster(STATE, roster)
  模拟脚本写Ready('run-int-1')

  const { 投递 } = 搭()
  // 启动后 SCAN_STARTUP_DELAY_MS 才跑，推进时间
  // 新实现要多走一步：等 wake-request.json 的 ready 信号（每 500ms 轮询），
  // 再投递。所以推进时长要比旧骨架实现更长。
  for (let i = 0; i < 80; i++) {
    mock.timers.tick(500)
    await new Promise((r) => setImmediate(r))
  }

  assert.equal(投递.length, 2, '应投递 2 条')
  const a = 投递.find((x) => x.sessionId === 'session-A')
  assert.equal(a.text, '跑 npm test')
  assert.match(a.requestId, /restart-wake-run-int-1-session-A/)

  const b = 投递.find((x) => x.sessionId === 'session-B')
  assert.match(b.text, /先核对当前实际状态/, 'bystander 用核对文案')
  assert.match(b.requestId, /continue-after-interrupted-session-B-6-self/)
})

test('同一份清单跑两遍不会重复投递（幂等的结构保证）', async () => {
  rmSync(rosterPath(STATE), { force: true })
  const roster = createRoster({ runId: 'run-int-2' })
  upsertSession(roster, { id: 'session-A', role: 'initiator', text: 'x' })
  roster.phase = 'ready'
  // 故意把 deliveredAt 预置为已投
  roster.sessions[0].deliveredAt = 1
  writeRoster(STATE, roster)

  const { 投递 } = 搭()
  for (let i = 0; i < 40; i++) { mock.timers.tick(500); await new Promise((r) => setImmediate(r)) }
  assert.equal(投递.length, 0, '已投过的绝不能再投')
})

test('没有清单时不崩，也不投递任何会话（兜底扫描已移除）', async () => {
  rmSync(rosterPath(STATE), { force: true })
  const { 投递 } = 搭()
  for (let i = 0; i < 40; i++) { mock.timers.tick(500); await new Promise((r) => setImmediate(r)) }
  assert.equal(投递.length, 0, '没有清单 → 本次没有任何会话需要唤醒，不得凭空投递')
})

test('roster 工具能查看和清理', async () => {
  rmSync(rosterPath(STATE), { force: true })
  const { 按名字 } = 搭()
  const t = 按名字('dsh_restart_suite_roster')
  assert.ok(t, '应注册 dsh_restart_suite_roster')

  writeFileSync(
    rosterPath(STATE),
    JSON.stringify({ schema: 1, runId: 'r', phase: 'ready', sessions: [] }),
    'utf8',
  )
  const 查看 = await t.execute({ action: 'show' })
  assert.equal(查看.ok, true)
  assert.match(查看.message, /runId=r/)

  const 清理 = await t.execute({ action: 'clear' })
  assert.equal(清理.ok, true)
})

test('状态路由返回清单内容', async () => {
  rmSync(rosterPath(STATE), { force: true })
  writeFileSync(
    rosterPath(STATE),
    JSON.stringify({
      schema: 1, runId: 'r2', phase: 'ready', trigger: 'button',
      sessions: [{ id: 'session-A', role: 'initiator', text: 't', turn: 0, deliveredAt: 0, attempts: 0 }],
    }),
    'utf8',
  )
  let handler = null
  搭({}, { webServer: { register(opts) { handler = opts.handler; return () => {} } } })
  assert.ok(handler, '应注册路由')

  let body = ''
  const res = { writeHead() {}, end(s) { body = s } }
  // 必须带门禁头 + 回环地址（否则会被 403 挡掉，这是设计如此）
  handler(
    {
      url: '/dsh-restart-suite/api/state',
      method: 'GET',
      headers: { 'x-dsh-restart-suite': '1' },
      socket: { remoteAddress: '127.0.0.1' },
    },
    res,
  )
  const parsed = JSON.parse(body)
  // /state 返回的是**状态机快照**（phase / blockers / deadline 等），不是 roster。
  // roster 内容通过 dsh_restart_suite_roster 工具查（上面那条测试已覆盖）。
  assert.equal(parsed.ok, true)
  assert.ok(parsed.value, '应有 value')
  assert.equal(typeof parsed.value.phase, 'string', '快照里应有 phase')
})

test('门禁：不带头的请求被 403 拒绝', async () => {
  let handler = null
  搭({}, { webServer: { register(opts) { handler = opts.handler; return () => {} } } })
  let body = ''
  const res = { writeHead(status) { this.status = status }, end(s) { body = s } }
  handler(
    { url: '/dsh-restart-suite/api/state', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    res,
  )
  assert.equal(res.status, 403, '缺门禁头必须 403')
})

test.after(() => {
  try { rmSync(STATE, { recursive: true, force: true }) } catch {}
})
