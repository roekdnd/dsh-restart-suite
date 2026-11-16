/**
 * dsh-restart-suite —— 浏览器半边。
 *
 * 只负责「画页」和「把用户的意思送回去」，一行判定逻辑都没有：
 *
 *   ① 倒计时页（counting）   —— 全屏遮罩。任何真实键鼠输入都取消。
 *   ② 收尾页（settling）     —— 同一张遮罩，等发起会话把这一轮说完。
 *   ③ 等人齐（waiting）      —— 右下角悬浮卡片，**不拦指针**。可能持续十分钟。
 *   ④ 正在重启（launching）  —— 全屏，3 秒后自行消失。
 *   ⑤ 三种终止（blocked / cancelled / failed）—— 都带「知道了」，靠它收摊。
 *   ⑥ 设置页（settings.section）—— 可编辑默认值 + 只读现状。
 *
 * 装配契约（`rules/client-modules-README.zh.md` + `rules/references_ui-plugin.md`）：
 *
 *  - `__ModuleLoader__.load({ id })` —— `id` 必须等于 package.json 的 `name`，
 *    否则模块注册表拒绝登记（启动时报「client bundles not found」那种失败就是
 *    因为本文件根本不存在，而不是 id 写错）。
 *  - `factory(require)` 必须无副作用，返回 Cordis 插件对象 `{ name, inject, apply }`。
 *    React 来自冻结的浏览器模块表，只能用 `require('react')`。
 *  - 不 require 任何 Runtime Client 包（primitives 之类）：它们随版本变，抛一次就把
 *    整个座位打成空白。控件全部自己画，颜色只用 `--dsw-alias-*` token。
 *  - 所有面向用户的字符串走 `t()`，语言优先取 Client locale 服务。
 *
 * ⚠ 倒计时的起表权在 Host 手里（`index.js` 的 `beginFromViewer`）：
 *   页面把自己画出来之后必须 POST `/viewer`，否则 Host 永远停在 `awaitingViewer`，
 *   10 秒兜底超时之前倒计时根本不动。这是本文件存在的最硬理由。
 */

var PKG = 'dsh-restart-suite'

/** 与 Host 侧 `API_PATH` 同一常量（index.js 第 63 行）。 */
var API_PATH = '/dsh-restart-suite/api'

/**
 * Host 的门禁要求每个请求都带这个头。
 *
 * 同源请求带自定义头不触发预检，正常轮询没有额外成本；它的作用是把「别的网页
 * 用 fetch 打进来」这条路堵死 —— 跨源带自定义头必先预检，而宿主不放行 CORS。
 */
var REQUEST_HEADER = 'x-dsh-restart-suite'

/** `shell.overlay` 上的座位 id。与 restart-now / autonomous 的 id 都不撞。 */
var OVERLAY_ID = PKG + '-overlay'

/** 设置页在 `settings.section` 上的座位 id。 */
var SETTINGS_ID = PKG + '-settings'

var NS = 'restart-suite'

/** 轮询间隔：倒计时/等待时快一点，其余时候慢一点。 */
var POLL_ACTIVE_MS = 300
var POLL_IDLE_MS = 2000

/**
 * Host 在倒计时末尾多给的缓冲（index.js 的 `COUNTDOWN_TAIL_MS = 500`）。
 *
 * 显示侧要先把它减掉再向上取整，数字才各占整 1 秒；否则第一个数字只闪半秒。
 */
var COUNTDOWN_TAIL_MS = 500

