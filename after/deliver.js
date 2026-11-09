/**
 * restart-suite —— 重启后的善后投递（after 层）。
 *
 * 这一层把原来两份互相不知情的逻辑合成一份：
 *   - autonomous-restart 投「唤醒词」给发起者（wake-request.json）
 *   - interrupted-resume 投「先核对再继续」给所有被打断的会话（ledger.json）
 *
 * 合并后按 roster 的 role 分配内容，一个会话在一次重启里**只会被投递一次**。
 *
 * ── 三种 role 的投递内容 ────────────────────────────────────────────
 *   initiator / waiter → 它自己的 text（autoSay）
 *                       没写 text 就用「已通过插件重启」
 *   bystander          → 插件生成的「先核对状态再继续」文案
 *                       （不能让没要求重启的人以为是自己要求的）
 * ── 幂等的三层 ──────────────────────────────────────────────────────
 *   1. requestId：同一次重启、同一个会话恒定（宿主按此去重）
 *   2. deliveredAt：投递成功立刻落盘（重启再崩也不会重复）
 *   3. phase：phase !== 'ready' 时不投递
 */

/** 发起者没写唤醒词时的默认文案。 */
export const DEFAULT_AUTOSAY = '已通过插件重启'

/**
 * 给被打断的会话（bystander）生成的文案。
 *
 * 刻意**不是**裸「继续」：重启可能发生在副作用操作中途，
 * 所以要它先核对实际状态，再决定从哪继续。
 */
export function buildBystanderText(turn) {
  const 轮次 = Number(turn) > 0 ? `turn ${Number(turn)}` : '上一轮'
  return [
    '[自动续跑 · 由 dsh 重启触发]',
    '',
    `上一轮（${ 轮次}）因 dsh 进程重启被强制中断，没有正常结束。`,
    '',
    '请按以下顺序继续：',
    '1. 先核对当前实际状态（工作区文件、git 状态、后台任务/子进程、已执行的外部操作），确认中断前哪些步骤真的完成了；',
    '2. 从中断处继续推进原任务；',
    '3. 不要去重做可能已产生副作用的操作（写文件、提交、推送、删除、发布、部署等）——若无法确认其是否已执行，先核实再决定；',
    '4. 如果核对后仍然无法判断状态，停止操作并向我报告现状与疑点。',
    '',
    '这是一条由插件自动注入的消息，不是新的需求。',
  ].join('\n')
}

/**
 * 一条会话该投什么内容。
 *
 * @returns {string} 非空文案
 */
export function textForSession(session) {
  if (!session) return DEFAULT_AUTOSAY
  if (session.role === 'bystander') return buildBystanderText(session.turn)
  const own = typeof session.text === 'string' ? session.text.trim() : ''
  return own.length > 0 ? own : DEFAULT_AUTOSAY
}

/**
 * 投递一条。返回 { ok, channel, error }。
 *
 * 通道优先级（沿用原实现）：
 *   1. sessionController.prompt(request, signal) —— 能自己把冷会话 resume 起来
 *   2. agent.followup()                        —— 要求 agent 已在跑，只当兜底
 *
 * ⚠️ requestId 必须由调用方传入（来自 roster 的 requestIdFor），
 * 绝不能在函数内部用 Date.now() 生成 —— 那样每次重试都是新 id，
 * 等于把宿主侧的幂等彻底关掉（2026-11-09 踩过）。
 */
export async function deliverOne({ getService, sessionId, text, requestId }) {
  if (!sessionId) return { ok: false, channel: '', error: '缺少 sessionId' }
  if (!requestId) return { ok: false, channel: '', error: '缺少 requestId（幂等键）' }

  try {
    const controller = getService('sessionController')
    if (controller && typeof controller.prompt === 'function') {
      await controller.prompt(
        { sessionId, content: [{ type: 'text', text }], requestId },
        new AbortController().signal,
      )
      return { ok: true, channel: 'sessionController', error: '' }
    }

    const agent = getService('agents')?.get?.(sessionId)
    if (agent && typeof agent.followup === 'function') {
      await agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      return { ok: true, channel: 'agent.followup', error: '' }
    }

    return { ok: false, channel: '', error: '无可用投递通道' }
  } catch (err) {
    return { ok: false, channel: '', error: String(err?.message ?? err) }
  }
}

/**
 * 按 roster 把还没投递的会话逐个投掉。
 *
 * 顺序：initiator → waiter → bystander。
 * 理由：发起者最急（它在等结果），旁观者即使晚一点被唤醒也没有损失。
 *
 * 每条独立 try：一个失败不影响其它人 —— 这是「宁可漏一个，也不能全挂」。
 *
 * @param {object} opts
 * @param {object} opts.roster 清单（会被就地更新，调用方负责落盘）
 * @param {function} opts.getService 取宿主服务
 * @param {function} opts.log 写日志
 * @param {function} [opts.onDelivered] 每条成功后回调（用于落盘）
 * @returns {{attempted:number, delivered:number, failed:number, skipped:number, details:Array}}
 */
export async function deliverAll({ roster, getService, log, onDelivered, requestIdFor }) {
  const 结果 = { attempted: 0, delivered: 0, failed: 0, skipped: 0, details: [] }
  if (!roster || !Array.isArray(roster.sessions)) return 结果

  const 顺序 = ['initiator', 'waiter', 'bystander']
  const 排好 = [...roster.sessions].sort(
    (a, b) => 顺序.indexOf(a.role) - 顺序.indexOf(b.role),
  )

  for (const s of 排好) {
    // 第二层幂等：已经投过就跳过
    if (s.deliveredAt > 0) {
      结果.skipped += 1
      continue
    }
    结果.attempted += 1

    const text = textForSession(s)
    const requestId = typeof requestIdFor === 'function' ? requestIdFor(roster, s) : ''
    const r = await deliverOne({ getService, sessionId: s.id, text, requestId })

    if (r.ok) {
      s.deliveredAt = Date.now()
      s.attempts = (s.attempts || 0) + 1
      结果.delivered += 1
      结果.details.push({ id: s.id, role: s.role, ok: true, channel: r.channel, requestId })
      log?.(`投递完成【${s.role}】target=${s.id} requestId=${requestId} 通道=${r.channel}`)
      if (typeof onDelivered === 'function') {
        try {
          onDelivered(roster, s)
        } catch {
          // 落盘失败不该中断投递
        }
      }
    } else {
      s.attempts = (s.attempts || 0) + 1
      结果.failed += 1
      结果.details.push({ id: s.id, role: s.role, ok: false, error: r.error, requestId })
      log?.(`投递失败【${s.role}】target=${s.id} requestId=${requestId} 错误=${r.error}`)
    }
  }

  return 结果
}
