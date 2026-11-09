# 事故复盘 — 启动 fatal（缺失 client bundle）

> 时间：2026-11-09 10:55 → 19:22（UTC+8）
> 对象：`@deepseek-ai/dsh-desktop` 0.2.2-rc.1（Electron 44.7.0 / Node 24.21.0）
> 起因：`dsh-restart-suite` 在 `package.json` 里声明了浏览器半边，但 `client.js` 从未落地
> 报错：`DesktopHostFatalError: dsh: startup failed: 1 required plugin did not activate`
> 结果：**应用完全无法启动**，当天至少 3 次启动全部 fatal
> 现状：已补 `client.js` 并验证（应用正常启动，插件完整 apply）
> 关联：同工作区第三次启动故障。前两次见
> [INCIDENT-20261106-startup-crash.md](../../dsh-study-desk/docs/INCIDENT-20261106-startup-crash.md)（凭据结构）、
> [INCIDENT-20261107-welcome-auth.md](../../../docs/incidents/INCIDENT-20261107-welcome-auth.md)（Chromium cookie）。
> **三次的故障层完全不同**，不要混为一谈。

---

## 一、一句话结论

`package.json` 声明了 `exports["./client"] → ./client.js` 和 `dsh.client.immediately = true`，
但仓库里根本没有 `client.js`、`ui/` 是空目录。`dsh-client-modules` 的
`ClientModuleRegistry` 在启动时强校验每个已声明包的 bundle 是否存在，缺失即抛
`client bundles not found`；因为 `modules` 是 **required 插件**，它不激活 →
整个 Host 启动 fatal。

**这不是"少个界面"，是"应用起不来"。** 而且即使绕过启动校验，`restart_dsh` 也会永久卡死：
`index.js` 的倒计时起表判据是「页面来读了状态」，没有 client.js 就永远没人来报到。

---

## 二、时间线

| 时刻 | 事件 |
|---|---|
| 11-09 14:18–15:41 | `dsh-restart-suite` 按 `RESTART-SUITE-FORK-PLAN.md` 的目标结构铺开：`core/`、`engine/`、`after/`、`scripts/`、`test/`、空 `ui/` |
| 15:39 | 目录里出现 `index.js`(134KB)、`package.json`、`cordis.patch.yml` —— **唯独没有 `client.js`** |
| 16:23 / 18:51 | 两次改 profile `package.json`（`bak-before-suite*`），最后一条是"移除三个 vendor 插件、加入 restart-suite" |
| 18:55:42 | 一次重启尝试：脚本杀掉 8 个进程 → 18:56:15 拉起 → **启动 fatal** |
| **19:09:32** | **最后一次 fatal**（`crash-2026-11-09T11-09-32-066Z-host.log`，64KB） |
| 19:17 | 补齐 `client.js`（47,951 字节） |
| 19:22:24 | 手动拉起应用 → **apply 成功**，无新崩溃日志 |

崩溃日志（同一根因，至少 3 份）：

```
%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-11-09T10-56-15-079Z-host.log
%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-11-09T11-09-32-066Z-host.log
```

> 中间的 renderer 崩溃日志（`10-55-42`、63KB 之前那几份）是**另一层现象**：
> host 起不来 → 渲染进程失去后端 → 报 `Desktop renderer exited: crashed`。
> 看日志时先看 host 那份，renderer 的崩溃是下游症状。

---

## 三、根因

### 3.1 直接原因：声明与产物不一致

`package.json`（出问题时）：

```json
{
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js"          // ← 指向一个不存在的文件
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true }   // ← 声明了浏览器半边
  }
}
```

对照同目录的 `dsh-study-desk`：它同样声明 `dsh.client`，但**有真实的 `client.js`**（2033 行）。

### 3.2 为什么会让整个应用起不来

`dsh-client-modules` 的启动路径（官方 README「构建要求」一节写得很明确）：

> 宿主提供的是已构建的客户端 bundle，因此启动前 `pnpm run build` 必须已产出每个
> `lib/client.js`；**缺失 bundle 会明确导致激活失败**，并给出一条构建说明及包／路径列表。

实际抛出的两层错误：

```js
// lib/index.js:889  readClientBundle
throw new Error(`client-modules: client bundle not found; run \`pnpm run build\` before launch:
  package: ${name}
  path: ${bundlePath}`)

