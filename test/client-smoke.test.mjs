/**
 * client.js 冒烟测试 —— 在 Node 里用最小 hook 运行时把浏览器半边真跑一遍。
 *
 * 目的不是「测 UI 好不好看」，而是三件会真出事的事：
 *   ① bundle 能被 `window.__ModuleLoader__` 接住，且 id 等于包名
 *      （id 不对或文件缺失 = 启动时 modules 插件不激活，整个 app 起不来）
 *   ② `apply(ctx)` 能按契约在 `shell.overlay` 和 `settings.section` 上注册
 *      （`slots.register` 对同一 key 二次注册会 throw）
 *   ③ 八个 phase 的渲染分支都不抛异常
 *      （组件里抛一次就把座位打成空白，且控制台只留一行 slot entry crashed）
 *
 * 这里**故意**自己实现 useState/useRef/useEffect 而不是装 React：
 * 组件只需要这三个 hook，手写的运行时能把「渲染第 N 次时的状态」精确喂进去，
 * 比真渲染器更适合逐 phase 断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// ── 最小 hook 运行时 ──────────────────────────────────────────────────────
// 每个组件实例一份 slots（按 hook 调用顺序）。setState 打 dirty 标记，
// 挂载循环看到标记就重渲染，重渲染把游标归零、按同样顺序复用 slots —— 和 React 的模型一致。
//
// 关键：rerender 必须**持续存在**，因为组件里的数据是 fetch 回来的，
// 状态更新发生在首帧之后的微任务里。渲染一次就撤掉 rerender，等于永远停在「读取中…」。
function createRuntime() {
  let slots = []
  let cursor = 0
  let effects = []
  let dirty = false

  const React = {
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props)
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState(initial) {
      const i = cursor
      cursor += 1
      if (slots[i] === undefined) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }
      return [slot.value, set]
    },
    useRef(initial) {
      const i = cursor
      cursor += 1
      if (slots[i] === undefined) slots[i] = { value: { current: initial } }
      return slots[i].value
    },
    useEffect(fn, deps) {
      const i = cursor
      cursor += 1
      const prev = slots[i]
      const same =
        prev &&
        Array.isArray(deps) &&
        Array.isArray(prev.deps) &&
        deps.length === prev.deps.length &&
        deps.every((d, k) => Object.is(d, prev.deps[k]))
      if (same) return
      slots[i] = { deps }
      effects.push(fn)
    },
  }

  /**
   * 挂载组件并跑到稳定：首帧 → 跑 effect（发起 fetch）→ 等微任务 → 状态更新 →
   * 重渲染，直到连续两轮都没有 dirty 为止。
   */
  async function render(Component) {
    const cleanups = []
    let tree = null
    let passes = 0

    for (;;) {
      passes += 1
      if (passes > 40) throw new Error('render did not settle（组件可能在自我重渲染循环）')

      dirty = false
      cursor = 0
      effects = []
      tree = Component()

      for (const fn of effects) {
        const out = fn()
        if (typeof out === 'function') cleanups.push(out)
      }

      // 等一拍，让 effect 里发起的 Promise 落地
      await flush()
      if (!dirty) break
    }

    for (const fn of cleanups) {
      try {
        fn()
      } catch (e) {
        void e
      }
    }
    return tree
  }

  return { React, render }
}

const flush = () => new Promise((r) => setImmediate(r))

/**
 * 元素树遍历。
 *
 * 真 React 会把 `h(SomeComponent, props)` 当组件渲染，本运行时不会——它只造元素。
 * 所以遍历时遇到函数类型的 type 就展开它。安全性前提：这两个子组件（`带标签`、
 * `开关`）都不调用 hook，因此在渲染上下文之外直接调用它们不会打乱 hook 顺序。
 */
function expand(node) {
  if (node && typeof node === 'object' && typeof node.type === 'function') {
    return expand(node.type(node.props || {}))
  }
  return node
}

/** 在元素树里找所有文本。 */
function texts(node, out = []) {
  node = expand(node)
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (node.props) texts(node.props.children, out)
  return out
}

/** 在元素树里按 props 找元素。 */
function findAll(node, pred, out = []) {
  node = expand(node)
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out)
    return out
  }
  if (node.props && pred(node)) out.push(node)
  if (node.props) findAll(node.props.children, pred, out)
  return out
}

