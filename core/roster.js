/**
 * restart-suite —— 重启清单（Roster）。
 *
 * 这是整个套件的**单一事实来源**：一次重启里「要唤醒谁、说什么、投递到哪一步」，
 * 全部记在这一个文件里。
 *
 * 为什么不再用三份文件（wake-request / wake-extra / ledger）：
 *   三份各管各的，幂等键不同、清理时机不同，导致「同一次重启里同一个会话
 *   会不会收到两条消息」这件事无法从数据上回答。一份清单 + 一种幂等键，
 *   结构上就不可能出现重复。
 *
 * 三种 role：
 *   initiator —— 触发这次重启的会话（调了 restart_dsh / 点了按钮）
 *   waiter    —— 也表达了重启意愿、一起等的会话
 *   bystander —— 没表达意愿，但会被这次重启打断的会话
 *
 * 投递内容按 role 决定：
 *   initiator / waiter → 用它自己的 text（autoSay）
 *   bystander          → text 为 null，由插件生成「先核对再继续」
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ROSTER_FILE_NAME = 'roster.json'
export const ROSTER_SCHEMA = 1

/** 一次重启的合法阶段。 */
export const PHASES = ['starting', 'ready', 'delivering', 'done']

/** 合法 role。 */
export const ROLES = ['initiator', 'waiter', 'bystander']

export function rosterPath(stateDir) {
  return join(stateDir, ROSTER_FILE_NAME)
}

/** 一份空清单。 */
export function createRoster({ runId, trigger, command = '', requestedAt = Date.now() } = {}) {
  return {
    schema: ROSTER_SCHEMA,
    runId: String(runId ?? ''),
    phase: 'starting',
    trigger: trigger === 'button' ? 'button' : 'tool',
    command: String(command ?? ''),
    requestedAt: Number(requestedAt) || Date.now(),
    startedAt: 0,
    sessions: [],
  }
}

/**
 * 校验并归一一个清单对象。
 *
 * 原则：**逐字段修正，不整份拒收**。清单是崩溃恢复的唯一依据，
 * 因为一个字段脏就整份丢掉，等于把所有人的唤醒词一起丢掉。
 *
 * @returns {{roster: object, warnings: string[]}}
 */
export function normalizeRoster(raw) {
  const warnings = []
  if (!raw || typeof raw !== 'object') {
    return { roster: null, warnings: ['清单不是对象'] }
  }

  const phase = PHASES.includes(raw.phase) ? raw.phase : 'starting'
  if (!PHASES.includes(raw.phase)) warnings.push(`phase 非法（${String(raw.phase)}），按 starting 处理`)

  const sessions = []
  const seen = new Set()
  let 丢弃 = 0
  for (const item of Array.isArray(raw.sessions) ? raw.sessions : []) {
    if (!item || typeof item !== 'object') {
      丢弃 += 1
      continue
    }
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id) {
      丢弃 += 1
      continue
    }
    if (seen.has(id)) {
      // 同一会话在一份清单里只能有一条 —— 这正是「不重复投递」的根基
      丢弃 += 1
      warnings.push(`重复的会话 ${id}，只保留第一条`)
      continue
    }
    seen.add(id)
    const role = ROLES.includes(item.role) ? item.role : 'bystander'
    if (!ROLES.includes(item.role)) warnings.push(`会话 ${id} 的 role 非法（${String(item.role)}），按 bystander 处理`)
    sessions.push({
      id,
      role,
      // 只有 initiator/waiter 才有自定义文案；bystander 一律由插件生成
      text: role === 'bystander' ? null : typeof item.text === 'string' ? item.text : '',
      turn: Number(item.turn) > 0 ? Number(item.turn) : 0,
      deliveredAt: Number(item.deliveredAt) > 0 ? Number(item.deliveredAt) : 0,
      attempts: Number(item.attempts) > 0 ? Number(item.attempts) : 0,
    })
  }
  if (丢弃 > 0) warnings.push(`丢弃 ${丢弃} 条无效会话记录`)

  return {
    roster: {
      schema: ROSTER_SCHEMA,
      runId: typeof raw.runId === 'string' ? raw.runId : '',
      phase,
      trigger: raw.trigger === 'button' ? 'button' : 'tool',
      command: typeof raw.command === 'string' ? raw.command : '',
      requestedAt: Number(raw.requestedAt) || 0,
      startedAt: Number(raw.startedAt) || 0,
      sessions,
    },
    warnings,
  }
}

