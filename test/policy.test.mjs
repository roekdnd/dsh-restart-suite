/**
 * 判定策略：判忙 / 三档分类 / 保护期。
 *
 * 从 dsh-autonomous-restart 搬来，行为必须一字不差 ——
 * 所以这些测试是从旧包对应的测试改写来的，不是新写的期望。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyStrangers,
  collectBlockers,
  earlyGoGraceFor,
  isSelfBlocker,
  isWaiterBlocker,
  safeList,
} from '../core/policy.js'

const NOW = 1_700_000_000_000

/** 造一个只含 agents 的假 services。 */
function 造服务({ agents = [], jobs = [], sessionActivity } = {}) {
  return {
    agents: agents.length > 0 ? { list: () => agents } : undefined,
    jobs: jobs.length > 0 ? { list: (owner) => (owner ? [] : jobs) } : undefined,
    sessionActivity,
  }
}

const mk = (id, status = 'running') => ({ id, status, inbox: { nextTurn: [], nextStep: [] } })

test('runing 的 agent 计入阻塞项', async () => {
  const b = await collectBlockers(造服务({ agents: [mk('session-A', 'running')] }))
  assert.equal(b.length, 1)
  assert.equal(b[0].kind, 'agent')
  assert.equal(b[0].id, 'session-A')
})

test('idle 的 agent 不算阻塞', async () => {
  const b = await collectBlockers(造服务({ agents: [mk('session-A', 'idle')] }))
  assert.equal(b.length, 0)
})

test('拿不到 agents 服务 → 按忙处理（宁可不动手）', async () => {
  const b = await collectBlockers(造服务({}))
  assert.equal(b.length, 1)
  assert.match(b[0].label, /拿不到 agents 服务/)
})

test('读不到 status → 当它在跑', async () => {
  const agent = { id: 'session-X', inbox: {}, get status() { throw new Error('boom') } }
  const b = await collectBlockers(造服务({ agents: [agent] }))
  assert.equal(b.length, 1)
})

test('inbox 非空（idle 但压着消息）→ 阻塞', async () => {
  const agent = { id: 'session-A', status: 'idle', inbox: { nextTurn: [{ id: 1 }], nextStep: [] } }
  const b = await collectBlockers(造服务({ agents: [agent] }))
  assert.equal(b.length, 1)
  assert.equal(b[0].kind, 'queued')
})

test('已武装的定时提醒 → 阻塞', async () => {
  const b = await collectBlockers(
    造服务({
      agents: [mk('session-A', 'idle')],
      sessionActivity: async () => [{ kind: 'schedule' }],
    }),
  )
  assert.equal(b.length, 1)
  assert.equal(b[0].kind, 'schedule')
})

test('后台 job running/stopping → 阻塞；其它状态不算', async () => {
  const running = await collectBlockers(造服务({ agents: [], jobs: [{ id: 'j1', status: 'running', label: '打包' }] }))
  // agents 为空时没有 agents 服务 → 会多一条「拿不到 agents」
  assert.ok(running.some((x) => x.kind === 'job'))

  const done = await collectBlockers(造服务({ agents: [], jobs: [{ id: 'j2', status: 'done' }] }))
  assert.ok(!done.some((x) => x.kind === 'job'))
})

test('job label 截断到 60 字并取首行（避免撑爆提示页）', async () => {
  const longLabel = '第一行很长很长\n第二行' + 'x'.repeat(100)
  const b = await collectBlockers(造服务({ agents: [], jobs: [{ id: 'j3', status: 'running', label: longLabel }] }))
  const job = b.find((x) => x.kind === 'job')
  assert.equal(job.label, '第一行很长很长')
})

test('classifyStrangers：job/queued/schedule 永远硬拦', () => {
  for (const kind of ['job', 'queued', 'schedule']) {
    const { 硬拦 } = classifyStrangers([{ kind, id: 'x', label: 'x' }], new Set(), new Map(), NOW, new Map())
    assert.equal(硬拦.length, 1, `${kind} 必须硬拦`)
  }
})

test('classifyStrangers：这一轮已结束的无关会话 → 软拦', () => {
  const 起点 = new Map([['session-old', NOW - 20 * 60 * 1000]])
  const 结束 = new Map([['session-old', NOW - 60 * 1000]])
  const { 硬拦, 软拦 } = classifyStrangers(
    [{ kind: 'agent', id: 'session-old', label: '跑着' }],
    new Set(),
    起点,
    NOW,
    结束,
  )
  assert.equal(硬拦.length, 0)
  assert.equal(软拦.length, 1)
})

test('classifyStrangers：这一轮未结束 → 硬拦（跑得久也不行）', () => {
  const 起点 = new Map([['session-busy', NOW - 30 * 60 * 1000]])
  const 结束 = new Map([['session-busy', NOW - 31 * 60 * 1000]]) // 结束早于起点 → 不算
  const { 硬拦 } = classifyStrangers(
    [{ kind: 'agent', id: 'session-busy', label: '跑着' }],
    new Set(),
    起点,
    NOW,
    结束,
  )
  assert.equal(硬拦.length, 1)
})

test('isSelfBlocker：只认 agent/queued/schedule 且 id 匹配', () => {
  assert.equal(isSelfBlocker({ kind: 'agent', id: 'me' }, 'me'), true)
  assert.equal(isSelfBlocker({ kind: 'job', id: 'me' }, 'me'), false, 'job 不算自己')
  assert.equal(isSelfBlocker({ kind: 'agent', id: 'other' }, 'me'), false)
})

test('isWaiterBlocker：等待者自己不算别人', () => {
  assert.equal(isWaiterBlocker({ kind: 'agent', id: 'A' }, new Set(['A'])), false)
  assert.equal(isWaiterBlocker({ kind: 'agent', id: 'B' }, new Set(['A'])), true)
  assert.equal(isWaiterBlocker({ kind: 'job', id: 'A' }, new Set(['A'])), true, 'job 一律算别人')
})

test('保护期自适应：min(5 秒, 倒计时/2)', () => {
  assert.equal(earlyGoGraceFor(3), 1500)
  assert.equal(earlyGoGraceFor(5), 2500)
  assert.equal(earlyGoGraceFor(10), 5000)
  assert.equal(earlyGoGraceFor(60), 5000)
})

test('safeList：服务缺失或抛错都返回空数组', () => {
  assert.deepEqual(safeList(undefined), [])
  assert.deepEqual(safeList({ list() { throw new Error('x') } }), [])
  assert.deepEqual(safeList({ list: () => [1, 2] }), [1, 2])
})
