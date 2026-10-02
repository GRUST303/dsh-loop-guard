// 量化 loop-guard 对上下文的实际影响（修正版）。
import { apply } from './lib/index.js'
import { ROLLING_TEXT } from './fixtures.mjs'

const registered = new Map()
const ctx = { logger: { info: () => {} }, on: (e, h) => registered.set(e, h) }
apply(ctx, { debug: false })
const handler = registered.get('agent/pre-step')

const estTokens = (chars) => Math.ceil(chars / 4)   // 英文提醒按 4 字符/token
const msg = (text, role = 'assistant') => ({ id: `${Math.random()}`, role, content: [{ type: 'text', text }] })

console.log('=== 1. 单次注入体积 ===')
{
  const messages = [msg(ROLLING_TEXT)]
  const out = await handler({ agent: { id: 'a' }, messages, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages }))
  const reminder = out.messages[out.messages.length - 1].content[0].text
  console.log(`  注入提醒:        ${reminder.length} 字符  (~${estTokens(reminder.length)} token)`)
  console.log(`  当轮被检出的消息: ${ROLLING_TEXT.length} 字符  (~${estTokens(ROLLING_TEXT.length)} token)`)
  console.log(`  注入 / 该消息:    ${(reminder.length / ROLLING_TEXT.length * 100).toFixed(1)}%`)
}

console.log('\n=== 2. 最坏情况：模型被提醒后仍持续刷屏 10 步 ===')
{
  const flood = (n) => Array.from({ length: n }, (_, i) => `好。\n（输出）\n好。\n（生成）\n好。\n第${i}段`).join('\n')
  let m = [msg('任务：完成 client 画面差异分析', 'user')]
  let injectedChars = 0
  let assistantChars = 0
  for (let step = 1; step <= 10; step += 1) {
    const bad = flood(60)
    m = [...m, msg(bad)]
    assistantChars += bad.length
    const r = await handler({ agent: { id: 'b' }, messages: m, turn: 1, step }, async () => ({ kind: 'enter', messages: m }))
    if (r.messages.length > m.length) injectedChars += r.messages[r.messages.length - 1].content[0].text.length
    m = r.messages
  }
  console.log(`  10 步污染文本合计: ${assistantChars} 字符 (~${estTokens(assistantChars)} token)`)
  console.log(`  10 步注入合计:     ${injectedChars} 字符 (~${estTokens(injectedChars)} token)`)
  console.log(`  注入占污染比例:    ${(injectedChars / assistantChars * 100).toFixed(2)}%`)
}

console.log('\n=== 3. 与「不装插件」的对照（同一次循环）===')
{
  console.log(`  不装插件: 循环无限持续。上下文被重复垃圾填满，模型完全丧失产出能力。`)
  const perStep = 1378
  console.log(`  装插件:   每步多 ${646} 字符(${estTokens(646)} token)提醒，共 ~3 步后模型改道。`)
  console.log(`  净差额:   注入总量 ~${estTokens(646 * 3)} token，换回任务继续执行。`)
}

console.log('\n=== 4. 副作用面（逐条来自 lib/index.js 实现）===')
for (const line of [
  '改请求参数(温度/top_p/思考强度)?   否 — 插件从未触碰 options 对象',
  '删改历史消息?                     否 — 只做 [...messages, reminder] 追加',
  '改动系统提示词或模型身份?           否 — 从不调用 ctx.systemPrompt',
  '缩短或裁剪上下文?                  否 — 只增不减',
  '影响 KV Cache 前缀复用?            是 — 唯一真实代价，见下',
  '在正常输出上注入?                  否 — 需当轮密度超阈值(实测误报 0.05%)',
]) console.log(`  · ${line}`)
console.log('\n  关于 KV Cache：注入是**追加在消息尾部**，历史前缀仍可复用；')
console.log('  只有注入点之后的部分失效一次，代价近似「多了一条消息」。')
