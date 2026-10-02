// 静态自检：不依赖运行 DSH，把「UI 是否会出现」的前置条件全部验掉。
// UI 本身要重启才能看到，但下面每一条都是它出现/工作的必要条件。
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const dir = 'G:/DSH/Test/plugin-dl/packages/dsh-loop-guard'
let pass = 0
let fail = 0
const check = (label, ok, extra) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` -> ${extra ?? ''}`}`)
  ok ? (pass += 1) : (fail += 1)
}

console.log('=== A. host 端 (lib/index.js) ===')
const hostPath = `${dir}/lib/index.js`
const hostSrc = readFileSync(hostPath, 'utf8')
const host = await import(`file:///${hostPath}`)
check('name 导出', host.name === 'loop-guard', host.name)
check('apply 是函数', typeof host.apply === 'function')
// Config 必须是 Standard Schema：裸 JS 对象会让 cordis 的 resolveConfig 抛
// "Cannot read properties of undefined (reading 'validate')" 并让整个 profile 起不来。
check(
  'Config 是 Standard Schema（~standard.validate）',
  host.Config !== undefined && typeof host.Config['~standard']?.validate === 'function',
  host.Config === undefined ? 'undefined' : typeof host.Config['~standard'],
)
check('Config.validate 能产出默认值', (() => {
  try {
    const v = host.Config['~standard'].validate({}).value
    return typeof v?.repeatDensity === 'number' && v.preset === 'balanced'
  } catch { return false }
})())
// 仅在代码行里检查（排除注释 —— 注释提到过这些反模式，会误伤断言）
const codeLines = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
check('不含 settings.register 调用（legacy 路径已移除）', !codeLines(hostSrc).includes('settings.register('))
check('含 PRESETS 档位表', hostSrc.includes('const PRESETS'))
// 只在代码行里检查，排除注释（注释里提到过这些反模式，会误伤断言）
const hostCode = hostSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
check('apply 是同步（防阻塞关键）', /export function apply\(ctx, config\)/.test(hostSrc))
check('不含 await ctx.inject（曾致插件永久挂起）', !hostCode.includes('await ctx.inject'))
check('不含 settings.register 调用（legacy，别人环境没有）', !hostCode.includes('settings.register'))
check('空行必须先排除（曾是 12.5% 误报根因）', hostSrc.includes('if (line.length === 0) continue'))
check('导出 Config（官方 0.1.7 设置页路径）', hostSrc.includes('export const Config'))
check('有 import schemastery', hostSrc.includes("from '@deepseek-ai/schemastery'"))
check('无 default export（官方禁止与 Config 混用）', !hostCode.includes('export default'))

console.log('\n=== B. package.json 接入 ===')
const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
check('exports["./client"] 指向 client.js', pkg.exports?.['./client'] === './lib/client.js', JSON.stringify(pkg.exports?.['./client']))
check('dsh.client 存在', typeof pkg.dsh?.client === 'object')
check('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web')
check('dsh.client.inject 已声明', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0)
check('注入含 client-ui-settings', pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
check('注入含 client-locale', pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
check('immediately: true（官方模板要求）', pkg.dsh.client.immediately === true)
check('meta.title 已声明（插件卡片）', typeof pkg.meta?.title === 'string' && pkg.meta.title.length > 0)
check('dsh.bundle.patch 仍在', pkg.dsh?.bundle?.patch === './cordis.patch.yml')

console.log('\n=== C. 客户端 (lib/client.js) ===')
const clientPath = `${dir}/lib/client.js`
check('文件存在', existsSync(clientPath))
const clientSrc = readFileSync(clientPath, 'utf8')
check('是 ModuleLoader 格式', clientSrc.includes('window.__ModuleLoader__.load('))
check('id 与包名一致', clientSrc.includes('id: "dsh-loop-guard"'))
check('require primitives', clientSrc.includes('@deepseek-ai/dsh-client-ui-primitives'))
check('注册到 settings.plugins.tab（有宿主的槽位）', clientSrc.includes('"settings.plugins.tab"'))
check('不使用无宿主的 plugins.item', !clientSrc.includes('"plugins.item"'))
check('用 whileServed 等待 namespace（不是试一次就放弃）', clientSrc.includes('whileServed'))
check('用 SegmentedControl 做档位', clientSrc.includes('primitives.SegmentedControl'))
check('用 SettingsFormModel', clientSrc.includes('primitives.SettingsFormModel'))
check('用 SettingsValueField', clientSrc.includes('primitives.SettingsValueField'))
check('namespace 为 loop-guard', clientSrc.includes('"loop-guard"'))
check('含中英双语文案', clientSrc.includes('循环断路器') && clientSrc.includes('Loop guard'))

console.log('\n=== D. 前后端档位值一致性 ===')
{
  // 用正则提取，避免对源码形态做 JSON.parse 假设。
  const hostBlock = (hostSrc.match(/const PRESETS = \{[\s\S]*?\n\}/) ?? [''])[0]
  const clientBlock = (clientSrc.match(/const PRESET_VALUES = \{[^}]*\}/) ?? [''])[0]
  const hostValues = {}
  for (const m of hostBlock.matchAll(/(\w+):\s*\{[\s\S]*?repeatDensity:\s*([\d.]+)/g)) {
    hostValues[m[1]] = Number(m[2])
  }
  const clientValues = {}
  for (const m of clientBlock.matchAll(/(\w+):\s*([\d.]+)/g)) {
    clientValues[m[1]] = Number(m[2])
  }
  check('host 解析出 3 个档位', Object.keys(hostValues).length === 3, JSON.stringify(hostValues))
  check('client 解析出 3 个档位', Object.keys(clientValues).length === 3, JSON.stringify(clientValues))
  for (const key of ['conservative', 'balanced', 'aggressive']) {
    const h = hostValues[key]
    const c = clientValues[key]
    check(`档位 ${key} 前后端一致 (${h} vs ${c})`, h !== undefined && c !== undefined && Math.abs(h - c) < 1e-9, `${h} / ${c}`)
  }
}

console.log('\n=== E. 客户端语法（虚拟 window 下执行 factory）===')
{
  const jsx = { jsx: () => null, jsxs: () => null, Fragment: null }
  const primitivesStub = new Proxy({}, { get: () => function Stub() { return null } })
  let captured = null
  const fakeWindow = {
    __ModuleLoader__: {
      load: (mod) => { captured = mod },
    },
  }
  const require = (id) => {
    if (id === 'react/jsx-runtime') return jsx
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    throw new Error(`unexpected require: ${id}`)
  }
  try {
    // 用 Function 包一层，给出 window 与 require
    const fn = new Function('window', 'require', clientSrc)
    fn(fakeWindow, require)
    check('factory 加载成功', captured !== null)
    const mod = captured.factory(require)
    check('导出 apply', typeof mod.apply === 'function')
    check('导出 inject 数组', Array.isArray(mod.inject))
    check('导出 NS', typeof mod.NS === 'string', mod.NS)
  } catch (error) {
    check('factory 加载成功', false, String(error?.message ?? error))
  }
}

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
