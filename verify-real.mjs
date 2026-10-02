// 端到端验证 v3：既验证「用户真实循环形态」能逮住，又验证全量真实数据不误报。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decompressFrames } from './zstd-frames.mjs'
import { apply } from './lib/index.js'
import { ROLLING_TEXT } from './fixtures.mjs'

// 会话目录从 DSH_HOME 推导，避免把某台机器的绝对路径写死进仓库。
const DSH_HOME = process.env.DSH_HOME
if (!DSH_HOME) {
  console.error('需要 DSH_HOME 环境变量（指向 harness 根目录）。')
  process.exit(1)
}
const root = join(DSH_HOME, 'sessions')
const blockText = (m) => {
  const c = m?.content
  if (!Array.isArray(c)) return ''
  let o = ''
  for (const b of c) if (b?.type === 'text' && typeof b.text === 'string') o += b.text
  return o
}
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n); const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (n.endsWith('.jsonl.zstd') && st.size > 50000) out.push(p)
  }
  return out
}

// ── 插件实例 ────────────────────────────────────────────────────────────────
const registered = new Map()
const debugLogs = []
const ctx = { logger: { info: (m, ...a) => debugLogs.push([m, ...a]) }, on: (e, h) => registered.set(e, h) }
apply(ctx, { debug: true })
const handler = registered.get('agent/pre-step')

const run = async (agent, text) => {
  const messages = [{ id: 'x', role: 'assistant', content: [{ type: 'text', text }] }]
  const mark = debugLogs.length
  const out = await handler({ agent, messages, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages }))
  return { added: out.messages.length - messages.length, injected: out.messages.slice(messages.length), reason: debugLogs.slice(mark).map((x) => x[1]).join('; ') }
}

let failed = 0
const expect = (label, ok, extra) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` -> ${extra}`}`)
  if (!ok) failed += 1
}

console.log('激活日志:', JSON.stringify(debugLogs[0]?.[0]))
console.log()

// ── 1. 用户本轮的循环形态（关键回归）──────────────────────────────────────
console.log('=== 1. 用户本轮真实循环形态 ===')
const userRun = await run({ id: 'user-loop' }, ROLLING_TEXT)
expect('用户循环被逮住', userRun.added === 1, `注入 ${userRun.added} 条`)
if (userRun.injected[0]) {
  console.log(`  触发原因: ${userRun.reason}`)
  console.log(`  source: ${JSON.stringify(userRun.injected[0].source)}`)
  console.log(`  正文前 240 字符:\n${userRun.injected[0].content[0].text.slice(0, 240).split('\n').map((l) => '    ' + l).join('\n')}`)
}

// ── 2. 全量真实数据误报测试 ─────────────────────────────────────────────────
console.log('\n=== 2. 全量真实会话消息误报测试 ===')
const samples = []
for (const p of walk(root)) {
  let r
  try { r = decompressFrames(readFileSync(p)) } catch { continue }
  const events = r.text.split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  for (const e of events) {
    if (e.type !== 'assistant/message') continue
    const t = blockText(e.data?.message) || blockText(e.data)
    if (!t || t.trim().length < 120) continue
    samples.push({ file: p.split(/[\\/]/).slice(-2)[0], text: t })
  }
}
console.log(`样本 ${samples.length} 条`)

let hits = 0
const hitFiles = []
for (const s of samples) {
  const res = await run({ id: `s-${Math.random()}` }, s.text)
  if (res.added > 0) { hits += 1; hitFiles.push(`${s.file} (${res.reason})`) }
}
console.log(`触发数: ${hits} (${(hits / samples.length * 100).toFixed(2)}%)`)
for (const h of hitFiles.slice(0, 10)) console.log(`  ${h}`)

// 命中的应当全是真循环：命中率应远低于 1%
expect('误报率 < 1%', hits / samples.length < 0.01, `${(hits / samples.length * 100).toFixed(2)}%`)

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
