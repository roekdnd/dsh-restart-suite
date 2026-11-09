/**
 * 善后投递：三种 role 的内容 + 幂等三层。
 *
 * 这是合并的核心价值 —— 一次重启里，一个会话**只会**被投递一次。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildBystanderText,
  deliverAll,
  deliverOne,
  textForSession,
  DEFAULT_AUTOSAY,
} from '../after/deliver.js'
import { createRoster, requestIdFor, upsertSession } from '../core/roster.js'

/** 造一个记录调用的假 getService。 */
function 造服务({ failFor = [], noChannel = false } = {}) {
  const 记录 = []
  const getService = (key) => {
    if (noChannel) return undefined
    if (key === 'sessionController') {
      return {
        async prompt(req) {
          记录.push({ channel: 'sessionController', sessionId: req.sessionId, requestId: req.requestId, text: req.content?.[0]?.text })
          if (failFor.includes(req.sessionId)) throw new Error('模拟失败')
          return { accepted: true }
        },
      }
    }
    if (key === 'agents') {
      return {
        get: (id) => ({
          async followup(msg) {
            记录.push({ channel: 'agent.followup', sessionId: id, text: msg.content?.[0]?.text })
            if (failFor.includes(id)) throw new Error('模拟失败')
          },
        }),
      }
    }
    return undefined
  }
  return { 记录, getService }
}

test('bystander 的文案是「先核对再继续」，不是裸「继续」', () => {
  const t = buildBystanderText(6)
  assert.match(t, /自动续跑/)
  assert.match(t, /turn 6/)
  assert.match(t, /先核对当前实际状态/)
  assert.match(t, /不要去重做可能已产生副作用的操作/)
  assert.ok(!t.trim().startsWith('继续'), '不能是裸「继续」')
})

test('三种 role 的内容各不相同', () => {
  const init = textForSession({ role: 'initiator', text: '跑 npm test', turn: 0 })
  const wait = textForSession({ role: 'waiter', text: '你的改动已生效', turn: 0 })
  const byst = textForSession({ role: 'bystander', turn: 6 })
  assert.equal(init, '跑 npm test')
  assert.equal(wait, '你的改动已生效')
  assert.match(byst, /先核对/)
})

test('发起者没写 text → 用默认唤醒词（不能是空字符串）', () => {
  assert.equal(textForSession({ role: 'initiator', text: '' }), DEFAULT_AUTOSAY)
  assert.equal(textForSession({ role: 'initiator', text: '   ' }), DEFAULT_AUTOSAY)
})

test('deliverOne 缺少 requestId 就拒绝（幂等键不能缺）', async () => {
  const { getService } = 造服务()
  const r = await deliverOne({ getService, sessionId: 'session-A', text: 'x', requestId: '' })
  assert.equal(r.ok, false)
  assert.match(r.error, /requestId/)
})

test('deliverOne 优先 sessionController，退回 agent.followup', async () => {
  const { getService, 记录 } = 造服务()
  const r1 = await deliverOne({ getService, sessionId: 'session-A', text: 'x', requestId: 'id-1' })
  assert.equal(r1.ok, true)
  assert.equal(r1.channel, 'sessionController')

  // 只提供 agents（没有 sessionController）
  const 只agents = (k) => (k === 'agents' ? { get: (id) => ({ async followup() { 记录.push({ channel: 'agent.followup' }) } }) } : undefined)
  const r2 = await deliverOne({ getService: 只agents, sessionId: 'session-B', text: 'y', requestId: 'id-2' })
  assert.equal(r2.ok, true)
  assert.equal(r2.channel, 'agent.followup')
})

test('deliverAll：一次重启里每个会话只投一次（哪怕重复跑一遍）', async () => {
  const { getService, 记录 } = 造服务()
  const roster = createRoster({ runId: 'run-1' })
  upsertSession(roster, { id: 'session-A', role: 'initiator', text: '跑测试' })
  upsertSession(roster, { id: 'session-B', role: 'bystander', turn: 6 })

  const 一 = await deliverAll({ roster, getService, log: () => {}, requestIdFor })
  assert.equal(一.delivered, 2)
  assert.equal(记录.length, 2)

  // 再跑一遍：应全部跳过，不产生重复投递
  const 二 = await deliverAll({ roster, getService, log: () => {}, requestIdFor })
  assert.equal(二.attempted, 0, '第二遍不该有任何尝试')
  assert.equal(二.skipped, 2)
  assert.equal(记录.length, 2, '总投递次数仍是 2，没有重复')
})

test('deliverAll 顺序：initiator → waiter → bystander', async () => {
  const { getService, 记录 } = 造服务()
  const roster = createRoster({ runId: 'run-2' })
  upsertSession(roster, { id: 'session-C', role: 'bystander', turn: 3 })
  upsertSession(roster, { id: 'session-B', role: 'waiter', text: 'w' })
  upsertSession(roster, { id: 'session-A', role: 'initiator', text: 'i' })

  await deliverAll({ roster, getService, log: () => {}, requestIdFor })
  assert.deepEqual(记录.map((r) => r.sessionId), ['session-A', 'session-B', 'session-C'])
})

test('deliverAll：一个失败不影响其它人', async () => {
  const { getService } = 造服务({ failFor: ['session-B'] })
  const roster = createRoster({ runId: 'run-3' })
  upsertSession(roster, { id: 'session-A', role: 'initiator', text: 'i' })
  upsertSession(roster, { id: 'session-B', role: 'waiter', text: 'w' })
  upsertSession(roster, { id: 'session-C', role: 'bystander', turn: 2 })

  const r = await deliverAll({ roster, getService, log: () => {}, requestIdFor })
  assert.equal(r.delivered, 2, 'A 和 C 应该成功')
  assert.equal(r.failed, 1, 'B 失败')
  const b = roster.sessions.find((s) => s.id === 'session-B')
  assert.equal(b.deliveredAt, 0, '失败的不该置 deliveredAt')
  assert.equal(b.attempts, 1, '失败要记 attempts')
})

test('无可用通道时不崩，记为失败', async () => {
  const { getService } = 造服务({ noChannel: true })
  const roster = createRoster({ runId: 'run-4' })
  upsertSession(roster, { id: 'session-A', role: 'initiator', text: 'i' })
  const r = await deliverAll({ roster, getService, log: () => {}, requestIdFor })
  assert.equal(r.failed, 1)
  assert.match(r.details[0].error, /无可用投递通道/)
})

test('投递成功会回调 onDelivered（供调用方落盘）', async () => {
  const { getService } = 造服务()
  const roster = createRoster({ runId: 'run-5' })
  upsertSession(roster, { id: 'session-A', role: 'initiator', text: 'i' })
  const 落盘 = []
  await deliverAll({
    roster,
    getService,
    log: () => {},
    requestIdFor,
    onDelivered: (_r, s) => 落盘.push(s.id),
  })
  assert.deepEqual(落盘, ['session-A'])
})

test('requestId 在投递时用的是 roster 算出的稳定值', async () => {
  const { getService, 记录 } = 造服务()
  const roster = createRoster({ runId: 'run-6' })
  upsertSession(roster, { id: 'session-A', role: 'initiator', text: 'i' })
  await deliverAll({ roster, getService, log: () => {}, requestIdFor })
  assert.equal(记录[0].requestId, 'restart-wake-run-6-session-A')
})
