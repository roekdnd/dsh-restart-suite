# dsh-restart-suite

重启应用：把原来三个独立插件合成为一个，由它掌控「重启 → 唤醒 → 续跑」全链路。

- `dsh-autonomous-restart` —— agent 调工具重启
- `dsh-restart-now` —— 用户点按钮重启
- `dsh-interrupted-resume` —— 重启后把被打断的会话叫醒

三者合并后共用**一份清单**（roster），从结构上杜绝「同一个会话在一次重启里被投递两次」。

## 两个入口，同一套判定

| 入口 | 触发 | 判定链路 |
|---|---|---|
| agent | 调 `restart_dsh` 工具 | 判忙 → 倒计时 → 等人齐 → 动手 |
| 按钮 | 点界面按钮（3 处：侧栏面板 / 会话标题栏 / 设置通用行） | `POST /restart` → **同一个 `tool.execute()`** |

**按钮不自己判断能不能重启**——它和 agent 走完全相同的链路，否则就成了绕过安全检查的后门。

## 只允许根会话触发

子代理（`session.header.origin === 'subagent'` 或有 `parentSession`）调 `restart_dsh` 会被拒绝：

> 子代理不能自己重启 应用。原因：你的父代理正在等你返回结果，
> 重启会把整棵树一起打断，父代理和你会互相等死。
>
> 正确做法：把「需要重启才能验证」这件事写进你返回给 Lead 的结果里，
> 由 Lead 汇总所有子代理结果后，自己调一次 restart_dsh。

读不到 `session.header` 时按根会话处理（宁可放行 Lead，也不误拒）。

## 一份清单（roster）

```json
{
  "runId": "mw97j3ld-f5lz6h",
  "phase": "ready",
  "sessions": [
    { "id": "session-A", "role": "initiator", "text": "跑 npm test", "deliveredAt": 0 },
    { "id": "session-B", "role": "waiter",    "text": "改动已生效",   "deliveredAt": 0 },
    { "id": "session-C", "role": "bystander", "turn": 6, "text": null, "deliveredAt": 0 }
  ]
}
```

| role | 谁 | 投递内容 |
|---|---|---|
| `initiator` | 触发这次重启的会话 | 它自己的 `autoSay` |
| `waiter` | 也表达了意愿、一起等的 | 它自己的 `autoSay` |
| `bystander` | 没表达意愿但会被打断的 | 插件生成的「先核对状态再继续」 |

### 幂等三层

1. **requestId**：`restart-wake-<runId>-<sessionId>` —— 跨重试恒定，宿主按它去重
2. **deliveredAt**：投递成功立刻落盘，重启再崩也不会重复
3. **phase**：`phase !== 'ready'` 时不投递

> 曾经 `requestId` 里带 `Date.now()`，每次重试都是新 id，等于把这层幂等彻底关掉
> （2026-11-09 修）。

## 判定策略

### 判忙（`core/policy.js`）

任一成立即算忙：

- agent `status === 'running'`
- `inbox.nextTurn` / `nextStep` 非空（排队消息）
- 有已武装的定时提醒（`session/activity` 瀑布里 `kind === 'schedule'`）
- 后台 job 处于 `running` / `stopping`
- 拿不到 `agents` 服务（无法确认空闲）

### 三档分类（`classifyStrangers`）

| 类型 | 判据 | 处理 |
|---|---|---|
| 硬拦 | job / 定时提醒 / 排队消息 / 服务不可用 | 永远等（不会自愈） |
| 硬拦 | 无关会话，**这一轮还没结束** | 等 |
| 软拦 | 无关会话，**这一轮已有 `turn/end`** | 放行，记日志 |

> 判据是「这一轮结不结束」，**不是「跑了多久」**。2026-11-09 实测推翻了
> 「跑久了就可以打断」这个启发式——被打断的会话 `resume.log` 显示 `0 resumed`，
> 用户只能手动点继续。

### 保护期（`earlyGoGraceFor`）

倒计时期间若「发起会话已说完 + 全机空闲」，可以提前动手，但要等满保护期：

```
保护期 = min(5 秒, countdownSec / 2)
```

| countdownSec | 保护期 |
|---|---|
| 3（最小） | 1.5 秒 |
| 5（默认） | 2.5 秒 |
| 10 | 5 秒 |
| ≥60 | 5 秒（上限） |

保护期是留给人的取消窗口。固定 5 秒会压过短倒计时——用户设 3 秒却要等 5 秒，
设置就形同虚设。

## 界面座位（7 个）

| 座位 | 用途 | order |
|---|---|---|
| `shell.overlay` | 倒计时 / 等待 / 终止页 | 100 |
| `settings.section` | 设置页（可编辑默认值） | 900 |
| `settings.section.icon` | 设置页导航行的图标（**id 必须等于 `settings.section` 的 id**，否则走 `navIcon()` 齿轮兜底） | — |
| `sidebar.panellist` | 侧栏左上角「重启应用」行 | 60 |
| `main` | 点上面那条后显示的面板（**key 必须等于 panellist 的 id**） | — |
| `conversation.session.header.actions` | 会话标题栏 ⟳ 按钮 | 15（< 20 才不被官方 jobs 挤右） |
| `settings.general.item` | 设置 → 通用 行 | 91 |