// lib/index.js:868  captureArtifactBaseline
Error: ENOENT: no such file or directory, stat '...\dsh-restart-suite\client.js'
    at statSync (node:fs:1794:25)
```

然后向上冒泡成 required 插件失败：

```
Failed plugins (1):
  modules (required)
    Package: @deepseek-ai/dsh-client-modules
    AggregateError: client-modules: 1 client package failed to compose

Plugins waiting for services (1):
  Plugin      Missing services
  client-hmr  clientModules          ← 连带：等 clientModules 的插件也起不来
```

**爆炸半径**：`modules` 是 required → 启动是"全有或全无" → 不做降级 →
`DesktopHostFatalError` → 整个应用起不来。这和上一篇事故的放大机制一模一样
（`credentials` 是 required service），说明这是这个宿主的**结构性特征**：
**一个 required 插件失败 = 全站不可用**。

### 3.3 即使绕过启动校验，功能也是死的

这一条是本次最容易被忽略的：`index.js:2397` 的注释写得很直白——

> 「就绪」的判据只有一个：页面来读了状态（GET /state）或者主动报到（POST /viewer）。

对应实现（`index.js` 的 `beginFromViewer`）：

```js
const beginFromViewer = (origin) => {
  if (state.phase !== 'counting' || !awaitingViewer) return false
  const deadline = now + state.countdownSec * 1000 + COUNTDOWN_TAIL_MS
  awaitingViewer = false          // ← 只有这里会清掉
  ...
}
```

`awaitingViewer` 只在页面报到时清除。没有 `client.js`，就没人 `POST /viewer`，
`restart_dsh` 的倒计时**永远不起表**，只能等 `VIEWER_WAIT_MS = 10_000` 的超时兜底。
也就是说：**`restart_dsh` 名义上注册成功了，实际上要白等 10 秒才动**，而且倒计时
界面永远不会出现。

> 这一点在 18:55 那份日志里留下了痕迹：
> `[10:55:33.316Z] 页面就绪（无人查看，超时兜底），倒计时开始：30 秒`
> —— "无人查看，超时兜底"就是没有 client.js 的证据。

---

## 四、故障为什么没被早发现

| 环节 | 为什么没拦住 |
|---|---|
| 目录铺开时 | 按方案稿建了 `ui/` 空目录，`client.js` 列为"下一步"，但 `package.json` 先行声明了它 |
| 单测 | `npm test` 只跑 host 半边的 `core/`、`engine/`、`after/`，**没有任何用例读过 `package.json` 的 exports 与磁盘上文件的一致性** |
| 重启 | 18:55 那次重启后确实崩了，但崩溃日志堆在 `%APPDATA%`，没有进自动化检查 |

最关键的一点：**`package.json` 是一份"承诺"，没有任何机制核对它是否兑现。**
`pnpm run build` 在官方仓库里负责产出这个文件；本插件是纯手写 JS、没有构建步骤，
于是这个承诺永远悬空。

---

## 五、修复内容

| 文件 | 改动 |
|---|---|
| `plugins/dsh-restart-suite/client.js` | **新增**，47,951 字节。浏览器半边：模块登记 + 八 phase 渲染 + 设置页 |
| `plugins/dsh-restart-suite/package.json` | `dsh.client.inject` 补 `[]`（与同目录其它插件对齐） |
| `plugins/dsh-restart-suite/test/client-smoke.test.mjs` | **新增**，7 个用例，在 Node 里真跑 bundle |

### 5.1 `client.js` 的装配契约

按 `rules/client-modules-README.zh.md` 与 `rules/references_ui-plugin.md`：

```js
window.__ModuleLoader__.load({
  id: 'dsh-restart-suite',        // ← 必须等于 package.json 的 name
  factory: (require) => {         // ← 无副作用，只返回插件对象
    const React = require('react')   // ← React 只能来自冻结的浏览器模块表
    ...
    return { name, inject: ['slots'], apply(ctx) { ... } }
  },
})
```

两条硬约束（踩了就空屏）：

1. **不 require 任何 Runtime Client 包**（`@deepseek-ai/dsh-client-ui-primitives` 之类）。
   它们随版本变，抛一次就把整个座位打成空白，控制台只留一行 `slot entry crashed`。
   本次所有控件（按钮、开关 `<button role="switch">`、输入框、只读行）都是手写的。
2. **颜色只用 `--dsw-alias-*` token**。token 改名最多是外观退化，不会让组件抛异常。

### 5.2 八个 phase 的呈现

Host 侧状态机已经完整（`createState()` 的注释列了全部八态），client 只负责画：

| phase | 呈现方式 | 为什么 |
|---|---|---|
| `counting` | 全屏遮罩 + 数字 + 进度条 | 只有几秒，且"一动就取消"是设计意图 |
| `settling` | 同上（共用遮罩） | 等发起会话把这一轮说完，同样该能一键取消 |
| `waiting` | **右下角悬浮卡片，`pointerEvents: 'none'`** | 可能持续 `GATHER_MAX_MS = 10 分钟`。锁住界面十分钟是错的 |
| `launching` | 全屏，3 秒后自隐 | 进程一秒内就没了；3 秒是容错 |
| `blocked` | 遮罩 + 阻塞项清单 + 「知道了」 | 必须留痕，否则"发起过重启"等于没发生 |
| `cancelled` | 同上（带取消原因） | 同上 |
| `failed` | 同上 | 同上。它可能等不到进程被杀，不能永远挡人 |
| `idle` | 返回 `null` | — |

`waiting` 用悬浮卡片而不是遮罩，是直接继承 `dsh-autonomous-restart` 的实测结论
（2026-11-09 用户反馈：遮罩让人十分钟什么都干不了）。

### 5.3 倒计时的两个容易写错的数

```js
// Host: index.js:2405
const deadline = now + state.countdownSec * 1000 + COUNTDOWN_TAIL_MS   // +500ms