// ── 宿主环境桩 ────────────────────────────────────────────────────────────
/** 一次测试用的假宿主：按 phase 返回快照，并记录所有到 API 的请求。 */
function installHost({ state, settings, meta, lastRun } = {}) {
  const calls = []

  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        globalThis.__loaded = spec
      },
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout() { return 0 },
    clearTimeout() {},
    setInterval() { return 0 },
    clearInterval() {},
  }

  globalThis.document = {
    documentElement: { getAttribute: () => 'zh-CN' },
  }

  // Node 24 把 navigator 暴露成只读 getter，直接赋值会 throw，只能 defineProperty。
  Object.defineProperty(globalThis, 'navigator', {
    value: { languages: ['zh-CN'], language: 'zh-CN' },
    configurable: true,
    writable: true,
  })

  const payloadFor = (path) => {
    if (path.endsWith('/state')) return { ok: true, value: state }
    if (path.endsWith('/settings')) return { ok: true, value: settings || {}, meta: meta || {} }
    if (path.endsWith('/last-run')) return { ok: true, value: lastRun || null }
    if (path.endsWith('/viewer')) return { ok: true, value: { started: true } }
    return { ok: true }
  }

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', headers: (init && init.headers) || {} })
    const body = payloadFor(String(url))
    return { ok: true, status: 200, json: async () => body }
  }

  return calls
}

// ── 载入 bundle ───────────────────────────────────────────────────────────
async function loadBundle(React) {
  delete globalThis.__loaded
  // 每次换一个 query 绕开 ESM 模块缓存，让顶层 __ModuleLoader__.load 重新执行
  const href = new URL('../client.js', import.meta.url)
  await import(href.href + '?t=' + Math.random())
  assert.ok(globalThis.__loaded, 'bundle 没有调用 window.__ModuleLoader__.load')
  return globalThis.__loaded
}

function makeRequire(React) {
  return (id) => {
    if (id === 'react') return React
    throw new Error('unexpected require: ' + id)
  }
}

// ── 用例 ──────────────────────────────────────────────────────────────────

test('bundle 用包名登记，factory 返回 { name, inject, apply }', async () => {
  installHost({ state: { phase: 'idle' } })
  const rt = createRuntime()
  const spec = await loadBundle(rt.React)

  assert.equal(spec.id, 'dsh-restart-suite', 'id 必须等于 package.json 的 name')
  assert.equal(typeof spec.factory, 'function')

  const plugin = spec.factory(makeRequire(rt.React))
  assert.equal(plugin.name, 'dsh-restart-suite')
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply 在 shell.overlay 与 settings.section 上各注册一次', async () => {
  const calls = installHost({ state: { phase: 'idle' } })
  const rt = createRuntime()
  const spec = await loadBundle(rt.React)
  const plugin = spec.factory(makeRequire(rt.React))

  const registered = []
  const effects = []
  const ctx = {
    slots: {
      inject(owner, fn) {
        const dispose = fn()
        return () => { if (typeof dispose === 'function') dispose() }
      },
      register(descriptor, component) {
        registered.push({ descriptor, component })
        return () => {}
      },
    },
    effect(fn) {
      effects.push(fn)
      const out = fn()
      return () => { if (typeof out === 'function') out() }
    },
  }

  plugin.apply(ctx)

  const byName = (n) => registered.find((r) => r.descriptor.name === n)
  const owners = registered.map((r) => r.descriptor.name).sort()
  // 六个座位：倒计时遮罩 + 设置页 + 设置页图标 + 三个按钮入口
  assert.deepEqual(owners, [
    'conversation.session.header.actions',
    'main',
    'settings.general.item',
    'settings.section',
    'settings.section.icon',
    'shell.overlay',
    'sidebar.panellist',
  ])

  // 面板必须成对：sidebar.panellist 的 id 要等于 main 的 key，
  // 否则侧栏点它时 selectPanel(id) 找不到面板会抛错。
  const glyph = byName('sidebar.panellist')
  const mainPanel = byName('main')
  assert.ok(glyph && mainPanel, 'sidebar.panellist 与 main 必须同时注册')
  assert.equal(mainPanel.descriptor.key, glyph.descriptor.id, 'main 的 key 必须等于 panellist 的 id')

  // 座位 id 不能和 restart-now / autonomous 撞
  assert.equal(byName('shell.overlay').descriptor.id, 'dsh-restart-suite-overlay')
  assert.equal(byName('settings.section').descriptor.id, 'dsh-restart-suite-settings')
  // 设置页图标必须与 settings.section **同一个 id**：官方按
  // renderSlot(..., { only: row.id }) 精确配对，id 不一致就静默走
  // navIcon() 的齿轮兜底 —— 页面看起来正常，但图标根本不是我们的。
  assert.equal(
    byName('settings.section.icon').descriptor.id,
    byName('settings.section').descriptor.id,
    'settings.section.icon 的 id 必须等于 settings.section 的 id，否则永远显示齿轮兜底',
  )
  // header / settings.general 用包名做 id（与 restart-now 的 id 不同）
  assert.equal(byName('conversation.session.header.actions').descriptor.id, 'dsh-restart-suite')
  assert.equal(byName('settings.general.item').descriptor.id, 'dsh-restart-suite')
  // header 的 order 必须 < 20（官方 jobs 是 20，排在它前才不被挤右）
  assert.ok(byName('conversation.session.header.actions').descriptor.order < 20)
  // 每个组件都必须能渲染
  for (const r of registered) assert.equal(typeof r.component, 'function')
  void calls
  void effects
})

