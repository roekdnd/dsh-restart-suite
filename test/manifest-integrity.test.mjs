/**
 * package.json 的「承诺」必须兑现 —— L13（INCIDENT-20261109）。
 *
 * 事故：本包在 package.json 里声明了 exports["./client"] 和
 * dsh.client.platform='web'，但 client.js 从未落地。宿主启动时强校验，
 * 缺失即抛 client bundles not found；而 modules 是 **required** 插件，
 * 它不激活 → 整个应用起不来（DesktopHostFatalError）。
 *
 * 那天至少 3 次启动全部 fatal。这条检查跑 3 毫秒，本来能挡住它。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const 包根 = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(包根, 'package.json'), 'utf8'))

/** 把 exports 的值拆成具体文件路径（跳过通配符条目）。 */
function 展开导出(value) {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') {
    return Object.values(value).filter((v) => typeof v === 'string')
  }
  return []
}

test('exports 里每个路径都真实存在', () => {
  const 缺失 = []
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    for (const rel of 展开导出(value)) {
      // 通配符（./locale/*.json）不逐条展开，只要求目录存在
      if (rel.includes('*')) {
        const dir = join(包根, dirname(rel))
        if (!existsSync(dir)) 缺失.push(`exports["${key}"] 的目录不存在: ${dirname(rel)}`)
        continue
      }
      if (!existsSync(join(包根, rel))) 缺失.push(`exports["${key}"] → ${rel}`)
    }
  }
  assert.deepEqual(缺失, [], `exports 指向不存在的文件（宿主启动会 fatal）：\n${缺失.join('\n')}`)
})

test('main / dsh.bundle.patch 指向的文件存在', () => {
  assert.ok(existsSync(join(包根, pkg.main)), `main 指向不存在的文件: ${pkg.main}`)
  const patch = pkg.dsh?.bundle?.patch
  if (patch) assert.ok(existsSync(join(包根, patch)), `dsh.bundle.patch 指向不存在的文件: ${patch}`)
})

test('声明了 dsh.client 就必须有真实的 client bundle（本次事故的直接原因）', () => {
  const client = pkg.dsh?.client
  if (!client) return // 没声明就不要求
  const entry = pkg.exports?.['./client']
  assert.ok(entry, '声明了 dsh.client 却没有 exports["./client"]')
  const file = typeof entry === 'string' ? entry : entry?.default
  assert.ok(file, 'exports["./client"] 必须是字符串或含 default')
  const full = join(包根, file)
  assert.ok(existsSync(full), `声明了 dsh.client，但 ${file} 不存在 —— 这会让应用启动 fatal`)
  assert.ok(statSync(full).size > 0, `${file} 是空文件，等同于不存在`)
})

test('client.js 的模块 id 必须等于 package.json 的 name', () => {
  const client = pkg.dsh?.client
  if (!client) return
  const file =
    typeof pkg.exports?.['./client'] === 'string'
      ? pkg.exports['./client']
      : pkg.exports?.['./client']?.default
  if (!file || !existsSync(join(包根, file))) return
  const src = readFileSync(join(包根, file), 'utf8')

  // id 可能是字面量，也可能是个常量（本包用的是 `id: PKG`）。两种都要认。
  // 注释里也出现过这个字符串，要取**真正调用**的那处（最后一次出现）
  const loadIdx = src.lastIndexOf('__ModuleLoader__.load(')
  assert.ok(loadIdx >= 0, 'client.js 里没找到 __ModuleLoader__.load(...)')
  const head = src.slice(loadIdx, loadIdx + 600)

  const m = head.match(/id\s*:\s*([A-Za-z_$][\w$]*|'[^']+'|"[^"]+")/)
  assert.ok(m, 'load({...}) 里没有 id 字段')
  const expr = m[1]

  let actual = ''
  if (expr.startsWith("'") || expr.startsWith('"')) {
    actual = expr.slice(1, -1)
  } else {
    // 常量形式：找 `var NAME = '...'` / `const NAME = '...'`。
    // 不用正则拼装 —— 之前这里因为 Python/JS 双重转义反复写错，改成逐行查找。
    let actual2 = ''
    for (const line of src.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('var ') && !t.startsWith('const ') && !t.startsWith('let ')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      const namePart = t.slice(t.indexOf(' ') + 1, eq).trim()
      if (namePart !== expr) continue
      const val = t.slice(eq + 1).trim()
      const q = val[0]
      if (q === "'" || q === '"') {
        const endQ = val.indexOf(q, 1)
        if (endQ > 0) actual2 = val.slice(1, endQ)
      }
      break
    }
    assert.ok(actual2, 'id 引用了变量 ' + expr + '，但没找到它的定义')
    actual = actual2
  }

  assert.equal(actual, pkg.name, '模块 id（' + actual + '）必须等于包名（' + pkg.name + '）')
})

test('cordis.patch.yml 的 name 必须等于 package.json 的 name', () => {
  const patchPath = join(包根, pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml')
  if (!existsSync(patchPath)) return
  const text = readFileSync(patchPath, 'utf8')
  const m = text.match(/name:\s*['"]?([^'"\n]+)['"]?/)
  assert.ok(m, 'cordis.patch.yml 里没找到 name')
  assert.equal(m[1].trim(), pkg.name, 'loader 条目名必须等于包名（客户端模块按它配对）')
})

test('dsh.client 声明的 external 必须是数组（缺失即 []）', () => {
  const client = pkg.dsh?.client
  if (!client) return
  if (client.external !== undefined) {
    assert.ok(Array.isArray(client.external), 'dsh.client.external 必须是数组')
  }
})
