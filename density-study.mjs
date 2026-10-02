// 在全部真实会话消息上测「窗口重复密度」的分布，确定阈值。
// 目标是三分类能力：正常文档/代码 ~0%，表格 ~15%，真循环 ~60%。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decompressFrames } from './zstd-frames.mjs'

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

// 窗口重复密度：滑动窗内出现次数 >1 的行占全部行的比例
function windowDensity(text, W = 12) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  const n = lines.length
  if (n < W) return 0
  let acc = 0
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - W + 1)
    const win = lines.slice(lo, i + 1)
    const cnt = new Map()
    for (const w of win) cnt.set(w, (cnt.get(w) ?? 0) + 1)
    acc += win.filter((w) => cnt.get(w) > 1).length / win.length
  }
  return acc / n
}

const samples = []
for (const p of walk(root)) {
  let r
  try { r = decompressFrames(readFileSync(p)) } catch { continue }
  const events = r.text.split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  for (const e of events) {
    if (e.type !== 'assistant/message') continue
    const t = blockText(e.data?.message) || blockText(e.data)
    if (!t || t.trim().length < 100) continue
    samples.push({ file: p.split(/[\\/]/).slice(-2)[0], text: t, d: windowDensity(t) })
  }
}

console.log(`样本 ${samples.length} 条\n`)
const ds = samples.map((s) => s.d).sort((a, b) => a - b)
const q = (p) => ds[Math.min(ds.length - 1, Math.floor(ds.length * p))]
console.log('窗口重复密度分位:')
for (const p of [0.5, 0.8, 0.9, 0.95, 0.99, 1.0]) {
  console.log(`  p${(p * 100).toFixed(0).padStart(3)}: ${(q(p === 1 ? 0.9999 : p) * 100).toFixed(1)}%`)
}

console.log('\n各阈值命中数（误伤评估）:')
for (const th of [0.3, 0.4, 0.5, 0.6, 0.7]) {
  const hit = samples.filter((s) => s.d >= th)
  console.log(`  >= ${(th * 100).toFixed(0)}%: ${String(hit.length).padStart(4)} 条 (${(hit.length / samples.length * 100).toFixed(2)}%)`)
}

const top = samples.filter((s) => s.d >= 0.5).sort((a, b) => b.d - a.d)
console.log(`\n=== 密度 >= 50% 的样本（前 12 条）===`)
for (const s of top.slice(0, 12)) {
  console.log(`  ${(s.d * 100).toFixed(1).padStart(5)}%  ${s.file.padEnd(44)} len=${s.text.length}`)
}
if (top[0]) {
  console.log(`\n最高密度样本的中段（${top[0].file}, ${(top[0].d * 100).toFixed(1)}%）:`)
  const mid = Math.floor(top[0].text.length * 0.4)
  console.log(top[0].text.slice(mid, mid + 400))
}