const PHASES = [
  { phase: 'idle' },
  { phase: 'counting', deadline: 0, countdownSec: 5, awaitingViewer: true },
  { phase: 'counting', deadline: Date.now() + 4000, countdownSec: 5, awaitingViewer: false },
  { phase: 'settling', deadline: Date.now() + 25000, countdownSec: 30 },
  { phase: 'waiting', deadline: 0, blockerCount: 2, sessionId: 'session-abcdef123456', sessionName: '重构 client 半边',
    blockers: [{ kind: 'agent', id: 'session-xyz', label: 'agent 正在跑', name: '别的工作区' }] },
  { phase: 'launching', deadline: 0 },
  { phase: 'blocked', blockers: [{ kind: 'job', id: 'job-1', label: '后台任务' }] },
  { phase: 'cancelled', cancelReason: 'input' },
  { phase: 'failed', message: '脚本没有起来：spawn ENOENT' },
]

test('overlay 在八个 phase 下都能渲染，且不抛', async () => {
  for (const state of PHASES) {
    installHost({ state })
    const rt = createRuntime()
    const spec = await loadBundle(rt.React)
    const plugin = spec.factory(makeRequire(rt.React))

    let Overlay = null
    plugin.apply({
      slots: {
        inject: (owner, fn) => fn(),
        register: (descriptor, component) => {
          if (descriptor.name === 'shell.overlay') Overlay = component
          return () => {}
        },
      },
      effect: (fn) => fn(),
    })
    assert.ok(Overlay, 'shell.overlay 没注册')

    const tree = await rt.render(Overlay)
    // idle 什么都不画，其余都必须画出东西
    if (state.phase === 'idle') {
      assert.equal(tree, null, 'idle 时不该画任何东西')
    } else {
      assert.ok(tree, `${state.phase} 阶段画出了 null`)
      assert.ok(texts(tree).length > 0, `${state.phase} 阶段没有任何文本`)
    }
  }
})

test('counting 且表未起时显示完整秒数，且只报到一次 /viewer', async () => {
  const state = { phase: 'counting', deadline: 0, countdownSec: 5, awaitingViewer: true }
  const calls = installHost({ state })
  const rt = createRuntime()
  const spec = await loadBundle(rt.React)

  let Overlay = null
  const plugin = spec.factory(makeRequire(rt.React))
  plugin.apply({
    slots: {
      inject: (owner, fn) => fn(),
      register: (descriptor, component) => {
        if (descriptor.name === 'shell.overlay') Overlay = component
        return () => {}
      },
    },
    effect: (fn) => fn(),
  })

  const tree = await rt.render(Overlay)
  await flush()

  assert.ok(texts(tree).includes('5'), '表未起时应显示完整设置秒数')
  const viewers = calls.filter((c) => c.url.endsWith('/viewer'))
  assert.equal(viewers.length, 1, `应只报到一次，实际 ${viewers.length} 次`)
  assert.equal(viewers[0].method, 'POST')
  // 门禁头必须在
  assert.equal(viewers[0].headers['x-dsh-restart-suite'], '1')
})

