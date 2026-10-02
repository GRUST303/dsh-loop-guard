// 多帧 zstd 解压器：DSH 的 session.v4.jsonl.zstd 是「每行一个独立 zstd 帧」。
// 单次 zstdDecompressSync 只返回第一帧，这就是之前只解出 189 字节的原因。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function decompressFrames(buf) {
  const frames = []
  let i = 0
  while (i < buf.length) {
    const next = buf.indexOf(MAGIC, i + 4)
    frames.push(next === -1 ? buf.subarray(i) : buf.subarray(i, next))
    if (next === -1) break
    i = next
  }
  let text = ''
  let ok = 0
  let bad = 0
  const sizes = []
  for (const frame of frames) {
    try {
      const out = zstdDecompressSync(frame)
      sizes.push(out.length)
      text += out.toString('utf8')
      if (!text.endsWith('\n')) text += '\n'
      ok += 1
    } catch { bad += 1 }
  }
  return { text, frames: frames.length, ok, bad, sizes }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const file = process.argv[2]
  const buf = readFileSync(file)
  const r = decompressFrames(buf)
  console.log(`文件 ${buf.length} 字节 -> ${r.frames} 帧, 成功 ${r.ok}, 失败 ${r.bad}`)
  console.log(`解压后文本 ${r.text.length} 字符, ${r.text.split('\n').filter((l) => l.trim()).length} 行`)
  console.log(`单帧大小分布: min=${Math.min(...r.sizes)} max=${Math.max(...r.sizes)} avg=${Math.round(r.sizes.reduce((a, b) => a + b, 0) / r.sizes.length)}`)
  const events = r.text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const types = {}
  for (const e of events) types[e.type ?? '?'] = (types[e.type ?? '?'] ?? 0) + 1
  console.log(`\n解析 ${events.length} 个事件, 类型分布:`)
  for (const [k, v] of Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${k}: ${v}`)
  const big = events.filter((e) => JSON.stringify(e).length > 800).slice(0, 1)
  if (big[0]) console.log(`\n较大事件样例:\n${JSON.stringify(big[0]).slice(0, 800)}`)
  const dk = new Set()
  for (const e of events) if (e.data && typeof e.data === 'object') for (const k of Object.keys(e.data)) dk.add(k)
  console.log(`\ndata 键: ${[...dk].join(', ')}`)
  const mk = new Set()
  for (const e of events) if (e.data?.message && typeof e.data.message === 'object') for (const k of Object.keys(e.data.message)) mk.add(k)
  console.log(`data.message 键: ${[...mk].join(', ')}`)
}
