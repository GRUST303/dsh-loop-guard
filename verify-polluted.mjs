// 验证「历史对话也管用」的机制：当上下文里已经有污染历史时，
// 密度判据会怎么表现？会不会反复触发？
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

const registered = new Map()
const logs = []
const ctx = { logger: { info: (m, ...a) => logs.push([m, ...a]) }, on: (e, h) => registered.set(e, h) }
apply(ctx, { debug: true })
const handler = registered.get('agent/pre-step')

const msg = (text, role) => ({ id: `${Math.random()}`, role, content: [{ type: 'text', text }] })

// 模拟一个「已经被污染的历史」会话，然后连续跑几步，看会触发几次
const a = { id: 'polluted-session' }
// 历史里塞 3 条污染消息（每条都是 ROLLING_TEXT 那种刷屏）
let messages = [
  msg('请检查 client 画面差异', 'user'),
  msg(ROLLING_TEXT, 'assistant'),
  msg(ROLLING_TEXT, 'assistant'),
  msg(ROLLING_TEXT, 'assistant'),
]

console.log('模拟场景：历史里已有 3 条污染消息（各 ~' + ROLLING_TEXT.length + ' 字符）\n')
console.log('步  注入数  触发原因')
for (let step = 1; step <= 6; step += 1) {
  // 每步模型都输出新的正常内容（模拟被提醒后恢复正常）
  const normalReply = `第 ${step} 步的正式回复：已完成 client 画面差异分析，差异 4.2%，角色模型正常渲染。下一步检查纹理贴图。`
  messages = [...messages, msg(normalReply, 'assistant')]
  const mark = logs.length
  const out = await handler({ agent: a, messages, turn: 1, step }, async () => ({ kind: 'enter', messages }))
  const added = out.messages.length - messages.length
  const reason = logs.slice(mark).map((x) => x[1]).join('; ') || '-'
  console.log(`${String(step).padStart(2)}  ${String(added).padStart(6)}  ${reason}`)
  messages = out.messages
}

console.log('\n=== 结论 ===')
console.log(`6 步共注入 ${logs.length - 1} 次（第 1 条是激活日志）`)

// 对照：如果模型在被提醒后继续循环（不恢复），会怎样
console.log('\n=== 对照：模型被提醒后仍继续刷屏 ===')
const b = { id: 'unrecovered' }
let m2 = [msg('开始', 'user')]
let injections = 0
for (let step = 1; step <= 5; step += 1) {
  m2 = [...m2, msg(ROLLING_TEXT, 'assistant')]
  const before = logs.length
  const out = await handler({ agent: b, messages: m2, turn: 1, step }, async () => ({ kind: 'enter', messages: m2 }))
  if (out.messages.length > m2.length) injections += 1
  m2 = out.messages
  console.log(`  步 ${step}: 注入 ${out.messages.length > 0 ? (out.messages.length - (m2.length - (out.messages.length - m2.length))) : 0} 条`)
}
console.log(`  5 步共注入 ${injections} 次`)