test('waiting 阶段用悬浮卡片，且不拦指针事件', async () => {
  const state = {
    phase: 'waiting', deadline: 0, blockerCount: 1, sessionId: 'session-abcdef123456',
    blockers: [{ kind: 'agent', id: 'session-xyz', label: 'agent 正在跑', name: '别的工作区' }],
  }
  installHost({ state })
  const rt = createRuntime()
  const spec = await loadBundle(rt.React)
  let Overlay = null
  const plugin = spec.factory(makeRequire(rt.React))
  plugin.apply({
    slots: {
      inject: (owner, fn) => fn(),
      register: (d, c) => { if (d.name === 'shell.overlay') Overlay = c; return () => {} },
    },
    effect: (fn) => fn(),
  })

  const tree = await rt.render(Overlay)
  // 外层容器必须 pointerEvents: 'none'，否则用户十分钟动不了界面
  assert.equal(tree.props.style.pointerEvents, 'none')
  // 全屏遮罩（inset: 0）不该出现在 waiting
  const masks = findAll(tree, (el) => el.props.style && el.props.style.inset === 0)
  assert.equal(masks.length, 0, 'waiting 不该用全屏遮罩')
  assert.ok(texts(tree).some((s) => s.includes('别的工作区')), '应显示阻塞会话的可读名字')
})

test('三种终止页都有「知道了」按钮，点击后回 idle 并 POST /dismiss', async () => {
  for (const state of [{ phase: 'blocked', blockers: [] }, { phase: 'cancelled', cancelReason: 'api' }, { phase: 'failed', message: 'x' }]) {
    const calls = installHost({ state })
    const rt = createRuntime()
    const spec = await loadBundle(rt.React)
    let Overlay = null
    const plugin = spec.factory(makeRequire(rt.React))
    plugin.apply({
      slots: {
        inject: (owner, fn) => fn(),
        register: (d, c) => { if (d.name === 'shell.overlay') Overlay = c; return () => {} },
      },
      effect: (fn) => fn(),
    })

    const tree = await rt.render(Overlay)
    const buttons = findAll(tree, (el) => el.type === 'button')
    assert.equal(buttons.length, 1, `${state.phase} 应只有一个出口按钮`)
    assert.equal(texts(buttons[0]).join(''), '知道了')

    buttons[0].props.onClick()
    await flush()
    assert.ok(calls.some((c) => c.url.endsWith('/dismiss') && c.method === 'POST'), `${state.phase} 没发 /dismiss`)
  }
})

test('设置页把 meta 里的只读现状画出来', async () => {
  installHost({
    state: { phase: 'idle' },
    settings: { allowAutoRestart: true, wakeMode: 'plugin', autoSay: '重启好了', countdownSec: 5, timeoutSec: 120, logKeep: 20, launchCommand: '' },
    meta: {
      wakeModes: [{ value: 'plugin', label: '插件直投', hint: '不碰页面' }, { value: 'script', label: '脚本输入', hint: 'CDP' }],
      scriptPath: 'C:\\app\\scripts\\Restart-应用.ps1',
      stateDir: 'C:\\Users\\x\\.dsh\\dsh-restart-suite',
      logDir: 'C:\\Users\\x\\.dsh\\dsh-restart-suite\\logs',
      limits: { countdownSec: [3, 600], timeoutSec: [10, 600], logKeep: [1, 200] },
    },
    lastRun: { at: 1794190871619, exitCode: 0, timedOut: false, command: '' },
  })
  const rt = createRuntime()
  const spec = await loadBundle(rt.React)
  let Settings = null
  const plugin = spec.factory(makeRequire(rt.React))
  plugin.apply({
    slots: {
      inject: (owner, fn) => fn(),
      register: (d, c) => { if (d.name === 'settings.section') Settings = c; return () => {} },
    },
    effect: (fn) => fn(),
  })

  const tree = await rt.render(Settings)
  await flush()
  const text = texts(tree).join('|')
  // 表单值在 props.value 上，不在文本节点里
  const inputs = findAll(tree, (el) => el.type === 'input')
  const values = inputs.map((el) => String(el.props.value ?? ''))
  const everything = text + '|' + values.join('|')

  assert.ok(text.includes('C:\\app\\scripts\\Restart-应用.ps1'), '没画脚本路径')
  assert.ok(everything.includes('重启好了'), '没回填 autoSay')
  assert.ok(text.includes('3–600') || text.includes('3-600'), '没画倒计时范围')
  assert.ok(text.includes('退出码 0'), '没画上一次运行结果')
})