图标档位两处不同：`sidebar.panellist` 用 **regular（1）**（与「更多」同列同档），
`settings.section.icon` 用 **medium（1.3）**（与官方 `navIcon()` 兜底同档）。
理由见 `rules/references_icons.local.md`。

**`sidebar.footer.action` 没有注册**：侧栏底部按钮与左上角面板功能重复，
按用户反馈去掉。

### 等人齐用悬浮卡片，不是全屏遮罩

`waiting` 可能持续 `GATHER_MAX_MS = 10 分钟`。用全屏遮罩意味着用户十分钟什么都干不了
（2026-11-09 用户直接反馈）。所以这一态用右下角卡片，外层 `pointerEvents: 'none'`，
卡片以外的区域照常可点。

倒计时（`counting`）仍然用全屏遮罩：只有几秒，且「一动就取消」是设计意图。

## 测试

```bash
npm test
```

| 文件 | 覆盖 |
|---|---|
| `test/roster.test.mjs` | 清单结构、幂等键、原子写、脏数据丢弃 |
| `test/policy.test.mjs` | 判忙、三档分类、保护期 |
| `test/deliver.test.mjs` | 按 role 投递、三层幂等 |
| `test/suite-integration.test.mjs` | 装配层：读清单 → 投递 → 清理 |
| `test/client-smoke.test.mjs` | 浏览器 bundle：座位注册、8 个 phase 渲染、按钮行为 |
| `test/manifest-integrity.test.mjs` | `package.json` 的承诺是否兑现（见下） |

### `manifest-integrity` 为什么必须有

2026-11-09 事故：本包在 `package.json` 里声明了 `exports["./client"]` 和
`dsh.client.platform='web'`，但 `client.js` 从未落地。`dsh-client-modules` 是
**required** 插件，它启动时强校验 bundle 存在，缺失即抛 → 整个应用 fatal。

**那天至少 3 次启动全部失败。** 这条检查跑 3 毫秒，本来能挡住它。

详见 `docs/INCIDENT-20261109-missing-client-bundle.md`。

## 状态目录

沿用 `~/.dsh/dsh-auto-restart/`（不是新目录）：

```
settings.json        用户改过的默认值（倒计时、唤醒词、launchCommand）
roster.json          重启清单
wake-request.json    脚本信号文件（脚本写 ready，插件据此认为应用起来了）
launch-plan.json     启动计划
logs/                plugin.log / restart-*.log
```

**为什么不换新目录**：旧目录里有用户的 `settings.json` 和历史日志，换目录等于全丢。

### 为什么 roster 和 wake-request 是两个文件

脚本写 `ready` 时会**整份重建** `wake-request.json`，只保留它认识的字段
（`runId` / `phase` / `sessionId` / `text` / `startedAt` / `error`）。把
`sessions[]` 数组放进去会被丢掉。

所以：`roster.json` 存完整清单，`wake-request.json` 只做「应用起来了没有」的信号，
两者靠 `runId` 关联。

## 已知缺口

| 项 | 状态 | 影响 |
|---|---|---|
| 两段式停机 | ❌ **未接线** — `engine/helper-src.js` 已搬入但主流程没调用 | 现在靠脚本硬杀，进程可能来不及落盘 |
| 崩溃续跑 | ⚠️ **覆盖度待核对** — `after/sweep.js` 有全量扫描，边界未逐一验证 | 极端崩溃场景可能漏续 |
| `abort` 分支 | ⚠️ **未真机验证** — 普通 Esc 走的是 `cancel` 分支 | 只有按住「停止生成」按钮才走 `abort` |
| 跨平台 | ❌ 仅 Windows — `Restart-应用.ps1` 是 PowerShell | macOS / Linux 无停机脚本 |
| 按钮逐项开关 | ❌ 未实现 — restart-now 有此功能，本包全开 | 无法单独关掉某个入口 |

## 已验证（真机）

| 项 | 证据 |
|---|---|
| 清单投递全链路 | `发现重启清单：runId=… phase=starting sessions=1` → `投递完成【initiator】…` → `清单已全部投递，清理完成` |
| 图标档位（侧栏 regular） | 墨量 208.4，同列官方 217.0 / 242.5，同档 |
| 图标档位（设置页 medium） | 墨量 92.0，同页官方 medium 92.8，差 0.9% |
| `settings.section.icon` 座位配对 | 真机显示圆弧箭头而非齿轮 = id 配对成功 |
| 改名生效 | 侧栏 + 设置页 + 面板标题均显示「重启应用」 |
