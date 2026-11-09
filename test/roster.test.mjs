/**
 * Roster（重启清单）—— 整个套件的单一事实来源。
 *
 * 它要同时保证三件事：
 *   1. 一份清单里同一会话只有一条（结构上杜绝重复投递）
 *   2. requestId 跨重试恒定（宿主侧幂等的前提）
 *   3. 脏数据只丢那一条，不丢整份（崩溃恢复的唯一依据）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createRoster,
  markAttempt,
  markDelivered,
  normalizeRoster,
  pendingSessions,
  readRoster,
  requestIdFor,
  rosterPath,
  upsertSession,
  writeRoster,
  clearRoster,
} from '../core/roster.js'

const STATE = mkdtempSync(join(tmpdir(), 'rs-roster-'))

test('新建清单：phase=starting，sessions 为空', () => {
  const r = createRoster({ runId: 'run-1', trigger: 'tool' })
  assert.equal(r.phase, 'starting')
  assert.equal(r.trigger, 'tool')
  assert.equal(r.sessions.length, 0)
  assert.equal(r.schema, 1)
})

test('同一会话只能入清单一次（重复投递的结构性防线）', () => {
  const r = createRoster({ runId: 'run-2' })
  assert.equal(upsertSession(r, { id: 'session-A', role: 'initiator', text: '继续' }).added, true)
  assert.equal(upsertSession(r, { id: 'session-A', role: 'waiter', text: '再来一次' }).added, false)
  assert.equal(r.sessions.length, 1, '同一 id 不得出现两条')
})

test('角色只能升格不能降格（initiator 不会被后来的 bystander 覆盖）', () => {
  const r = createRoster({ runId: 'run-3' })
  upsertSession(r, { id: 'session-A', role: 'initiator', text: '最初的说法' })
  upsertSession(r, { id: 'session-A', role: 'bystander' })
  assert.equal(r.sessions[0].role, 'initiator')
  assert.equal(r.sessions[0].text, '最初的说法')
})

test('bystander 的 text 恒为 null（文案由插件生成，不许调用方指定）', () => {
  const r = createRoster({ runId: 'run-4' })
  upsertSession(r, { id: 'session-C', role: 'bystander', text: '我不该有自定义文案' })
  assert.equal(r.sessions[0].text, null)
})

test('requestId 跨重试恒定 —— 这是幂等第一层', () => {
  const r = createRoster({ runId: 'run-5' })
  upsertSession(r, { id: 'session-A', role: 'initiator' })
  const id1 = requestIdFor(r, r.sessions[0])
  // 模拟重试 5 次：每次都重新算
  const ids = new Set([id1, requestIdFor(r, r.sessions[0]), requestIdFor(r, r.sessions[0]), requestIdFor(r, r.sessions[0])])
  assert.equal(ids.size, 1)
  assert.equal(id1, 'restart-wake-run-5-session-A')
})

test('bystander 用 turn 算 requestId（沿用原 resume 算法）', () => {
  const r = createRoster({ runId: 'run-6' })
  upsertSession(r, { id: 'session-B', role: 'bystander', turn: 6 })
  assert.equal(requestIdFor(r, r.sessions[0]), 'continue-after-interrupted-session-B-6-self')
})

test('bystander 拿不到 turn 时用 runId 兜底，绝不退化成时间戳', () => {
  const r = createRoster({ runId: 'run-7' })
  upsertSession(r, { id: 'session-B', role: 'bystander' })   // 没给 turn
  const a = requestIdFor(r, r.sessions[0])
  const b = requestIdFor(r, r.sessions[0])
  assert.equal(a, b, '两次计算必须一致')
  assert.match(a, /run-7/, '应含 runId')
  assert.ok(!/\d{13}/.test(a), '不得出现 13 位时间戳（那等于关掉幂等）')
})

test('投递成功才置 deliveredAt；失败只记 attempts', () => {
  const r = createRoster({ runId: 'run-8' })
  upsertSession(r, { id: 'session-A', role: 'initiator' })
  const s = r.sessions[0]

  markAttempt(r, 'session-A')
  markAttempt(r, 'session-A')
  assert.equal(s.deliveredAt, 0, '失败不该置 deliveredAt')
  assert.equal(s.attempts, 2)

  markDelivered(r, 'session-A')
  assert.ok(s.deliveredAt > 0, '成功必须置 deliveredAt')
})

test('pendingSessions 只返回没投递过的', () => {
  const r = createRoster({ runId: 'run-9' })
  upsertSession(r, { id: 'session-A', role: 'initiator' })
  upsertSession(r, { id: 'session-B', role: 'waiter' })
  markDelivered(r, 'session-A')
  const pending = pendingSessions(r)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, 'session-B')
})

test('脏数据逐条丢弃，不整份拒收（崩溃恢复的唯一依据不能一丢全丢）', () => {
  const { roster, warnings } = normalizeRoster({
    runId: 'run-10',
    phase: 'ready',
    sessions: [
      { id: '', text: 'x' }, // 空 id
      { text: 'y' }, // 无 id
      { id: 'session-ok', role: 'initiator', text: 'z' },
      { id: 'session-ok', role: 'waiter' }, // 重复
      { id: 'session-bad', role: '不存在的角色' },
    ],
  })
  assert.equal(roster.sessions.length, 2, '只保留 2 条合法记录')
  assert.ok(roster.sessions.some((s) => s.id === 'session-ok'))
  assert.ok(roster.sessions.some((s) => s.id === 'session-bad'), 'role 非法要降级保留，不该丢')
  assert.equal(roster.sessions.find((s) => s.id === 'session-bad').role, 'bystander')
  assert.ok(warnings.length > 0, '应有告警')
})

test('空白清单（null）返回 null 而不是崩', () => {
  const { roster } = normalizeRoster(null)
  assert.equal(roster, null)
})

test('写读往返：原子写 + 能读回', () => {
  const r = createRoster({ runId: 'run-11', trigger: 'button' })
  upsertSession(r, { id: 'session-A', role: 'initiator', text: '继续' })
  r.phase = 'ready'

  assert.equal(writeRoster(STATE, r), true)
  const { roster } = readRoster(STATE)
  assert.equal(roster.runId, 'run-11')
  assert.equal(roster.phase, 'ready')
  assert.equal(roster.trigger, 'button')
  assert.equal(roster.sessions.length, 1)
  assert.equal(roster.sessions[0].text, '继续')
})

test('坏 JSON：返回 null，并把坏文件改名留证', () => {
  writeFileSync(rosterPath(STATE), '{ 这不是 json', 'utf8')
  const { roster, warnings } = readRoster(STATE)
  assert.equal(roster, null)
  assert.ok(warnings.some((w) => w.includes('不是合法 JSON')))
  const 残留 = readdirSync(STATE).filter((f) => f.includes('.corrupt-'))
  assert.equal(残留.length, 1, '坏清单应改名留存，不该直接删掉')
})

test('文件不存在时返回 null，不抛错', () => {
  clearRoster(STATE)
  const { roster } = readRoster(STATE)
  assert.equal(roster, null)
})

test.after(() => {
  try { rmSync(STATE, { recursive: true, force: true }) } catch {}
})