// ── 三个按钮入口（继承自 restart-now）──────────────────────────────────
//
// 只断言「是函数」是不够的 —— 2026-11-09 的教训：测了类型没测行为。
// 这里把三个组件真渲染一遍，并检查它们的按钮在 idle 时可点、非 idle 时禁用。
const BUTTON_SLOTS = [
  ['conversation.session.header.actions', '会话标题栏'],
  ['settings.general.item', '设置行'],
]

async function 渲染按钮(slotName, state) {
  installHost({ state })
  const rt = createRuntime()
  const spec = await loadBundle(rt.React)
  const plugin = spec.factory(makeRequire(rt.React))

  let 组件 = null
  plugin.apply({
    slots: {
      inject: (_owner, fn) => fn(),
      register: (descriptor, component) => {
        if (descriptor.name === slotName) 组件 = component
        return () => {}
      },
    },
    effect: (fn) => fn(),
  })
  assert.ok(组件, `${slotName} 没注册`)
  return rt.render(组件)
}

/** 在渲染树里找第一个 <button>。 */
function 找按钮(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'button') return node
  const kids = node.props && node.props.children
  const list = Array.isArray(kids) ? kids : kids ? [kids] : []
  for (const k of list) {
    const found = 找按钮(k)
    if (found) return found
  }
  return null
}

for (const [slotName, 中文名] of BUTTON_SLOTS) {
  test(`${中文名}按钮：idle 时可点、非 idle 时禁用`, async () => {
    // idle：按钮可点
    const idleTree = await 渲染按钮(slotName, { phase: 'idle' })
    assert.ok(idleTree, `${中文名} 在 idle 下应渲染出东西`)
    const idleBtn = 找按钮(idleTree)
    assert.ok(idleBtn, `${中文名} 应包含 <button>`)
    assert.ok(!idleBtn.props.disabled, `${中文名} 在 idle 下不该禁用`)
    assert.equal(typeof idleBtn.props.onClick, 'function', `${中文名} 应有 onClick`)

    // counting：按钮禁用（避免连点）
    const busyTree = await 渲染按钮(slotName, { phase: 'counting', deadline: 0, countdownSec: 5, awaitingViewer: true })
    const busyBtn = 找按钮(busyTree)
    assert.ok(busyBtn.props.disabled, `${中文名} 在 counting 下必须禁用（防连点）`)
  })
}

test('按钮点击会 POST /restart（不是自己判断能不能重启）', async () => {
  // ⚠️ 不能用自己装的 globalThis.fetch —— installHost() 内部会覆盖它。
  // 用 installHost 返回的 calls 数组来断言（它记录所有真实发出的请求）。
  const calls = installHost({ state: { phase: 'idle' } })
  const rt = createRuntime()
  const spec = await loadBundle(rt.React)
  const plugin = spec.factory(makeRequire(rt.React))

  let 组件 = null
  plugin.apply({
    slots: {
      inject: (_o, fn) => fn(),
      register: (d, c) => {
        if (d.name === 'conversation.session.header.actions') 组件 = c
        return () => {}
      },
    },
    effect: (fn) => fn(),
  })
  const tree = await rt.render(组件)
  const btn = 找按钮(tree)
  assert.ok(btn, '应找到按钮')
  assert.equal(btn.props.disabled, false, 'idle 下按钮不该禁用（否则 onClick 会短路）')

  btn.props.onClick()
  await new Promise((r) => setTimeout(r, 50))

  const 触发 = calls.find((c) => c.url.includes('/restart') && c.method === 'POST')
  assert.ok(
    触发,
    `按钮应 POST /restart，实际请求：${calls.map((c) => c.method + ' ' + c.url).join(', ') || '(无)'}`,
  )
  // 门禁头不能漏（漏了 Host 会 403）
  assert.equal(触发.headers['x-dsh-restart-suite'], '1', '请求必须带门禁头')
})

test('面板组件（main 座位）能真实渲染，且按钮受 phase 控制', async () => {
  // 面板是 sidebar.panellist 点开后的主区内容，必须能画出东西
  const calls = installHost({ state: { phase: 'idle' } })
  const rt = createRuntime()
  const spec = await loadBundle(rt.React)
  const plugin = spec.factory(makeRequire(rt.React))

  let 面板 = null
  plugin.apply({
    slots: {
      inject: (_o, fn) => fn(),
      register: (d, c) => {
        if (d.name === 'main') 面板 = c
        return () => {}
      },
    },
    effect: (fn) => fn(),
  })
  assert.ok(面板, 'main 座位应注册面板组件')

  const tree = await rt.render(面板)
  assert.ok(tree, '面板应渲染出内容')
  const btn = 找按钮(tree)
  assert.ok(btn, '面板里应有重启按钮')
  assert.equal(btn.props.disabled, false, 'idle 下面板按钮可点')
  void calls
})