window.__ModuleLoader__.load({
  id: PKG,
  factory: function (require) {
    var React = require('react')
    var h = React.createElement

    // ── 文案 ────────────────────────────────────────────────────────────────
    // 浏览器半边没有文件访问，字符串只能内联；`locale/*.json` 只服务插件列表的元信息。
    var DICT = {
      zh: {
        nav: '重启应用',
        btnRestart: '重启',
        btnRestartHint: '按当前设置重启应用（会先判忙、倒计时）',
        btnWaiting: '正在重启…',
        btnFailed: '重启请求失败',
        sectionHint: '控制 agent 调 restart_dsh 时的默认行为。每次调用都可以在参数里覆盖这些值。',
        ok: '知道了',
        cancel: '取消这次重启',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        loading: '读取中…',
        countdownTitle: '即将重启',
        countdownBody: '倒计时结束后会退出并重新打开应用。这期间任何键鼠操作都会取消本次重启。',
        countdownIdle: '等待页面就绪…',
        settlingTitle: '等待本会话说完这一轮',
        waitingTitle: '等待其它会话结束',
        waitingLimit: '最多 10 分钟',
        waitingInitiator: '发起者：',
        waitingBlockers: '正在挡着：',
        waitingNone: '当前没有阻塞项，马上就会重启。',
        waitingQueue: '个会话在等',
        launchingTitle: '正在重启',
        launchingBody: '已经交给重启脚本，几秒后窗口会关闭并重新打开。',
        blockedTitle: '现在不能重启',
        blockedBody: '这次没有重启。等它们跑完，请稍后再发起一次。',
        cancelledTitle: '已取消重启',
        cancelledBody: '倒计时被取消，这次重启没有执行。',
        failedTitle: '重启失败',
        failedBody: '这次重启没有发生，应用仍在运行。',
        whyInput: '检测到键鼠输入',
        whyApi: '手动取消',
        whyAbort: '发起会话的回合被中断',
        fieldAllow: '允许重启',
        fieldAllowHint: '总开关。关闭后 restart_dsh 直接拒绝，连倒计时都不进。',
        fieldWakeMode: '唤醒方式',
        fieldAutoSay: '默认唤醒词',
        fieldAutoSayHint: '调用方没传 autoSay 时用这一条。留空回落为「已通过插件重启」。',
        fieldCountdown: '默认倒计时（秒）',
        fieldCountdownHint: '触发后等多少秒再动手。这期间任何键鼠输入都会取消。',
        fieldTimeout: '命令超时（秒）',
        fieldTimeoutHint: '只约束「重启期间顺带执行的那条命令」卡住的情况；超时即中止并照常启动。',
        fieldLogKeep: '日志保留（份）',
        fieldLaunch: '启动命令覆盖',
        fieldLaunchHint: '留空 = 自动（宿主自述 + argv 重放）。只有重放不可行时才在这里写完整命令。',
        metaTitle: '现状（只读）',
        metaScript: '重启脚本',
        metaStateDir: '状态目录',
        metaLogDir: '日志目录',
        metaLastRun: '上次脚本结果',
        lastRunNone: '还没有运行记录',
        lastRunOk: '退出码 0',
        lastRunFail: '退出码',
        lastRunTimeout: '超时中止',
        range: '范围',
      },
      en: {
        nav: 'Restart App',
        btnRestart: 'Restart',
        btnRestartHint: 'Restart the app with current settings (checks busy state first)',
        btnWaiting: 'Restarting…',
        btnFailed: 'Restart request failed',
        sectionHint: 'Defaults used when an agent calls restart_dsh. Every call may override them.',
        ok: 'Got it',
        cancel: 'Cancel this restart',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed',
        loading: 'Loading…',
        countdownTitle: 'Restarting soon',
        countdownBody: 'The app will close and reopen when the countdown ends. Any keyboard or mouse input cancels it.',
        countdownIdle: 'Waiting for the page…',
        settlingTitle: 'Waiting for this session to finish',
        waitingTitle: 'Waiting for other sessions',
        waitingLimit: 'up to 10 minutes',
        waitingInitiator: 'Requested by: ',
        waitingBlockers: 'Blocking now: ',
        waitingNone: 'Nothing is blocking; restarting shortly.',
        waitingQueue: ' sessions waiting',
        launchingTitle: 'Restarting',
        launchingBody: 'Handed off to the restart script. The window closes and reopens in a few seconds.',
        blockedTitle: 'Cannot restart now',
        blockedBody: 'Nothing was restarted. Try again once those finish.',
        cancelledTitle: 'Restart cancelled',
        cancelledBody: 'The countdown was cancelled; nothing happened.',
        failedTitle: 'Restart failed',
        failedBody: 'The restart did not happen. The app is still running.',
        whyInput: 'keyboard or mouse input detected',
        whyApi: 'cancelled manually',
        whyAbort: 'the requesting turn was interrupted',
        fieldAllow: 'Allow restarts',
        fieldAllowHint: 'Master switch. When off, restart_dsh refuses immediately — no countdown at all.',
        fieldWakeMode: 'Wake mode',
        fieldAutoSay: 'Default wake text',
        fieldAutoSayHint: 'Used when the caller passes no autoSay.',
        fieldCountdown: 'Default countdown (s)',
        fieldCountdownHint: 'Seconds before acting. Any input during it cancels.',
        fieldTimeout: 'Command timeout (s)',
        fieldTimeoutHint: 'Only bounds the optional command run during restart.',
        fieldLogKeep: 'Logs kept',
        fieldLaunch: 'Launch command override',
        fieldLaunchHint: 'Empty = automatic (host facts + argv replay).',
        metaTitle: 'Current state (read-only)',
        metaScript: 'Restart script',
        metaStateDir: 'State dir',
        metaLogDir: 'Log dir',
        metaLastRun: 'Last script run',
        lastRunNone: 'No run recorded yet',
        lastRunOk: 'exit code 0',
        lastRunFail: 'exit code',
        lastRunTimeout: 'timed out',
        range: 'Range',
      },
    }

    // 语言判定顺序：locale 服务 → <html lang> → navigator.language → en。
    // 不能只读 navigator：Electron 里它通常是 en-US，而界面是中文的。
    function normalizeLang(tag) {
      var s = String(tag || '').toLowerCase()
      if (!s) return null
      if (s.indexOf('zh') === 0) return 'zh'
      if (s.indexOf('en') === 0) return 'en'
      return null
    }

    function pickLang() {
      var declared = ''
      try {
        declared = document.documentElement.getAttribute('lang') || ''
      } catch (e) {
        void e
      }
      var hit = normalizeLang(declared)
      if (hit) return hit
      var tags = []
      try {
        if (navigator.languages && navigator.languages.length) tags = [].slice.call(navigator.languages)
        else if (navigator.language) tags = [navigator.language]
      } catch (e) {
        void e
      }
      for (var i = 0; i < tags.length; i += 1) {
        var one = normalizeLang(tags[i])
        if (one) return one
      }
      return 'en'
    }

    var LANG = pickLang()
    var langSubs = []

    function setLang(next) {
      var lang = normalizeLang(next)
      if (!lang || lang === LANG) return
      LANG = lang
      langSubs.slice().forEach(function (fn) {
        try {
          fn()
        } catch (e) {
          void e
        }
      })
    }

    function t(key) {
      var table = DICT[LANG] || DICT.en
      if (table && table[key] !== undefined) return table[key]
      var fallback = DICT.en[key]
      return fallback !== undefined ? fallback : key
    }

    // ── HTTP ───────────────────────────────────────────────────────────────
    function request(path, init) {
      var opts = init || {}
      var headers = Object.assign({}, opts.headers || {})
      headers[REQUEST_HEADER] = '1'
      var merged = Object.assign({}, opts, { headers: headers })
      return fetch(API_PATH + path, merged).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
    }

    function readState() {
      return request('/state', { method: 'GET', headers: { accept: 'application/json' } }).then(function (body) {
        return body && body.value ? body.value : null
      })
    }

    function readSettings() {
      return request('/settings', { method: 'GET', headers: { accept: 'application/json' } }).then(function (body) {
        return { value: body && body.value ? body.value : {}, meta: body && body.meta ? body.meta : {} }
      })
    }

    function readLastRun() {
      return request('/last-run', { method: 'GET', headers: { accept: 'application/json' } }).then(function (body) {
        return body && body.value ? body.value : null
      })
    }

    function postJson(path, payload) {
      return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
    }

    /**
     * 报到：告诉 Host「这一页已经画出来了」。
     *
     * Host 收到才起表。倒计时是给人看的，表从人能看到数字那一刻起才有意义；
     * 页面从收到状态到画出第一帧还有十几毫秒，这点时间不该从倒计时里扣。
     */
    function postViewer() {
      return postJson('/viewer', {}).catch(function () {})
    }

    function postCancel(source) {
      return postJson('/cancel', { source: source || 'input' }).catch(function () {})
    }

    function postDismiss() {
      return postJson('/dismiss', {}).catch(function () {})
    }

    // ── 样式 ───────────────────────────────────────────────────────────────
    // 只用主题 token，不硬编码颜色：浅色/深色主题自动跟随，token 改名最多是外观退化，
    // 不会让组件抛异常把整个座位打空。
    var 遮罩 = {
      position: 'fixed',
      inset: 0,
      // 压住设置面板等所有浮层：主题里的 modal 都在 1000 上下，
      // 9 万既能盖住它们，又不到 int 上限那么野。
      zIndex: 90000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      background: 'var(--dsw-alias-bg-mask-1)',
      backdropFilter: 'blur(3px)',
      WebkitBackdropFilter: 'blur(3px)',
      // 遮罩自己吃掉指针事件，避免误触下面的界面
      pointerEvents: 'auto',
    }

    var 卡片 = {
      width: 'min(420px, 100%)',
      padding: '22px 24px 20px',
      borderRadius: 16,
      background: 'var(--dsw-alias-bg-elevated)',
      border: '1px solid var(--dsw-alias-border-l2)',
      boxShadow: '0 24px 64px rgba(0, 0, 0, 0.28)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'inherit',
      textAlign: 'left',
    }

    var 标题行 = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 15,
      fontWeight: 600,
      marginBottom: 10,
    }

    var 说明 = {
      fontSize: 13,
      lineHeight: 1.6,
      color: 'var(--dsw-alias-label-secondary)',
    }

    var 数字 = {
      fontSize: 44,
      fontWeight: 600,
      lineHeight: 1.1,
      margin: '14px 0 4px',
      fontVariantNumeric: 'tabular-nums',
      color: 'var(--dsw-alias-label-primary)',
    }

    var 进度条 = {
      height: 4,
      borderRadius: 999,
      background: 'var(--dsw-alias-border-l3)',
      overflow: 'hidden',
      marginTop: 12,
    }

    var 进度条填充 = {
      height: '100%',
      borderRadius: 999,
      background: 'var(--dsw-alias-brand-primary)',
      transition: 'width 120ms linear',
    }

    var 按钮 = {
      marginTop: 18,
      padding: '7px 14px',
      fontSize: 13,
      borderRadius: 8,
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-primary)',
      background: 'transparent',
      border: '1px solid var(--dsw-alias-border-l3)',
      fontFamily: 'inherit',
    }

    var 按钮主 = Object.assign({}, 按钮, {
      background: 'var(--dsw-alias-button-primary-fill)',
      border: '1px solid transparent',
      color: 'var(--dsw-alias-label-primary-foreground)',
    })

    var 红点 = {
      display: 'inline-block',
      width: 6,
      height: 6,
      borderRadius: '50%',
      marginRight: 6,
      background: 'var(--dsw-alias-state-error-primary)',
      verticalAlign: 'middle',
    }

    /**
     * 右下角悬浮卡片：给「等人齐」这种**可能持续很久**的状态用。
     *
     * 和 遮罩 的本质区别：遮罩全屏、吃掉指针事件，只该用于几秒钟的倒计时；
     * 卡片只占右下角、不拦事件，用户可以继续用界面。把界面锁住十分钟是错的。
     */
    var 悬浮外壳 = {
      position: 'fixed',
      right: 0,
      bottom: 0,
      width: 'min(380px, 100vw)',
      pointerEvents: 'none',
      zIndex: 90000,
    }

    var 悬浮卡片 = {
      margin: '0 20px 88px 20px',
      padding: '14px 16px 12px',
      borderRadius: 14,
      background: 'var(--dsw-alias-bg-elevated)',
      backdropFilter: 'blur(18px) saturate(160%)',
      WebkitBackdropFilter: 'blur(18px) saturate(160%)',
      border: '1px solid var(--dsw-alias-border-l2)',
      boxShadow: '0 12px 40px rgba(0, 0, 0, 0.32)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'inherit',
      pointerEvents: 'auto',
    }

    var 悬浮标题 = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 13,
      fontWeight: 600,
      marginBottom: 6,
    }

    // ── 倒计时数学 ─────────────────────────────────────────────────────────
    /**
     * 剩余秒数：向下取整。
     *
     * 截止时间取「设置值 + 500ms」，所以先减掉这 500ms 再 ceil，得到的就是
     * 每个数字各占整 1 秒的显示：设置 3 秒 → 屏幕上是 3 → 2 → 1 → 0。
     * 多半秒是给最后那一下留的缓冲，避免数字刚跳到 0 就动手。
     */
    function 剩余秒(state, now) {
      if (!state) return 0
      // 表还没起（Host 在等页面报到）：显示完整的设置秒数，数字先不动。
      // 起表后 deadline 定死，这里的算法从同一个数字接着往下数，看不出接缝。
      if (!state.deadline) return state.countdownSec || 0
      var left = state.deadline - now
      if (left <= 0) return 0
      var sec = Math.ceil((left - COUNTDOWN_TAIL_MS) / 1000)
      var max = state.countdownSec || 0
      if (sec > max) sec = max
      return sec > 0 ? sec : 0
    }

    function 短id(x) {
      var text = String(x || '')
      return text.length > 12 ? text.slice(0, 8) + '…' : text || '—'
    }

    function 显示名(b) {
      if (b && b.name) return String(b.name)
      return 短id(b && b.id)
    }

    function 取消原因文案(reason) {
      if (reason === 'input') return t('whyInput')
      if (reason === 'abort') return t('whyAbort')
      return t('whyApi')
    }

    // ── 倒计时覆盖层 ───────────────────────────────────────────────────────
    function RestartOverlay() {
      var stateBox = React.useState(null)
      var state = stateBox[0]
      var setState = stateBox[1]

      // 本地 tick：只在倒计时/收尾时用，驱动数字重绘
      var tickBox = React.useState(Date.now())
      var now = tickBox[0]
      var setNow = tickBox[1]

      // 已经发过取消指令 → 避免每次 pointerdown 都 POST 一次
      var cancelledBox = React.useRef(false)

      // 点了取消之后的一小段时间里，服务端快照可能还是 counting（/cancel 还在路上）。
      // 这段时间不采信它，否则画面会「倒计时闪一下 → 变回倒计时 → 再跳终止页」。
      var suppressBox = React.useRef(0)

      // 已经对这次倒计时报过到 → 只报一次，别把 /viewer 打成轮询
      var reportedBox = React.useRef(false)

      // 重启页 3 秒后自行隐藏
      var hiddenBox = React.useState(false)
      var 重启页已藏 = hiddenBox[0]
      var 设重启页已藏 = hiddenBox[1]

      var phase = state ? state.phase : 'idle'
      // counting 与 settling 共用同一张遮罩，也都收键鼠取消
      var counting = phase === 'counting'
      var settling = phase === 'settling'
      var 等待中 = counting || settling

      // ── 报到：这一页画出来了，Host 可以起表 ──────────────────────────
      React.useEffect(
        function () {
          if (!counting) {
            reportedBox.current = false
            return undefined
          }
          if (state && state.deadline) return undefined
          if (reportedBox.current) return undefined
          reportedBox.current = true
          void postViewer()
          return undefined
        },
        [counting, state && state.deadline],
      )

      // ── 轮询状态 ────────────────────────────────────────────────────
      React.useEffect(
        function () {
          var stopped = false
          var timer = 0

          function loop() {
            // 「最近一次读到的状态」提到外层：下面的 .then 要按它决定轮询间隔，
            // 而 next 只在第一个 .then 的参数作用域里可见。
            var 最近状态 = null
            readState()
              .then(function (next) {
                if (stopped) return
                最近状态 = next
                var 还在等 = next && (next.phase === 'counting' || next.phase === 'settling')
                if (还在等 && Date.now() < suppressBox.current) return
                if (next) setState(next)
                if (!还在等) cancelledBox.current = false
              })
              .catch(function () {
                // Host 没起来 / 路由没注册：静默重试，不弹错误
              })
              .then(function () {
                if (stopped) return
                var 也在等别人 = 最近状态 && 最近状态.phase === 'waiting'
                timer = window.setTimeout(loop, 等待中 || 也在等别人 ? POLL_ACTIVE_MS : POLL_IDLE_MS)
              })
          }

          loop()
          return function () {
            stopped = true
            if (timer) window.clearTimeout(timer)
          }
        },
        [等待中],
      )

      // ── 倒计时期间的重绘 ────────────────────────────────────────────
      React.useEffect(
        function () {
          if (!等待中) return undefined
          var id = window.setInterval(function () {
            setNow(Date.now())
          }, 100)
          return function () {
            window.clearInterval(id)
          }
        },
        [等待中],
      )

      // ── 倒计时期间监听真实输入 ──────────────────────────────────────
      // capture = true：比任何控件都先拿到事件，界面上的按钮也拦得住。
      //
      // 不区分输入来源：任何 pointerdown / wheel / keydown 都取消。倒计时问的是
      // 「现在还有没有人在操作这台机器」，远程桌面、别的自动化工具发来的输入
      // 同样意味着有人在动它。宁可多取消一次，也不要在有人正操作时把应用杀掉。
      React.useEffect(
        function () {
          if (!等待中) return undefined

          function 取消() {
            if (cancelledBox.current) return
            cancelledBox.current = true

            // 直接切到「已取消」页，不要先回 idle 再等 Host 回话：
            // 中间那一帧 idle 什么都不画，屏幕上就是「倒计时闪一下消失、终止页再冒出来」。
            suppressBox.current = Date.now() + 1500
            setState(function (prev) {
              if (!prev || (prev.phase !== 'counting' && prev.phase !== 'settling')) return prev
              var next = Object.assign({}, prev)
              next.phase = 'cancelled'
              next.deadline = 0
              next.cancelReason = 'input'
              next.message = ''
              return next
            })
            void postCancel('input')
          }

          var opts = { capture: true, passive: true }
          window.addEventListener('pointerdown', 取消, opts)
          window.addEventListener('wheel', 取消, opts)
          window.addEventListener('keydown', 取消, opts)
          return function () {
            window.removeEventListener('pointerdown', 取消, opts)
            window.removeEventListener('wheel', 取消, opts)
            window.removeEventListener('keydown', 取消, opts)
          }
        },
        [等待中],
      )

      // ── 重启页 3 秒后自行消失 ───────────────────────────────────────
      // 脚本拉起来之后一秒内进程就没了，这一页本只该存在一瞬。3 秒是容错：
      // 脚本没跑起来、或进程迟迟不退出时，不让它一直糊在屏幕上挡人。
      React.useEffect(
        function () {
          if (phase !== 'launching') {
            设重启页已藏(false)
            return undefined
          }
          var timer = window.setTimeout(function () {
            设重启页已藏(true)
          }, 3000)
          return function () {
            window.clearTimeout(timer)
          }
        },
        [phase],
      )

      if (!state) return null
      if (phase === 'idle') return null

      // ── 正在重启 ────────────────────────────────────────────────────
      if (phase === 'launching') {
        if (重启页已藏) return null
        return h(
          'div',
          { style: 遮罩, role: 'presentation' },
          h(
            'div',
            { style: 卡片, role: 'dialog', 'aria-live': 'polite' },
            h('div', { style: 标题行 }, t('launchingTitle')),
            h('div', { style: 说明 }, t('launchingBody')),
          ),
        )
      }

      // ── 倒计时 / 收尾 ───────────────────────────────────────────────
      // 两者共用一张遮罩：区别只在标题和剩余时间的含义。
      if (等待中) {
        var 剩余 = 剩余秒(state, now)
        var 总数 = state.countdownSec || 0
        var 比例 = 总数 > 0 ? Math.max(0, Math.min(1, 剩余 / 总数)) : 0
        return h(
          'div',
          { style: 遮罩, role: 'presentation' },
          h(
            'div',
            { style: 卡片, role: 'dialog', 'aria-live': 'polite' },
            h('div', { style: 标题行 }, settling ? t('settlingTitle') : t('countdownTitle')),
            // 数字始终画出来：表还没起时它就是完整的设置秒数（不跳动），
            // 起表后从同一个数字接着往下数，人看不出接缝。
            h('div', { style: 数字 }, String(剩余)),
            state.deadline
              ? h('div', { style: 进度条 }, h('div', { style: Object.assign({}, 进度条填充, { width: 比例 * 100 + '%' }) }))
              : h('div', { style: 提示 }, t('countdownIdle')),
            h('div', { style: Object.assign({}, 说明, { marginTop: 14 }) }, state.message || (settling ? t('settlingTitle') : t('countdownBody'))),
            h(
              'button',
              {
                type: 'button',
                style: 按钮,
                onClick: function () {
                  if (cancelledBox.current) return
                  cancelledBox.current = true
                  suppressBox.current = Date.now() + 1500
                  setState(function (prev) {
                    if (!prev || (prev.phase !== 'counting' && prev.phase !== 'settling')) return prev
                    var next = Object.assign({}, prev)
                    next.phase = 'cancelled'
                    next.deadline = 0
                    next.cancelReason = 'api'
                    next.message = ''
                    return next
                  })
                  void postCancel('api')
                },
              },
              t('cancel'),
            ),
          ),
        )
      }

      // ── 等人齐：右下角悬浮卡片，不拦指针 ─────────────────────────────
      if (phase === 'waiting') {
        var 挡路的 = Array.isArray(state.blockers) ? state.blockers : []
        var 发起者 = state.sessionName ? String(state.sessionName) : ''
        var 发起者id = state.sessionId ? String(state.sessionId) : ''
        return h(
          'div',
          { style: 悬浮外壳 },
          h(
            'div',
            { style: 悬浮卡片, role: 'status', 'aria-live': 'polite' },
            h(
              'div',
              { style: 悬浮标题 },
              h('span', { style: 红点 }),
              t('waitingTitle'),
              h('span', { style: Object.assign({}, 说明, { marginLeft: 'auto', fontSize: 11 }) }, t('waitingLimit')),
            ),
            h(
              'div',
              { style: 说明 },
              t('waitingInitiator'),
              h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, 发起者 || 短id(发起者id)),
              ' — ',
              String(state.blockerCount || 挡路的.length || 0),
              t('waitingQueue'),
            ),
            h.apply(
              null,
              [
                'div',
                { style: Object.assign({}, 说明, { marginTop: 8 }) },
                挡路的.length > 0 ? t('waitingBlockers') : t('waitingNone'),
              ].concat(
                挡路的.slice(0, 4).map(function (b, i) {
                  return h(
                    'div',
                    { key: i, style: { marginTop: 2 } },
                    h('span', { style: 红点 }),
                    String(b.label || b.kind || '—'),
                    b.id
                      ? h('span', { style: { opacity: 0.7, marginLeft: 4 } }, '（' + 显示名(b) + '）')
                      : null,
                  )
                }),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                style: 按钮,
                onClick: function () {
                  void postCancel('api')
                  setState(function (prev) {
                    if (!prev) return prev
                    return Object.assign({}, prev, { phase: 'cancelled', deadline: 0, cancelReason: 'api' })
                  })
                },
              },
              t('cancel'),
            ),
          ),
        )
      }

      // ── 三种终止：都留一张带出口的纸 ─────────────────────────────────
      // 「发起过一次重启、最后没重启」这件事必须在界面上留下痕迹，否则等于没发生过。
      // 收摊靠「知道了」，不自动消失。
      var 终止 =
        phase === 'blocked'
          ? { title: t('blockedTitle'), body: t('blockedBody') }
          : phase === 'cancelled'
            ? { title: t('cancelledTitle'), body: t('cancelledBody') + '（' + 取消原因文案(state.cancelReason) + '）' }
            : phase === 'failed'
              ? { title: t('failedTitle'), body: t('failedBody') }
              : null

      if (终止) {
        var 明细 = Array.isArray(state.blockers) ? state.blockers : []
        // Host 的 message 优先（它知道这次到底卡在哪）；没有就用本地文案兜底。
        var 正文 = state.message ? String(state.message) : 终止.body
        return h(
          'div',
          { style: 遮罩, role: 'presentation' },
          h(
            'div',
            { style: 卡片, role: 'dialog', 'aria-live': phase === 'cancelled' ? 'polite' : 'assertive' },
            h('div', { style: 标题行 }, 终止.title),
            h('div', { style: Object.assign({}, 说明, { marginTop: 8 }) }, 正文),
            phase === 'cancelled' ? null : h(
              'div',
              { style: Object.assign({}, 说明, { marginTop: 10 }) },
              明细.slice(0, 5).map(function (b, i) {
                return h(
                  'div',
                  { key: i, style: { marginTop: 2 } },
                  h('span', { style: 红点 }),
                  String(b.label || b.kind || '—'),
                  b.id ? h('span', { style: { opacity: 0.7, marginLeft: 4 } }, '（' + 显示名(b) + '）') : null,
                )
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                style: 按钮主,
                onClick: function () {
                  setState(function (prev) {
                    if (!prev) return prev
                    return Object.assign({}, prev, { phase: 'idle', blockers: [], cancelReason: '', message: '' })
                  })
                  void postDismiss()
                },
              },
              t('ok'),
            ),
          ),
        )
      }

      return null
    }

    // ── 设置页 ─────────────────────────────────────────────────────────────
    var 分组 = {
      marginBottom: 22,
    }

    var 分组标题 = {
      fontSize: 13,
      fontWeight: 600,
      marginBottom: 10,
      color: 'var(--dsw-alias-label-primary)',
    }

    var 行 = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 16,
      padding: '10px 0',
      borderTop: '1px solid var(--dsw-alias-border-l3)',
    }

    var 行标签 = {
      flex: '0 0 190px',
      fontSize: 13,
      color: 'var(--dsw-alias-label-primary)',
      paddingTop: 6,
    }

    var 行主体 = {
      flex: '1 1 auto',
      minWidth: 0,
    }

    var 提示 = {
      fontSize: 12,
      lineHeight: 1.5,
      marginTop: 4,
      color: 'var(--dsw-alias-label-tertiary)',
    }

    var 输入 = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 9px',
      fontSize: 13,
      fontFamily: 'inherit',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-base)',
      border: '1px solid var(--dsw-alias-border-l3)',
      borderRadius: 7,
      outline: 'none',
    }

    var 只读值 = {
      fontSize: 12,
      lineHeight: 1.6,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      color: 'var(--dsw-alias-label-secondary)',
      wordBreak: 'break-all',
    }

    /** 开关：role="switch" + aria-checked，键盘可达。 */
    function 开关(props) {
      var checked = props.checked === true
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          onClick: function () {
            props.onChange(!checked)
          },
          style: {
            position: 'relative',
            width: 36,
            height: 20,
            padding: 0,
            borderRadius: 999,
            cursor: 'pointer',
            border: '1px solid ' + (checked ? 'transparent' : 'var(--dsw-alias-border-l3)'),
            background: checked ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-bg-layer-3)',
            transition: 'background 120ms ease',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--dsw-alias-switch-thumb)',
            transition: 'left 120ms ease',
          },
        }),
      )
    }

    function 带标签(props) {
      return h(
        'div',
        { style: 行 },
        h('div', { style: 行标签 }, props.label),
        h(
          'div',
          { style: 行主体 },
          props.children,
          props.hint ? h('div', { style: 提示 }, props.hint) : null,
        ),
      )
    }

    /**
     * 按钮入口的三个呈现（侧栏底部 / 会话标题栏 / 设置行）。
     *
     * 它们共用同一个动作：POST /restart → Host 调 tool.execute()，
     * 和 agent 调 restart_dsh 完全同一条链。按钮**不**自己判断能不能重启。
     *
     * 状态来源：轮询 /state。phase 不是 idle 时按钮变「正在重启…」并禁用，
     * 避免连点 —— 连点会在 Host 侧被 already-running 拦掉，但让用户看到
     * 一个没反应的按钮是更差的体验。
     */
    function useRestartButton() {
      var box = React.useState(null)
      var state = box[0]
      var setState = box[1]
      var busyBox = React.useState(false)
      var busy = busyBox[0]
      var setBusy = busyBox[1]

      React.useEffect(function () {
        var stopped = false
        var timer = 0
        function loop() {
          readState()
            .then(function (next) {
              if (stopped) return
              setState(next)
            })
            .catch(function () {
              // 读不到就静默（Host 没起来 / 路由没注册）
            })
            .then(function () {
              if (stopped) return
              var 忙 = state && state.phase !== 'idle'
              timer = window.setTimeout(loop, 忙 ? 1000 : 5000)
            })
        }
        loop()
        return function () {
          stopped = true
          if (timer) window.clearTimeout(timer)
        }
      }, [])

      var phase = state ? state.phase : 'idle'
      var 进行中 = phase !== 'idle'
      var disabled = busy || 进行中

      var click = function () {
        if (disabled) return
        setBusy(true)
        postJson('/restart', {})
          .then(function () {
            // 成功进入倒计时；下一次轮询会把 phase 变成 counting
          })
          .catch(function () {
            // 失败就恢复按钮，让用户能重试
          })
          .then(function () {
            setBusy(false)
          })
      }

      return {
        phase: phase,
        busy: busy,
        disabled: disabled,
        label: 进行中 ? t('btnWaiting') : t('btnRestart'),
        hint: t('btnRestartHint'),
        click: click,
      }
    }

    /**
     * ② 侧栏左上角面板（sidebar.panellist + main，**必须成对**）。
     *
     * 座位只把 `{ size, active }` 传给图标：整行（按钮/tooltip/文字/选中态）
     * 都由侧栏自己画，我们只提供图标 —— 这样这一条看起来一定是官方的。
     *
     * 两处必须同时注册：侧栏点这条时调 `ctx.layout.selectPanel(PANEL_ID)`，
     * 若 `main` 里没有同名 key，**selectPanel 会抛错**。
     * 所以注册代码里两者写在一起，不给「只注册一半」留缝。
     */
    var PANEL_ID = PKG + '-panel'

    /**
     * 官方描边权重表。**完整规范见 `rules/references_icons.local.md`。**
     *
     * 应用的图标不是一个一个画的，而是从 `@deepseek-ai/dsh-client-ui-primitives`
     * 的 sprite 里取 `<symbol>`（`Qv` 存 path、`Vp` 存档位、`mL` 拼 sprite），
     * 粗细只有两档：
     *
     *   Vp = { regular: 1, medium: 1.3 }        // 源码里的 Br = 1.3
     *
     * **档位要按座位对齐邻近的官方图标，不是全局统一：**
     *   - `sidebar.panellist` → regular = 1：同一列表的「更多」是
     *     `IconAppsAddOutlineRegular`，我们是同一列，必须同档；
     *   - `settings.section.icon` → medium = 1.3：官方 `navIcon()` 兜底给的
     *     全是 `...OutlineMedium`，注册到那里的图标要用 medium 才不显细。
     *
     * 2026-11-09 用户反馈「重启图标的颜色跟官方一样」，量像素确认：
     * 官方那两个图标描边 ~1px，我们的 ~2px（1.5 + 圆头端点叠加）。
     */
    var ICON_STROKE = { regular: 1, medium: 1.3 }

    /**
     * 本插件在侧栏用的档位。
     *
     * 之所以单独起个名字：以后若也给 `settings.section.icon` 画图标，
     * 那里要换成 `ICON_STROKE.medium`，别顺手复用这个常量。
     */
    var SIDEBAR_ICON_WEIGHT = 'regular'

    /**
     * 官方 `refresh-outline` 的原始 path 数据（从 app.asar 的 ICON_ARTWORK 抄出）。
     *
     * **不要自己改 path**：官方图标的坐标是 16×16 网格上对齐过视觉重心的，
     * 自己画一个「看起来差不多」的圆弧，放大到 18px 时和旁边图标基线就对不上。
     */
    var REFRESH_ARC =
      'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1'
    var REFRESH_ARROW = 'M14.4999 1.5V5.1H10.8999'

    /**
     * 圆弧箭头图标 —— 与官方 `IconRefreshOutlineMedium` 完全同源。
     *
     * **一律用 SVG，不要用 '⟳' 文字**：文字有字体度量和基线，和旁边的 SVG 图标
     * 对不齐，颜色也难和其它图标一致。
     *
     * 也**不要加 `strokeLinecap: 'round'` / `strokeLinejoin: 'round'`**：
     * 官方全部用默认的 butt/miter，加圆头等于把笔画两端各撑粗半个线宽，
     * 在 16px 上看起来就是「加粗了一档」。
     */
    function RefreshIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16
      var weight = ICON_STROKE[(props && props.weight) || SIDEBAR_ICON_WEIGHT] || ICON_STROKE.regular
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          strokeWidth: weight,
          'aria-hidden': 'true',
          style: { display: 'block', flex: 'none' },
        },
        h('path', { d: REFRESH_ARC, stroke: 'currentColor' }),
        h('path', { d: REFRESH_ARROW, stroke: 'currentColor' }),
      )
    }

    /**
     * 侧栏左上角那一行的图标。
     *
     * 侧栏只把 `{ size, active }` 传进来，外层套一个 `display:inline-flex` 的
     * `panelGlyph` 容器（无固定宽高）。所以：
     *   ① **必须用 SVG，不能用文字字形** —— 文字有字体度量和基线，
     *      和官方那些 SVG 图标在视觉上对不齐（2026-11-09 用户反馈「没对齐」）；
     *   ② 尺寸跟 `props.size`（wide=16 / 窄=18），别写死；
     *   ③ 描边用 `currentColor` —— 颜色自动跟父级走，深色/浅色主题都不用手动适配，
     *      也不会出现「颜色和旁边不一样」（用户反馈的第二点）。
     */
    /**
     * 主区面板：侧栏点「重启应用」后显示的内容。
     *
     * 它不是动作位，所以给一段说明 + 一个主按钮，而不是一个光秃秃的图标。
     */
    function RestartPanel() {
      var b = useRestartButton()
      return h(
        'div',
        { style: { padding: '16px 18px', fontFamily: 'inherit' } },
        h(
          'h2',
          {
            style: {
              margin: '0 0 6px',
              fontSize: 16,
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary)',
            },
          },
          t('nav'),
        ),
        h(
          'p',
          {
            style: {
              margin: '0 0 14px',
              fontSize: 13,
              lineHeight: 1.6,
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          b.hint,
        ),
        b.phase !== 'idle'
          ? h(
              'div',
              {
                style: {
                  marginBottom: 12,
                  fontSize: 12,
                  color: 'var(--dsw-alias-label-secondary)',
                },
              },
              '当前状态：' + b.phase,
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            title: b.hint,
            disabled: b.disabled,
            style: {
              padding: '8px 18px',
              fontSize: 13,
              borderRadius: 8,
              cursor: b.disabled ? 'default' : 'pointer',
              opacity: b.disabled ? 0.6 : 1,
              color: 'var(--dsw-alias-label-primary)',
              background: 'var(--dsw-alias-bg-secondary)',
              border: '1px solid var(--dsw-alias-border-secondary)',
              fontFamily: 'inherit',
            },
            onClick: b.click,
          },
          b.label,
        ),
      )
    }

    function PanelGlyph(props) {
      // 侧栏只传 { size, active }；颜色靠 currentColor 跟随父级。
      // weight 必须一起透传：漏传会让 RefreshIcon 落到默认档，
      // 以后把这个图标复用到设置页（medium=1.3）时会静默变细。
      return h(RefreshIcon, {
        size: props && typeof props.size === 'number' ? props.size : 16,
        weight: props && props.weight,
      })
    }

    /**
     * 设置页导航行的图标。
     *
     * 与侧栏那个**不是同一档**：设置页 `navIcon()` 的兜底全是
     * `...OutlineMedium`（medium = 1.3），所以这里要传 medium；
     * 照抄侧栏的 regular 会让这一行显得偏细。
     * 详见 rules/references_icons.local.md「各座位用的是哪一档」。
     *
     * 座位只传 `{ size, active }`；颜色靠 currentColor 跟随 nav 行的
     * `color: var(--dsw-alias-label-primary)`。
     */
    function SettingsGlyph(props) {
      return h(RefreshIcon, {
        size: props && typeof props.size === 'number' ? props.size : 16,
        weight: 'medium',
      })
    }

    /** ② 会话标题栏按钮：只有图标 + 短标签，order 15 */
    function HeaderRestartButton() {
      var b = useRestartButton()
      return h(
        'button',
        {
          type: 'button',
          title: b.hint,
          'aria-label': b.label,
          disabled: b.disabled,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            fontSize: 12,
            borderRadius: 6,
            cursor: b.disabled ? 'default' : 'pointer',
            opacity: b.disabled ? 0.6 : 1,
            color: 'var(--dsw-alias-label-secondary)',
            background: 'transparent',
            border: '1px solid var(--dsw-alias-border-secondary)',
            fontFamily: 'inherit',
          },
          onClick: b.click,
        },
        h(RefreshIcon, { size: 14 }),
        h('span', null, b.label),
      )
    }

    /** ③ 设置 → 通用 行：左说明右按钮 */
    function SettingsGeneralRow() {
      var b = useRestartButton()
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '8px 2px',
          },
        },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t('nav')),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, b.hint),
        ),
        h(
          'button',
          {
            type: 'button',
            title: b.hint,
            disabled: b.disabled,
            style: {
              padding: '4px 12px',
              fontSize: 12,
              borderRadius: 6,
              cursor: b.disabled ? 'default' : 'pointer',
              opacity: b.disabled ? 0.6 : 1,
              color: 'var(--dsw-alias-label-primary)',
              background: 'var(--dsw-alias-bg-secondary)',
              border: '1px solid var(--dsw-alias-border-secondary)',
              fontFamily: 'inherit',
            },
            onClick: b.click,
          },
          b.label,
        ),
      )
    }

    function RestartSettings() {
      var dataBox = React.useState(null) // { value, meta }
      var data = dataBox[0]
      var setData = dataBox[1]

      var formBox = React.useState(null)
      var form = formBox[0]
      var setForm = formBox[1]

      var saveBox = React.useState(0) // 0 = 未保存 / 1 = 保存中 / 2 = 成功 / -1 = 失败
      var saveState = saveBox[0]
      var setSaveState = saveBox[1]

      var runBox = React.useState(null)
      var lastRun = runBox[0]
      var setLastRun = runBox[1]

      var langBox = React.useState(LANG)
      var setLangState = langBox[1]

      // 语言切换时重渲染（label 全部经 t()）
      React.useEffect(
        function () {
          var fn = function () {
            setLangState(LANG)
          }
          langSubs.push(fn)
          return function () {
            var i = langSubs.indexOf(fn)
            if (i >= 0) langSubs.splice(i, 1)
          }
        },
        [],
      )

      React.useEffect(
        function () {
          var stopped = false
          readSettings()
            .then(function (res) {
              if (stopped) return
              setData(res)
              setForm(res.value)
            })
            .catch(function () {})
          readLastRun()
            .then(function (res) {
              if (stopped) return
              setLastRun(res)
            })
            .catch(function () {})
          return function () {
            stopped = true
          }
        },
        [],
      )

      if (!data || !form) {
        return h('div', { style: Object.assign({}, 说明, { padding: '12px 0' }) }, t('loading'))
      }

      function 改(key, value) {
        setForm(function (prev) {
          var next = Object.assign({}, prev)
          next[key] = value
          return next
        })
        setSaveState(0)
      }

      function 保存() {
        setSaveState(1)
        postJson('/settings', form)
          .then(function (body) {
            if (body && body.ok) {
              setData({ value: body.value, meta: data.meta })
              setForm(body.value)
              setSaveState(2)
            } else {
              setSaveState(-1)
            }
          })
          .catch(function () {
            setSaveState(-1)
          })
      }

      var meta = data.meta || {}
      var limits = meta.limits || {}
      var wakeModes = Array.isArray(meta.wakeModes) ? meta.wakeModes : []

      function 区间(key) {
        var pair = limits[key]
        if (!Array.isArray(pair) || pair.length < 2) return ''
        return t('range') + ' ' + pair[0] + '–' + pair[1]
      }

      var 保存文案 =
        saveState === 1 ? t('saving') : saveState === 2 ? t('saved') : saveState === -1 ? t('saveFailed') : t('save')

      return h(
        'div',
        { style: { padding: '4px 0 24px' } },
        h('div', { style: Object.assign({}, 说明, { marginBottom: 18 }) }, t('sectionHint')),

        // ── 通用 ───────────────────────────────────────────────────────
        h(
          'div',
          { style: 分组 },
          h('div', { style: 分组标题 }, t('fieldAllow')),
          h(
            带标签,
            { label: t('fieldAllow'), hint: t('fieldAllowHint') },
            h(开关, {
              checked: form.allowAutoRestart !== false,
              onChange: function (v) {
                改('allowAutoRestart', v)
              },
            }),
          ),
          h(
            带标签,
            { label: t('fieldWakeMode') },
            h(
              'select',
              {
                style: 输入,
                value: form.wakeMode || 'plugin',
                onChange: function (e) {
                  改('wakeMode', e.target.value)
                },
              },
              wakeModes.map(function (m) {
                return h('option', { key: m.value, value: m.value }, String(m.label || m.value))
              }),
            ),
            wakeModes.length
              ? h(
                  'div',
                  { style: 提示 },
                  wakeModes
                    .map(function (m) {
                      return String(m.label || m.value) + '：' + String(m.hint || '')
                    })
                    .join('　'),
                )
              : null,
          ),
          h(
            带标签,
            { label: t('fieldAutoSay'), hint: t('fieldAutoSayHint') },
            h('input', {
              style: 输入,
              type: 'text',
              maxLength: 200,
              value: form.autoSay || '',
              onChange: function (e) {
                改('autoSay', e.target.value)
              },
            }),
          ),
          h(
            带标签,
            { label: t('fieldCountdown'), hint: t('fieldCountdownHint') + '　' + 区间('countdownSec') },
            h('input', {
              style: 输入,
              type: 'number',
              min: limits.countdownSec && limits.countdownSec[0],
              max: limits.countdownSec && limits.countdownSec[1],
              value: form.countdownSec === undefined ? '' : form.countdownSec,
              onChange: function (e) {
                改('countdownSec', Number(e.target.value))
              },
            }),
          ),
          h(
            带标签,
            { label: t('fieldTimeout'), hint: t('fieldTimeoutHint') + '　' + 区间('timeoutSec') },
            h('input', {
              style: 输入,
              type: 'number',
              min: limits.timeoutSec && limits.timeoutSec[0],
              max: limits.timeoutSec && limits.timeoutSec[1],
              value: form.timeoutSec === undefined ? '' : form.timeoutSec,
              onChange: function (e) {
                改('timeoutSec', Number(e.target.value))
              },
            }),
          ),
          h(
            带标签,
            { label: t('fieldLogKeep'), hint: 区间('logKeep') },
            h('input', {
              style: 输入,
              type: 'number',
              min: limits.logKeep && limits.logKeep[0],
              max: limits.logKeep && limits.logKeep[1],
              value: form.logKeep === undefined ? '' : form.logKeep,
              onChange: function (e) {
                改('logKeep', Number(e.target.value))
              },
            }),
          ),
          h(
            带标签,
            { label: t('fieldLaunch'), hint: t('fieldLaunchHint') },
            h('input', {
              style: 输入,
              type: 'text',
              placeholder: '—',
              value: form.launchCommand || '',
              onChange: function (e) {
                改('launchCommand', e.target.value)
              },
            }),
          ),
        ),

        // ── 保存 ───────────────────────────────────────────────────────
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 } },
          h(
            'button',
            { type: 'button', style: 按钮主, disabled: saveState === 1, onClick: 保存 },
            保存文案,
          ),
          saveState === -1 ? h('span', { style: Object.assign({}, 提示, { color: 'var(--dsw-alias-label-error)' }) }, t('saveFailed')) : null,
        ),

        // ── 只读现状 ───────────────────────────────────────────────────
        h(
          'div',
          { style: 分组 },
          h('div', { style: 分组标题 }, t('metaTitle')),
          h(
            'div',
            { style: 行 },
            h('div', { style: 行标签 }, t('metaScript')),
            h('div', { style: 行主体 }, h('div', { style: 只读值 }, String(meta.scriptPath || '—'))),
          ),
          h(
            'div',
            { style: 行 },
            h('div', { style: 行标签 }, t('metaStateDir')),
            h('div', { style: 行主体 }, h('div', { style: 只读值 }, String(meta.stateDir || '—'))),
          ),
          h(
            'div',
            { style: 行 },
            h('div', { style: 行标签 }, t('metaLogDir')),
            h('div', { style: 行主体 }, h('div', { style: 只读值 }, String(meta.logDir || '—'))),
          ),
          h(
            'div',
            { style: 行 },
            h('div', { style: 行标签 }, t('metaLastRun')),
            h(
              'div',
              { style: 行主体 },
              h(
                'div',
                { style: 只读值 },
                lastRun
                  ? (lastRun.at ? new Date(lastRun.at).toLocaleString() + '　' : '') +
                    (lastRun.timedOut
                      ? t('lastRunTimeout')
                      : lastRun.exitCode === 0
                        ? t('lastRunOk')
                        : t('lastRunFail') + ' ' + String(lastRun.exitCode))
                  : t('lastRunNone'),
              ),
            ),
          ),
        ),
      )
    }

    // ── 装配 ───────────────────────────────────────────────────────────────
    return {
      name: PKG,
      inject: ['slots'],
      apply: function (ctx) {
        // locale 服务用 ctx.inject 挂：它可能比本插件晚就绪，
        // 装配时直接读 ctx.locale 会错过它。拿不到就退回内联字典，
        // 界面照常显示，只是不跟随语言切换。
        try {
          ctx.inject(['locale'], function (scope) {
            var locale = scope.locale
            if (!locale) return
            if (typeof locale.register === 'function') {
              scope.effect(function () {
                return locale.register(NS, DICT)
              }, PKG + ': locale')
            }
            var read = function () {
              try {
                var snap = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null
                return snap && snap.active ? snap.active : null
              } catch (e) {
                void e
                return null
              }
            }
            setLang(read())
            if (typeof locale.subscribe === 'function') {
              scope.effect(function () {
                return locale.subscribe(function () {
                  setLang(read())
                })
              }, PKG + ': locale subscribe')
            }
          })
        } catch (e) {
          void e
        }

        var slots = ctx.slots
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          // 没有 slots 服务 → 这个 profile 不是 web 组合，静默不上屏。
          return
        }

        // 倒计时/等待/终止页。座位 id 与其它重启插件不撞。
        ctx.effect(function () {
          return slots.inject('shell.overlay', function () {
            return slots.register({ name: 'shell.overlay', id: OVERLAY_ID, order: 100 }, RestartOverlay)
          })
        }, PKG + ': overlay slot')

        // ── 按钮入口（继承自 restart-now 的四个座位）──────────────────────
        //
        // 四个入口共用同一个动作：POST /restart → Host 侧调 tool.execute()，
        // 和 agent 调 restart_dsh 走**完全相同**的判定链路（判忙、倒计时、等人齐）。
        // 按钮不自作聪明地「立即重启」——那样就绕过了所有安全检查。
        // ② 侧栏左上角面板：**必须成对**注册。
        //    侧栏点这条时调 selectPanel(PANEL_ID)，main 里没有同名 key 会抛错，
        //    所以两者写在同一个 effect 里，不给「只注册一半」留缝。
        ctx.effect(function () {
          var d1 = slots.inject('sidebar.panellist', function () {
            return slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: function () { return t('nav') } },
              PanelGlyph,
            )
          })
          var d2 = slots.inject('main', function () {
            return slots.register({ name: 'main', key: PANEL_ID }, RestartPanel)
          })
          return function () {
            if (typeof d1 === 'function') d1()
            if (typeof d2 === 'function') d2()
          }
        }, PKG + ': sidebar panel + main')

        // ② 会话标题栏按钮：order 15（官方 jobs 是 20，排在它前才不被挤右）
        ctx.effect(function () {
          return slots.inject('conversation.session.header.actions', function () {
            return slots.register(
              { name: 'conversation.session.header.actions', id: PKG, order: 15 },
              HeaderRestartButton,
            )
          })
        }, PKG + ': header action slot')

        // ③ 设置 → 通用 行
        ctx.effect(function () {
          return slots.inject('settings.general.item', function () {
            return slots.register(
              { name: 'settings.general.item', id: PKG, order: 91 },
              SettingsGeneralRow,
            )
          })
        }, PKG + ': settings general row')

        // 设置页。始终注册：关掉入口也能从这里回来。
        ctx.effect(function () {
          return slots.inject('settings.section', function () {
            return slots.register(
              { name: 'settings.section', id: SETTINGS_ID, order: 900, label: function () { return t('nav') } },
              RestartSettings,
            )
          })
        }, PKG + ': settings slot')

        // 设置页导航行的图标。
        //
        // 不注册这个座位，官方 `navIcon()` 会给一个**齿轮**兜底 —— 于是
        // 「重启应用」和旁边一堆没有专属图标的插件行撞脸。注册后显示
        // 自己的圆弧箭头。
        //
        // **id 必须等于 SETTINGS_ID**：官方按
        // `renderSlot(..., { only: row.id })` 精确配对，配不上就还是走
        // fallback 齿轮。档位用 medium（1.3），与 navIcon 兜底同档，
        // 理由见 SettingsGlyph 的注释。
        ctx.effect(function () {
          return slots.inject('settings.section.icon', function () {
            return slots.register(
              { name: 'settings.section.icon', id: SETTINGS_ID },
              SettingsGlyph,
            )
          })
        }, PKG + ': settings nav icon slot')
      },
    }
  },
})
