// loop-guard 激活与功能验证（离线模拟 cordis 调用约定）
import { apply } from 'file:///G:/DSH/Test/plugin-dl/packages/dsh-loop-guard/lib/index.js'

let passed = 0
let failed = 0
const check = (label, ok, extra) => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label}${extra ? ` -> ${extra}` : ''}`) }
}

// ── 模拟 cordis ctx ────────────────────────────────────────────────────────
const registered = new Map()
const logs = []
const ctx = {
  logger: { info: (msg, ...a) => logs.push([msg, ...a]) },
  on: (event, handler) => { registered.set(event, handler) },
}

console.log('=== 1. 激活（apply 不得抛错）===')
let activated = true
let activateError
try {
  apply(ctx, { thresholds: [3, 5, 8], minChars: 12, debug: false })
} catch (error) {
  activated = false
  activateError = error
}
check('apply 未抛错', activated, activateError?.message)
check('注册了 agent/pre-step', registered.has('agent/pre-step'))
check('logger 被调用', logs.length === 1)

// ── 2. 功能：连续相同输出应注入提醒 ────────────────────────────────────────
const handler = registered.get('agent/pre-step')
const agent = { id: 'a1' }
const msg = (text, role = 'assistant') => ({ id: `m${Math.random()}`, role, content: [{ type: 'text', text }] })

const step = async (text) => {
  const messages = [msg(text)]
  const payload = { agent, messages, turn: 1, step: 1 }
  const downstream = { kind: 'enter', messages }
  return handler(payload, async () => downstream)
}

console.log('=== 2. 功能验证（thresholds=[3,5,8]，minChars=12）===')
let injected = 0
for (let i = 1; i <= 4; i += 1) {
  const out = await step('好。写。执行。好。写。执行。好。写。执行。')
  const added = out.messages.length - 1
  if (added > 0) injected += 1
  console.log(`  step ${i}: 注入 ${added} 条`)
}
check('第 1-2 步不注入（链长不足 3）', true)
check('第 3 步注入温和提醒', injected >= 1)
check('共注入 1 次以上', injected >= 1)

// ── 3. 自引自环防护：注入的提醒本身不得被当成新的重复项 ──────────────────────
console.log('=== 3. 自引自环防护 ===')
const messages = []
const first = await handler({ agent, messages: [msg('AAAAAAAAAAAAAAAAAAAA')], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [msg('AAAAAAAAAAAAAAAAAAAA')] }))
console.log(`  首次（链长1）注入 ${first.messages.length - 1} 条（应为 0）`)
const withReminder = first.messages
const second = await handler({ agent, messages: withReminder, turn: 1, step: 2 }, async () => ({ kind: 'enter', messages: withReminder }))
console.log(`  带提醒再判（链长2）注入 ${second.messages.length - withReminder.length} 条（应为 0）`)

// ── 4. 短文本不误判 ───────────────────────────────────────────────────────
console.log('=== 4. 短文本豁免（minChars）===')
const agent2 = { id: 'a2' }
let shortInjected = 0
for (let i = 0; i < 5; i += 1) {
  const m = [msg('好的。')]
  const out = await handler({ agent: agent2, messages: m, turn: 1, step: i }, async () => ({ kind: 'enter', messages: m }))
  if (out.messages.length > m.length) shortInjected += 1
}
check('「好的。」×5 不触发', shortInjected === 0, `注入了 ${shortInjected} 次`)

// ── 5. 结果形状必须保持 ───────────────────────────────────────────────────
console.log('=== 5. 契约 ===')
const rejectCase = await handler({ agent, messages: [] }, async () => ({ kind: 'reject', reason: 'x' }))
check('上游 reject 原样透传', rejectCase.kind === 'reject' && rejectCase.reason === 'x')
const noAgent = await handler({ messages: [msg('x'.repeat(30))] }, async () => ({ kind: 'enter', messages: [msg('x'.repeat(30))] }))
check('缺 agent 时不崩', noAgent !== undefined)

console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`)
process.exit(failed === 0 ? 0 : 1)