test('图标一律用 SVG，禁止用文字字形（对不齐 + 颜色不一致）', async () => {
  // 2026-11-09 用户反馈：侧栏「重启套件」那一行和其它行没对齐、颜色也不一样。
  // 根因是用文字字形 '⟳' —— 有字体度量和基线，和官方那些 SVG 图标对不齐。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // 去掉注释行再查，避免误伤说明文字
  const 代码行 = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n')

  assert.ok(
    !代码行.includes("'⟳'"),
    '代码里不得再用 ⟳ 文字字形；图标必须用 SVG（见 RefreshIcon）',
  )
  assert.ok(代码行.includes('RefreshIcon'), '应存在可复用的 SVG 图标组件')
  assert.ok(代码行.includes("stroke: 'currentColor'"), 'SVG 描边必须用 currentColor 才能跟随主题')
})

test('侧栏图标尺寸跟随 props.size（wide=16 / 窄=18）', async () => {
  const rt = createRuntime()
  const spec = await loadBundle(rt.React)
  const plugin = spec.factory(makeRequire(rt.React))

  let glyph = null
  plugin.apply({
    slots: {
      inject: (_o, fn) => fn(),
      register: (d, c) => {
        if (d.name === 'sidebar.panellist') glyph = c
        return () => {}
      },
    },
    effect: (fn) => fn(),
  })
  assert.ok(glyph, 'sidebar.panellist 应注册图标组件')

  // 侧栏传 18（窄态）时，SVG 必须跟着变。
  // 直接调组件函数：它没有 hook，是纯函数，返回的就是 vnode。
  // （rt.render 只做单层渲染，深层的函数组件不会被自动展开）
  // PanelGlyph 转发给 RefreshIcon，所以要展开两层
  var node = glyph({ size: 18, active: false })
  if (typeof node.type === 'function') {
    node = node.type(node.props)
  }
  assert.equal(node.type, 'svg', '最终必须渲染成 svg')
  assert.equal(node.props.width, 18, '宽度要跟随 props.size')
  assert.equal(node.props.height, 18, '高度要跟随 props.size')
})

test('图标描边必须跟官方权重表（regular=1 / medium=1.3），不得自己加粗', async () => {
  // 2026-11-09 用户反馈「重启图标的颜色跟官方一样」。
  // 量了像素才确认根因：官方侧栏图标走从 sprite 取的 stroke-width，
  // 权重表是 Vp = { regular: 1, medium: 1.3 }，侧栏用的是 regular。
  // 我们原来写死 1.5 还加了 strokeLinecap:'round'，等于两端各撑粗半个线宽
  // —— 同一套 currentColor 下必然比旁边的图标黑一档。
  const rt = createRuntime()
  const spec = await loadBundle(rt.React)
  const plugin = spec.factory(makeRequire(rt.React))

  let glyph = null
  plugin.apply({
    slots: {
      inject: (_o, fn) => fn(),
      register: (d, c) => {
        if (d.name === 'sidebar.panellist') glyph = c
        return () => {}
      },
    },
    effect: (fn) => fn(),
  })

  var node = glyph({ size: 16, active: false })
  if (typeof node.type === 'function') {
    node = node.type(node.props)
  }

  assert.equal(node.type, 'svg', '最终必须渲染成 svg')
  // stroke-width 挂在 svg 上（子 path 才是官方那种写法），且必须是 regular 档。
  // 依据：同一列的「更多」是 IconAppsAddOutlineRegular，同列必须同档。
  assert.equal(node.props.strokeWidth, 1, '侧栏图标必须用官方 regular 档描边（1）')

  const paths = [].concat(node.props.children || [])
  assert.ok(paths.length >= 2, 'refresh-outline 由圆弧 + 箭头两段 path 组成')
  for (const p of paths) {
    assert.equal(p.props.stroke, 'currentColor', '描边必须 currentColor，才能跟随主题')
    assert.equal(
      p.props.strokeWidth,
      undefined,
      'stroke-width 只能挂在 svg 上；给单条 path 再设一次会和官方不一致',
    )
    assert.equal(
      p.props.strokeLinecap,
      undefined,
      '官方不用圆头端点；加 round 等于把笔画撑粗半个线宽',
    )
    assert.equal(
      p.props.strokeLinejoin,
      undefined,
      '官方不用 round 连接；理由同上',
    )
  }
})