// Client: 剩余秒
const sec = Math.ceil((left - COUNTDOWN_TAIL_MS) / 1000)   // 先减掉缓冲再 ceil
```

先把 Host 多给的 500ms 减掉、再向上取整，每个数字才各占整 1 秒：
设置 3 秒 → 屏幕上是 3 → 2 → 1 → 0。**不减这一下，第一个数字只闪半秒。**

### 5.4 门禁头

Host 的 `checkRequestSource` 有四层（反向代理头 / 回环地址 / 自定义头 / 同源），
其中第三条要求每个请求带 `x-dsh-restart-suite: 1`：

```js
function request(path, init) {
  const headers = Object.assign({}, init.headers)
  headers['x-dsh-restart-suite'] = '1'      // ← 漏了就是全部 403
  return fetch(API_PATH + path, { ...init, headers })
}
```

它的作用不是鉴权，是挡浏览器：跨源请求带自定义头必先预检，而宿主不放行 CORS。

---

## 六、验证

### 6.1 离线：`client-smoke.test.mjs`

7 个用例，在 Node 里手写最小 hook 运行时（`useState` / `useRef` / `useEffect`）把组件真跑一遍。
**不装 React** 是故意的：组件只需要这三个 hook，手写运行时能把"渲染第 N 次时的状态"
精确喂进去，比真渲染器更适合逐 phase 断言。

| 用例 | 断言 |
|---|---|
| bundle 用包名登记 | `spec.id === 'dsh-restart-suite'`；`factory` 返回 `{name, inject, apply}` |
| 槽位注册 | 恰好在 `shell.overlay` 与 `settings.section` 各一次；id 不与 restart-now 撞 |
| 八 phase 渲染 | 逐个 phase 渲染都不抛；`idle` 返回 `null`，其余都有文本 |
| 表未起 | 显示完整设置秒数；`/viewer` **只 POST 一次** |
| `waiting` | 外层 `pointerEvents === 'none'`；无全屏遮罩；显示阻塞会话可读名 |
| 三种终止 | 各只有一个「知道了」；点击后 POST `/dismiss` |
| 设置页 | 画出脚本路径、回填 `autoSay`、范围、上次退出码 |

```bash
cd plugins/dsh-restart-suite && npm test
# → tests 53 / pass 53 / fail 0
```

### 6.2 在线：拉起应用

| 检查项 | 结果 |
|---|---|
| 新崩溃日志 | **无**（此前每次启动必产一份） |
| `plugin-load.log` | `11:22:24 apply 开始 pid=37220` → `restart_dsh 注册成功` → `webServer 注入回调已进入` ✅ |
| API 路由 | `GET /dsh-restart-suite/api/state` 无头 → **403**（门禁生效）；带头 → **200** `{"phase":"idle",...}` ✅ |
| 进程 | 8 个 `AI Assistant.exe`，两个端口在 listen ✅ |

> `/plugins/*` 从 curl 拿 404 是**正常**的：`GET /` 直接返回
> `401 dsh web authentication required`，bundle 路由在鉴权后面。
> 对照组（`dsh-study-desk` / `dsh-whale-widget`）同样 404 —— 不是本插件的问题。
> **判定 bundle 是否存在，看的是启动有没有 fatal，不是 curl。**

---

## 七、教训

### L13. `package.json` 的 exports 是承诺，必须有机核对

`"./client": "./client.js"` 和 `dsh.client.platform = 'web'` 合起来是一句
"我有一个浏览器半边"。宿主会**在启动时强制执行这句承诺**，而没有任何东西
核对承诺方是否兑现过。

**规则**：插件里凡是被 `package.json` 声明的路径（`main` / `exports` / `dsh.bundle.patch`），
加一个一行的启动自检或单测：

```js
for (const [key, rel] of Object.entries(pkg.exports)) {
  assert.ok(fs.existsSync(path.join(root, rel)), `exports["${key}"] 指向不存在的文件: ${rel}`)
}
```

这条检查跑 3 毫秒，能挡住一次全站不可用。

### L14. 声明式配置和产物要同步落地，别分两步

方案稿把 `client.js` 列在第二步，但 `package.json` 在第一步就写好了。
中间的窗口期不是"还没做"，是"应用起不来"。

**规则**：改 `dsh.client` / `exports` 这类声明时，**和产物同一个提交**。
做不到就先别声明——`dsh.client` 段删掉，插件降级成纯 host 半边，至少能启动。

### L15. required 插件的失败半径等于全站

这是第三次同一个模式了：

| 事故 | required 的东西 | 后果 |
|---|---|---|
| 11-06 | `credentials`（11 个插件依赖） | 全站不可用 + 自愈清空配置 |
| 11-07 | Chromium cookie（壳↔Host 握手） | 全站不可用 |
| **11-09** | `modules`（client-modules） | **全站不可用** |

**规则**：每次给 profile 加插件，问一句「如果这个插件挂了，是它自己不工作，
还是整个应用起不来？」如果答案接近后者，上线前必须做一次冷启动验证。

### L16. 崩溃日志要看"哪一份"，不要看"最新一份"

`logs/` 目录里混着两种日志：

- `crash-*-host.log`（64KB，含 `Failed plugins` 段）→ **根因在这里**
- `crash-*-renderer.log`（731 字节 ~ 13KB，`Desktop renderer exited: crashed`）→ 下游症状

先看 host 那份。渲染进程崩溃是因为后端没起来，修渲染进程是白费力气。

### L17. 排查时注意工具输出可能改写非 ASCII 路径

本次排查中，我在 PowerShell / Node 的输出里反复看到安装目录被渲染成
`C:\AI\Deepseek Runtime`，而磁盘上的真实目录名是 `Deepseek Runtime`。
于是字面量拼出来的路径 `ENOENT`，而枚举出来的路径正常——这个矛盾浪费了一轮排查。

**规则**：路径排查先按码点核对，不要相信打印出来的字符串：

```js
console.log([...name].map(c => c.codePointAt(0)).join(','))
// 或
console.log(Buffer.from(name, 'utf8').toString('hex'))
```

同一原则适用于中文目录名（如本工作区的 `dsh插件`）。

### L18. `restart_dsh` 的"无人查看，超时兜底"是缺失 client 的指纹

日志里出现这一行，说明**倒计时起表时没有页面报到**。正常情况下应该是
「页面就绪（页面报到），倒计时开始」。

```bash
grep "无人查看，超时兜底" ~/.dsh/dsh-auto-restart/logs/restart-*.log
# 命中 = client.js 没加载（或页面没打开）
```

这是一条几乎零成本的体检命令，比等崩溃更快。

---

## 八、可以固化的检查清单

新增或修改任何带 `dsh.client` 声明的插件时，走一遍：

- [ ] `client.js` 真实存在，且 `exports["./client"]` 指的就是它
- [ ] `__ModuleLoader__.load({ id })` 的 `id` **等于** `package.json` 的 `name`
- [ ] `factory(require)` 无副作用，返回 `{ name, inject, apply }`
- [ ] 没有 require 任何 Runtime Client 包（primitives 之类）
- [ ] 所有可见文本走 `t()`，中英两份 key 对齐
- [ ] 颜色只用 `--dsw-alias-*` token
- [ ] 所有请求带门禁头（本插件是 `x-dsh-restart-suite: 1`）
- [ ] 倒计时报了 `/viewer`（否则 Host 永远停在 `awaitingViewer`）
- [ ] **冷启动验证**：重启应用，确认 `plugin-load.log` 有新的 `apply 开始`，且无新崩溃日志
- [ ] `grep "无人查看，超时兜底"` 没有新命中

---

## 九、遗留事项

### 9.1 未在真机 UI 上做目视验收

本次验证覆盖的是：启动不 fatal、插件 apply 成功、API 路由与门禁正常、八个 phase
在 Node 里渲染不抛。**没有做**的是：在真实窗口里触发一次重启，用眼睛确认倒计时
遮罩、悬浮卡片、设置页的实际观感。

建议下一次重启验证时检查：

- `restart_dsh` 触发后，遮罩上数字是否 3 → 2 → 1 → 0 各占 1 秒
- 倒计时期间按一下键，是否立刻切到「已取消重启」
- 有其它会话在跑时，是否显示右下角卡片（而非全屏遮罩）且能继续操作界面
- 设置 → 重启应用页能否正常读写（当时叫「重启套件」）

### 9.2 profile 里 `dsh-restart-suite` 与三个 vendor 插件是替换关系

`package.json.bak-before-suite-20261109-162329` 显示：加入 `dsh-restart-suite` 的同时，
移除了 `dsh-restart-now`、`dsh-interrupted-resume`、`dsh-autonomous-restart`。
这是方案稿里的"方向 C：三合一 Fork"。

需要确认的是：这三个的**能力是否真的都被 suite 覆盖**。已知缺口：

| 能力 | 原插件 | suite 现状 |
|---|---|---|
| 侧栏/底部/会话头/设置行 四个按钮入口 | restart-now | ❌ 未实现（本次只补了 overlay + settings.section） |
| 按钮入口的逐项开关 | restart-now | ❌ 未实现 |
| 崩溃续跑（interrupted-resume） | interrupted-resume | ⚠️ `after/sweep.js` 有全量扫描，待核对覆盖度 |

也就是说：**重启的"按钮"入口目前是空的**，只有 agent 调 `restart_dsh` 这条路。
如果这是有意的（先保 agent 路径），建议在 README 里写明；如果不是，
下一步应该按方案稿 §六的座位表补齐入口。

> **更新（11-09 晚间）**：入口已全部补齐并真机验收通过。最终保留了
> 6 个座位：`shell.overlay`、`settings.section`、`sidebar.panellist` +
> `main`（成对）、`conversation.session.header.actions`、`settings.general.item`。
> `sidebar.footer.action` 按用户要求**去掉**了（侧栏底部按钮与左上角面板重复，
> 用户明确说「不要」），相关注册与组件已一并删除，测试同步更新。
>
> **更新（11-09 深夜，v0.1.2）**：又加了一个座位 `settings.section.icon`，共 **7 个**。
> 原因是「重启应用」在设置页导航里显示的是官方 `navIcon()` 的**齿轮兜底**，
> 和相邻一堆没有专属图标的行撞脸。注册该座位后显示自己的圆弧箭头。
> 注意两个座位**档位不同**：`sidebar.panellist` 用 regular（1）、
> `settings.section.icon` 用 medium（1.3），详见 `rules/references_icons.local.md`。
> 同时「重启套件」更名为「重启应用」（`t("nav")` + `locale/*.json` 同步改）。

---

> **前两次事故**：
> [INCIDENT-20261106-startup-crash.md](../../dsh-study-desk/docs/INCIDENT-20261106-startup-crash.md)
> （插件写坏共享凭据 → 全站不可用）、
> [INCIDENT-20261107-welcome-auth.md](../../../docs/incidents/INCIDENT-20261107-welcome-auth.md)
> （Chromium cookie 状态 → 壳↔Host 握手失败）。
>
> 三篇的教训互补：
> 06 讲「插件写共享存储」，
> 07 讲「壳与子进程的网络路径差异」，
> 本篇讲「声明与产物不一致」。
> 共同的元教训是 **L15：required 插件的失败半径等于全站**。
