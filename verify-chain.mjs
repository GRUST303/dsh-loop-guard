// 长链真实性验证：用累积的 messages（含自己注入的提醒）驱动，确认：
//   1. 跨步判据按 crossStepThreshold 的整数倍注入（3/6/9），不会每次重复注入；
//   2. 注入的提醒不会被当成新的重复项（source.kind 过滤生效）。
import { apply } from 'file:///G:/DSH/Test/plugin-dl/packages/dsh-loop-guard/lib/index.js'

const registered = new Map()
const ctx = { logger: { info: () => {} }, on: (e, h) => registered.set(e, h) }
apply(ctx, { thresholds: [3, 5, 8], minChars: 12, debug: false })
const handler = registered.get('agent/pre-step')
const agent = { id: 'long-chain' }

const msg = (text) => ({ id: `${Math.random()}`, role: 'assistant', content: [{ type: 'text', text }] })
const SAME = '好。写。执行。好。写。执行。好。写。执行。'

let messages = []
const injections = []
for (let step = 1; step <= 10; step += 1) {
  messages = [...messages, msg(SAME)]
  const payload = { agent, messages, turn: 1, step }
  const out = await handler(payload, async () => ({ kind: 'enter', messages }))
  const added = out.messages.length - messages.length
  if (added > 0) injections.push({ step, added, sources: out.messages.slice(-added).map((m) => m.source?.kind) })
  messages = out.messages
}

console.log('=== 注入轨迹（期望在 crossStepThreshold=3 的整数倍注入：3/6/9）===')
for (const i of injections) console.log(`  step ${i.step}: +${i.added}  source=${JSON.stringify(i.sources)}`)
const injectedSteps = injections.map((i) => i.step).join(',')
console.log(`\n实际注入步: [${injectedSteps}]`)

let failed = 0
const expect = (label, ok, extra) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` -> ${extra}`}`)
  if (!ok) failed += 1
}
console.log('\n=== 断言 ===')
expect('仅在 3/6/9 注入（阈值整数倍）', injectedSteps === '3,6,9', injectedSteps)
expect('每次只注入 1 条', injections.every((i) => i.added === 1))
expect('注入消息 source.kind 均为 loop-guard', injections.every((i) => i.sources.every((s) => s === 'loop-guard')))
expect('10 步内共注入 3 次（无级联）', injections.length === 3, `${injections.length} 次`)
const guildCount = injections.flatMap((i) => i.sources).filter((s) => s !== 'loop-guard').length
expect('无非法 source', guildCount === 0)

console.log(`\n=== 结果: ${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} ===`)
process.exit(failed === 0 ? 0 : 1)