test('图标 path 数据必须与官方 refresh-outline 逐字一致', async () => {
  // 自己「看起来差不多」的圆弧，在 18px 下视觉重心和旁边图标对不上。
  // 官方 path 抄自 app.asar 的 ICON_ARTWORK['refresh-outline']，不许改坐标。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  assert.ok(
    src.includes(
      'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799',
    ),
    '圆弧段必须是官方 refresh-outline 的原始 path',
  )
  assert.ok(
    src.includes("'M14.4999 1.5V5.1H10.8999'"),
    '箭头段必须是官方 refresh-outline 的原始 path',
  )
  assert.ok(
    !src.includes('M13.5 8a5.5 5.5 0 1 1-1.61-3.89'),
    '不得再用早期自己画的圆弧（与官方路径不同，基线对不齐）',
  )
})

test('描边档位要按座位选：侧栏 regular(1) / 设置页 medium(1.3)', async () => {
  // 官方两个座位邻近的图标不是同一档，照抄错就会有一边显细或显粗：
  //   sidebar.panellist   → 同列「更多」是 IconAppsAddOutlineRegular  → 1
  //   settings.section.icon → navIcon() 兜底全是 ...OutlineMedium   → 1.3
  // 详见 rules/references_icons.local.md
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  assert.ok(
    /ICON_STROKE = \{ regular: 1, medium: 1\.3 \}/.test(src),
    '权重表必须与官方一致：regular=1 / medium=1.3',
  )

  const rt = createRuntime()
  const spec = await loadBundle(rt.React)
  const plugin = spec.factory(makeRequire(rt.React))

  let glyph = null
  plugin.apply({
    slots: {
      inject: (_o, fn) => fn(),
      register: (d, c) => {
        if (d.name === 'sidebar.panellist') glyph = c
        return () => {}
      },
    },
    effect: (fn) => fn(),
  })

  const render = (props) => {
    var node = glyph(props)
    if (typeof node.type === 'function') node = node.type(node.props)
    return node
  }

  // 侧栏默认必须落在 regular 档，不能因为忘了传 weight 就变成 medium
  assert.equal(render({ size: 16 }).props.strokeWidth, 1, '侧栏默认档位必须是 regular=1')
  assert.equal(render({ size: 16, weight: 'medium' }).props.strokeWidth, 1.3,
    '显式要 medium 时必须给 1.3（设置页那种场景会用）')
  assert.equal(render({ size: 16, weight: '不存在' }).props.strokeWidth, 1,
    '未知档位必须回落到 regular，不能渲染成 undefined')
})

test('设置页图标用 medium 档（1.3），与官方 navIcon 兜底同档', async () => {
  // 官方 navIcon() 兜底全是 ...OutlineMedium（medium = 1.3）。
  // 若照抄侧栏的 regular，设置页这一行会比旁边所有行都细一档。
  const rt = createRuntime()
  const spec = await loadBundle(rt.React)
  const plugin = spec.factory(makeRequire(rt.React))

  let glyph = null
  plugin.apply({
    slots: {
      inject: (_o, fn) => fn(),
      register: (d, c) => {
        if (d.name === 'settings.section.icon') glyph = c
        return () => {}
      },
    },
    effect: (fn) => fn(),
  })

  assert.ok(glyph, 'settings.section.icon 应注册图标组件')

  var node = glyph({ size: 16, active: false })
  if (typeof node.type === 'function') node = node.type(node.props)
  assert.equal(node.type, 'svg', '最终必须渲染成 svg')
  assert.equal(node.props.strokeWidth, 1.3, '设置页图标必须是 medium 档 1.3（navIcon 兜底同档）')
  assert.equal(node.props.width, 16, '设置页座位固定传 16，要跟随')

  // path 也必须和侧栏同源 —— 同一个图标不该在两个座位长得不一样
  for (const child of [].concat(node.props.children || [])) {
    assert.equal(child.props.stroke, 'currentColor')
    assert.equal(child.props.strokeLinecap, undefined, '不许加圆头端点')
  }
})