/**
 * 原子写：先写 `.tmp` 再 rename。
 *
 * 为什么不用直接 writeFileSync：清单是崩溃恢复的唯一依据，
 * 写到一半掉电就会得到一份坏 JSON，而坏 JSON 等于所有人都不被唤醒。
 */
export function writeRoster(stateDir, roster) {
  const file = rosterPath(stateDir)
  const tmp = file + '.tmp'
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(roster, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 忽略
    }
    return false
  }
}

/**
 * 读清单。文件不存在 → null；内容坏掉 → null 并把原文件改名留证。
 *
 * @returns {{roster: object|null, warnings: string[]}}
 */
export function readRoster(stateDir, { quarantine = true } = {}) {
  const file = rosterPath(stateDir)
  if (!existsSync(file)) return { roster: null, warnings: [] }

  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { roster: null, warnings: ['清单读取失败'] }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    const warnings = ['清单不是合法 JSON']
    if (quarantine) {
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`)
        warnings.push('坏清单已改名留存，便于排查')
      } catch {
        warnings.push('坏清单改名失败')
      }
    }
    return { roster: null, warnings }
  }

  const { roster, warnings } = normalizeRoster(parsed)
  return { roster, warnings }
}

export function clearRoster(stateDir) {
  try {
    rmSync(rosterPath(stateDir), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 加一个会话进清单（同 id 只保留一条；已存在则按需更新）。
 *
 * @returns {{added: boolean, reason?: string}}
 */
export function upsertSession(roster, { id, role, text = '', turn = 0 }) {
  const sid = String(id ?? '').trim()
  if (!sid) return { added: false, reason: '缺少 sessionId' }
  const 合法role = ROLES.includes(role) ? role : 'bystander'

  const existing = roster.sessions.find((s) => s.id === sid)
  if (existing) {
    // 角色只能「升格」，不能降格：已经是 initiator 的不会被后来的 bystander 覆盖
    const 权重 = { bystander: 0, waiter: 1, initiator: 2 }
    if (权重[合法role] > 权重[existing.role]) existing.role = 合法role
    if (合法role !== 'bystander' && typeof text === 'string' && text.trim()) {
      existing.text = text.trim()
    }
    if (Number(turn) > 0 && existing.turn === 0) existing.turn = Number(turn)
    return { added: false, reason: '已存在，已合并' }
  }

  roster.sessions.push({
    id: sid,
    role: 合法role,
    text: 合法role === 'bystander' ? null : typeof text === 'string' ? text : '',
    turn: Number(turn) > 0 ? Number(turn) : 0,
    deliveredAt: 0,
    attempts: 0,
  })
  return { added: true }
}

/** 标一条为已投递（幂等的第二层：文件层）。 */
export function markDelivered(roster, id) {
  const item = roster.sessions.find((s) => s.id === String(id))
  if (!item) return false
  item.deliveredAt = Date.now()
  item.attempts = (item.attempts || 0) + 1
  return true
}

/** 记一次失败尝试（不置 deliveredAt）。 */
export function markAttempt(roster, id) {
  const item = roster.sessions.find((s) => s.id === String(id))
  if (!item) return false
  item.attempts = (item.attempts || 0) + 1
  return true
}

/**
 * 这是幂等的**第一层**：为一条会话算出稳定的 requestId。
 *
 * 两种角色的算法不同，各自沿用原来那套（不新发明）：
 *   initiator / waiter → restart-wake-<runId>-<sessionId>
 *   bystander          → continue-after-interrupted-<sessionId>-<turn>-self
 *
 * 关键：**同一个会话在同一次重启里，无论重试多少次，requestId 恒定**。
 * 宿主按 requestId 去重，所以重复投递不会真的插进两条消息。
 */
export function requestIdFor(roster, session) {
  const runId = roster?.runId ?? ''
  const id = String(session?.id ?? '')
  if (!id) return ''
  if (session.role === 'bystander') {
    const turn = Number(session.turn) > 0 ? Number(session.turn) : 0
    // 拿不到 turn 时用 runId 兜底 —— 绝不能退化成 Date.now()，那等于关掉幂等
    const 后缀 = turn > 0 ? String(turn) : `run-${runId || 'x'}`
    return `continue-after-interrupted-${id}-${后缀}-self`
  }
  return `restart-wake-${runId || 'adhoc'}-${id}`
}

/** 还没投递的会话。 */
export function pendingSessions(roster) {
  return (roster?.sessions ?? []).filter((s) => s.deliveredAt === 0)
}

/** 清单里是否还有人在等（用于启动后决定要不要继续投递）。 */
export function hasPending(roster) {
  return pendingSessions(roster).length > 0
}
