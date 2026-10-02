// dsh-loop-guard
//
// 纯文本死循环断路器 (pure-text degenerate-loop circuit breaker)。
//
// ═══ 为什么需要它 ═══
//
// DeepSeek V4.1 Flash 在 thinking 模式下有一种特有的退化故障（也叫
// degeneration / 重复吸引子）：模型不再推进任务，只在输出里反复吐同一段文本。
// 它由四个因素叠加造成，且与上下文长度无关：
//
//   1. thinking 默认开启、effort 偏高 —— CoT 体量最大，重复轨迹最长；
//   2. 请求带 tools 时，DeepSeek 要求历史所有轮次的 reasoning_content 全量回传
//      并拼进上下文 —— 重复轨迹每一轮都被重新强化一次，形成自增强闭环；
//   3. V4.1 Flash 的核心卖点是**有损 KV Cache 压缩**（Go 计划里 cached read 低到
//      $0.003/M）。它把低熵重复内容压得几乎无损，却先抹掉稀疏的、带区分度的
//      边缘信号 —— 而那是唯一能打破循环的东西；
//   4. 循环每轮只吐极少的 token，上下文几乎不增长，所以**上下文压缩永远等不到
//      触发条件**。这就是「明明是死循环却从不触发 compaction」的原因：compaction
//      针对的是输入总量，而它在因果链之外。
//
// 顺带说明为什么调采样参数没用：DeepSeek 官方文档明确写着，thinking 模式下
// **不支持 temperature / presence_penalty / frequency_penalty**（设了不报错但
// 完全无效），top_p 的下限被钉死在 0.95。指望靠采样多样性破环，方向本身就是错的。
//
// ═══ 真实循环长什么样（来自 2304 条真实会话消息的实测）═══
//
// 关键结论，也是本插件第一版打偏的地方：
//
//   ★ 循环发生在**单条 assistant 消息内部**，而不是跨多条消息。
//
//   实测：全部会话的「相邻消息严格相同」次数为 0。而单条消息内部的行重复
//   却能达到极端值 —— 最严重的一条是 '"</parameter>' 被重复 **1729 次**，
//   占该消息 1767 行中的 97.8%。
//
//   正常消息的行重复分布：p99 = 3，p100 = 2（段落维度）。
//   所以阈值取 6 时，2304 条里只有 10 条命中（0.43%），全部是真退化。
//
// 因此本插件的判据是**消息内部重复密度**，而不是消息之间的相等。
//
// ═══ 它做什么 ═══
//
// 挂在 'agent/pre-step'（与 DSH 原生 guard 同一挂点）。
//
// 【第一道】当前消息内部退化：最新一条 assistant 文本里，同一行重复 >= 阈值，
//           或同一段落重复 >= 阈值 → 注入破环提醒。
// 【第二道】上下文已污染：**全部历史** assistant 文本聚合后行重复 >= 更高的
//           阈值 → 说明这个会话的历史里已经塞满了重复垃圾，会持续把模型拖回
//           循环。每会话只注入一次，提醒模型忽略这些残骸。这正是「旧会话即使
//           装了插件仍然循环」的机制 —— 污染在装上插件之前就写进历史了。
// 【第三道】跨消息重复：连续多步输出同一文本（旧版逻辑，保留）。
//
// ═══ 设计边界（刻意为之）═══
//
//   - 不改写任何 LLM 请求参数。降 temperature / reasoning_effort 这类动作要么被
//     thinking 模式静默忽略，要么会打掉 KV Cache 的前缀复用，得不偿失。
//   - 不 veto、不 block、不重置会话。上游若用 reject 拒绝这一步，原样透传。
//   - 不导出 'Config'。cordis 的 resolveConfig() 要求 Config 是 Standard Schema
//     （读 'Config["~standard"].validate'），裸对象会抛
//     "Cannot read properties of undefined (reading 'validate')" 并让整个 profile
//     起不来；而 schemastery 在 profile 的 node_modules 里解析不到。默认值与校验
//     全部由本文件自己承担（fail-loud）。
//   - 主动过滤自己注入的提醒，否则提醒本身会成为链上的下一个「重复项」，
//     把守卫变成自我引爆器。

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

export const name = 'loop-guard'

// 本插件注入的 context 的 producer source 标记。这个 label 是承重的：
// 一条没有 source 标记的 context 在派生历史里会被渲染成用户输入。
const SOURCE_KIND = 'loop-guard'

// ── 插件配置（官方 0.1.7 标准路径）────────────────────────────────────────
// 声明 Config 后，Settings 服务会**自动从它派生**一个以本插件行 id 命名的
// namespace（即 `loop-guard`），客户端设置页通过 configForms 读写它。
//
// 这样做的理由：另一条路 `settings.register(...)` 是 dsh-purge 补进 dsh-settings
// 的 legacy API，只有装了 dsh-purge 的环境才有 —— 别人装上本插件时将无法配置。
// 而 Config 是宿主原生机制，任何 DSH 0.1.7 环境都能派生设置页。
//
// 注意：Config 必须是 Standard Schema（带 `~standard`）。裸 JS 对象会让 cordis 的
// resolveConfig 抛 "Cannot read properties of undefined (reading 'validate')"
// 并让整个 profile 起不来 —— 这是 schemastery 存在的意义。
export const Config = z.object({
  preset: z.string().default('balanced'),
  repeatDensity: z.number().default(0.35),
  window: z.number().default(12),
  lineRepeatThreshold: z.number().default(6),
  contextLineRepeatThreshold: z.number().default(20),
  minChars: z.number().default(120),
  crossStepThreshold: z.number().default(3),
  debug: z.boolean().default(false),
})

/** 当前消息内部退化时的提醒。 */
function intraMessageReminder(densityPercent, lineCount, window, preview) {
  return `Degenerate repetition detected inside your latest output:
- repetition density: ${densityPercent}% (the share of lines repeating within a
  ${window}-line sliding window)
- most-repeated single line appears ${lineCount} times
- most-repeated line was: ${preview}

This is a generation failure, not progress: you are looping on the same text \
instead of advancing the task. The measured density is far above the normal \
range for a working response.

Break the pattern now. Do not restate or continue the repeated fragment. \
Re-read the actual task, then either call a tool to take one concrete next \
action, or stop and report the current state and the single thing you need \
from the user.`
}

/** 上下文历史已被重复垃圾污染时的强化提醒。 */
function pollutedContextReminder(lineCount, threshold) {
  return `This conversation's history is already polluted with degenerate repetition:
- the most-repeated single line appears ${lineCount} times across earlier model output
- pollution threshold: ${threshold}

That earlier garbage is not work product and must NOT be imitated or continued. \
Treat it as corrupted context. Ignore the repeated fragments entirely: do not \
complete them, do not quote them, do not continue their pattern.

Anchor only on the user's most recent instruction and the current task state. \
If the earlier repetition makes the history unusable, say so plainly and ask the \
user to start a fresh conversation instead of continuing here.`
}

/** 跨消息重复时的提醒（保留的旧机制）。 */
function crossStepReminder(count, preview) {
  return `You have produced this same output ${count} times in a row:
- consecutive_identical_steps: ${count}
- repeated_text: ${preview}

No new information is being added and no progress is being made. Break the \
pattern: either call a tool to take a concrete action, or stop and report the \
current state and what you need from the user.`
}

// ── 默认值 ─────────────────────────────────────────────────────────────────
// 判据演进史（每一版都被真实数据推翻过，记录在此避免重蹈）：
//
//   v1 跨消息相等 —— 全错。实测 2306 条消息的「相邻输出严格相同」次数为 0。
//      这个故障是单条消息内部的刷屏，不是跨消息重复。
//
//   v2 单行重复次数 + 该行占比 —— 只抓到「单行吃掉整条消息」那一种形态
//      （'"</parameter>' ×1729 占 98%）。遇到混合形态就瞎：
//      '（输出）（生成）（工具调用）' 交替滚动的循环里，最大单行重复 23 次
//      但只占该消息 21.7%，被 0.5 的占比门槛挡住 → 漏掉。
//
//   v3 窗口重复密度（当前）—— 滑动窗口内「出现次数 >1 的行」占比。
//      实测三分类能力（4076 条真实消息）：
//        正常文档/代码   p50~p80 = 0%
//        正常表格        ~15%（含 '|---|---|---|' 这类结构性重复）
//        真循环          60% ~ 97.5%
//      分位：p95 = 7.6%、p99 = 17.7%、p100 = 97.5%。
//      取 35% 阈值：0.05% 命中，且命中的全是真循环 —— 中间有巨大安全空档。
//
// 保留单行重复作为辅助信号：它能给提醒带上「重复最多的是哪一行」的上下文。
const DEFAULT_REPEAT_DENSITY = 0.35
const DEFAULT_WINDOW = 12
const DEFAULT_LINE_REPEAT_THRESHOLD = 6
const DEFAULT_CONTEXT_LINE_REPEAT_THRESHOLD = 20
const DEFAULT_MIN_CHARS = 120
const DEFAULT_CROSS_STEP_THRESHOLD = 3

/**
 * 校验并归一化配置。fail-loud：配置错了就在挂载时抛，不要等到运行时静默失效。
 * @param config - 插件行的 config 段。
 * @returns 校验过的配置。
 */
function validateConfig(config) {
  const raw = config ?? {}

  const intAtLeast = (value, label, min) => {
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`loop-guard: invalid ${label} ${value} — must be an integer >= ${min}`)
    }
    return value
  }

  const ratioInRange = (value, label) => {
    if (typeof value !== 'number' || Number.isNaN(value) || value <= 0 || value > 1) {
      throw new Error(`loop-guard: invalid ${label} ${value} — must be a number in (0, 1]`)
    }
    return value
  }

  return {
    repeatDensity: ratioInRange(
      raw.repeatDensity ?? DEFAULT_REPEAT_DENSITY,
      'repeatDensity',
    ),
    window: intAtLeast(raw.window ?? DEFAULT_WINDOW, 'window', 4),
    lineRepeatThreshold: intAtLeast(
      raw.lineRepeatThreshold ?? DEFAULT_LINE_REPEAT_THRESHOLD,
      'lineRepeatThreshold',
      2,
    ),
    contextLineRepeatThreshold: intAtLeast(
      raw.contextLineRepeatThreshold ?? DEFAULT_CONTEXT_LINE_REPEAT_THRESHOLD,
      'contextLineRepeatThreshold',
      3,
    ),
    minChars: intAtLeast(raw.minChars ?? DEFAULT_MIN_CHARS, 'minChars', 1),
    crossStepThreshold: intAtLeast(
      raw.crossStepThreshold ?? DEFAULT_CROSS_STEP_THRESHOLD,
      'crossStepThreshold',
      2,
    ),
    debug: raw.debug === true,
  }
}

/**
 * 提取一条消息里所有 text 块拼成的文本。非 text 块 (reasoning / tool_use 等) 一律忽略。
 * @param message - 任意 DSH 消息对象，可能形态不完整。
 * @returns 该消息的可见文本；取不到时返回空串。
 */
function textOf(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * 判断一条消息是不是本插件自己注入的提醒。
 * 必须按 source.kind 判定而不是按内容判定：提醒本身也是 user role，
 * 不过滤掉它，它就会成为链上的下一个「重复项」，把守卫变成自我引爆器。
 * @param message - 候选消息。
 * @returns 是否为本插件的提醒。
 */
function isOwnReminder(message) {
  return message !== null
    && typeof message === 'object'
    && message.source !== null
    && typeof message.source === 'object'
    && message.source.kind === SOURCE_KIND
}

/**
 * 判断一行是否只是结构性排版符号（代码围栏、表格分隔线、水平线等）。
 * 这类行在正常输出里本就会反复出现，不该计入重复密度。
 * 刻意不设长度门槛：「好。」这种 2 字符的真实循环行必须保留 ——
 * 按长度过滤会连带放走最典型的退化形态。
 * @param line - 已 trim 的一行。
 * @returns 是否为纯结构性符号行。
 */
function isStructuralLine(line) {
  return /^[`|+=_*#~>-]+$/.test(line)
}

/**
 * 统计文本内部的重复密度 —— 本插件的核心判据。
 * @param text - 一条 assistant 消息的可见文本。
 * @param window - 滑动窗口行数。
 * @param skipStructural - 为 true 时跳过纯结构性符号行（历史聚合时用）。
 * @returns {{ maxLine, lineN, maxLineRatio, maxPara, density, worstLine }}
 */
function repeatStats(text, window = 12, skipStructural = false) {
  const result = {
    maxLine: 0,
    lineN: 0,
    maxLineRatio: 0,
    maxPara: 0,
    density: 0,
    worstLine: '',
  }
  if (typeof text !== 'string' || text.length === 0) return result

  const lines = []
  const lineCounts = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    // 空行必须先排除：它们天然"重复"，计入会让密度虚高（实测曾致 12.5% 误报）。
    if (line.length === 0) continue
    // 第二道（历史污染）额外跳过纯结构性符号行（```、|---| 等）——
    // 这类行在正常输出里反复出现，误报全部来自它们。
    // 第一道刻意不跳过：「好。」这种 2 字符内容行必须保留。
    if (skipStructural && isStructuralLine(line)) continue
    lines.push(line)
    const n = (lineCounts.get(line) ?? 0) + 1
    lineCounts.set(line, n)
    if (n > result.maxLine) {
      result.maxLine = n
      result.worstLine = line
    }
  }
  result.lineN = lines.length
  result.maxLineRatio = lines.length > 0 ? result.maxLine / lines.length : 0

  // 主判据：窗口重复密度 —— 滑动窗口内出现次数 >1 的行占比的均值。
  // 同时抓住单行刷屏（"</parameter> x1729）与多标记交替滚动
  // （（输出）（生成）（工具调用）），而正常表格只落在 ~15%。
  if (lines.length >= window) {
    let acc = 0
    for (let i = 0; i < lines.length; i += 1) {
      const lo = Math.max(0, i - window + 1)
      const win = lines.slice(lo, i + 1)
      const counts = new Map()
      for (const w of win) counts.set(w, (counts.get(w) ?? 0) + 1)
      let dup = 0
      for (const w of win) if (counts.get(w) > 1) dup += 1
      acc += dup / win.length
    }
    result.density = acc / lines.length
  }

  const paraCounts = new Map()
  for (const raw of text.split(/\n\s*\n/)) {
    const para = raw.replace(/\s+/g, ' ').trim()
    if (para.length < 8) continue
    const n = (paraCounts.get(para) ?? 0) + 1
    if (n > result.maxPara) result.maxPara = n
  }
  return result
}

/**
 * 构造一条带 source 标记的提醒消息。
 * 形态对齐 @deepseek-ai/dsh-llm 的 createMessage：id + role + content + source，
 * 然后深冻结。这里手写是为了不给本插件增加对 @deepseek-ai/dsh-llm 的解析依赖
 * —— 该包只存在于 Host 的 app.asar.unpacked 里，profile 的 node_modules 解析不到它。
 * @param text - 提醒正文。
 * @param summary - 给持久化日志的一行摘要。
 * @returns 冻结后的提醒消息。
 */
function createReminder(text, summary) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      summary: summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`,
    },
  }
  return deepFreeze(message)
}

/** 递归冻结，对齐 Host 的消息不可变契约。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * 收集消息列表里所有「非本插件注入」的 assistant 文本，最近的在前。
 * @param messages - 消息列表。
 * @returns 文本数组，最近的排在最前。
 */
function assistantTextsNewestFirst(messages) {
  const out = []
  if (!Array.isArray(messages)) return out
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (isOwnReminder(message)) continue
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'assistant') continue
    const text = textOf(message)
    if (text.length === 0) continue
    out.push(text)
  }
  return out
}

// ── 档位预设 ───────────────────────────────────────────────────────────────
// 阈值来自真实会话数据校准，档位只是把同一组数字按「误报容忍度」重新排布：
//   真循环的窗口重复密度 60%~97%，正常内容上限 17.7%（p99），中间是安全空档。
const PRESETS = {
  conservative: {
    label: '保守',
    hint: '误报率最低。适合大量输出表格 / 代码的场景，宁可漏报也不打断正常输出。',
    repeatDensity: 0.5,
  },
  balanced: {
    label: '平衡',
    hint: '推荐默认。实测 3723 条真实消息误报率 0.05%，不漏任何一种已观察到的循环形态。',
    repeatDensity: 0.35,
  },
  aggressive: {
    label: '激进',
    hint: '最早介入，轻微重复也会提醒。适合长任务 / 无人值守，代价是提醒更频繁。',
    repeatDensity: 0.25,
  },
}
const DEFAULT_PRESET = 'balanced'
const SETTINGS_NAMESPACE = 'loop-guard'

/**
 * 把原始 config 归一化成一个安全的、可热替换的配置对象。
 * 输入可能是插件行的静态 config、settings namespace 的 resolved 值、或两者的合并。
 * @param raw - 任意来源的配置片段。
 * @returns 归一化后的运行时配置。
 */
function normalizeSettings(raw) {
  const input = raw ?? {}
  const preset = Object.hasOwn(PRESETS, input.preset) ? input.preset : DEFAULT_PRESET
  const base = PRESETS[preset]

  const num = (value, fallback, min, max) => {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }
  const int = (value, fallback, min, max) => Math.round(num(value, fallback, min, max))

  return {
    preset,
    repeatDensity: num(input.repeatDensity, base.repeatDensity, 0.05, 1),
    window: int(input.window, 12, 4, 100),
    lineRepeatThreshold: int(input.lineRepeatThreshold, 6, 2, 100),
    contextLineRepeatThreshold: int(input.contextLineRepeatThreshold, 20, 3, 500),
    minChars: int(input.minChars, 120, 1, 100000),
    crossStepThreshold: int(input.crossStepThreshold, 3, 2, 100),
    debug: input.debug === true,
  }
}

/**
 * 安装守卫的监听器。
 *
 * 配置来源有两层：
 *   1. 插件行的静态 config（profile 的 cordis.patch.yml）—— 兜底默认；
 *   2. settings namespace `loop-guard' —— 若宿主提供 settings 服务则优先，
 *      并 watch 它的变更，使设置页里改阈值**无需重启**即可生效。
 *
 * @param ctx - 插件 context；监听器随它一起销毁。
 * @param config - 插件行的 config 段。
 */

export function apply(ctx, config) {
  // 运行时配置。settings 变更时整体替换；agent/pre-step 每一步都重新读取，
  // 因此在设置页里改阈值无需重启即可生效。
  let runtime = normalizeSettings(config)

  const log = (message, ...args) => {
    try {
      if (typeof ctx?.logger?.info === 'function') ctx.logger.info(message, ...args)
    } catch { /* 日志失败绝不影响功能 */ }
  }

  // ── 核心：先注册 agent/pre-step ─────────────────────────────────────────
  // 顺序是刻意的：任何「可选增强」（settings 集成）都必须在核心之后，
  // 且绝不能阻塞核心注册。曾经在这里 await ctx.inject([settings]) 导致整个
  // 插件永久挂起、循环防护完全失效 —— cordis 的 inject 返回 fiber，
  // 依赖不可用时 await 永不 settle。
  const chains = new WeakMap()
  const pollutedWarned = new WeakSet()

  ctx.on('agent/pre-step', async (payload, next) => {
    const downstream = await next()

    // 上游如果拒绝这一步，原样透传，绝不覆盖别人的决策。
    if (downstream === undefined || downstream === null || downstream.kind !== 'enter') {
      return downstream
    }

    const agent = payload?.agent
    if (agent === undefined || agent === null) return downstream

    const messages = downstream.messages ?? payload?.messages
    const texts = assistantTextsNewestFirst(messages)
    if (texts.length === 0) return downstream

    // 每一步都从 runtime 读阈值 —— 这正是「设置页改完立即生效」的落点。
    const {
      repeatDensity,
      window,
      lineRepeatThreshold,
      contextLineRepeatThreshold,
      minChars,
      crossStepThreshold,
      debug,
    } = runtime

    const inject = (text, summary, reason) => {
      if (debug) {
        log(
          '[loop-guard] %s at turn %s step %s',
          reason,
          String(payload?.turn ?? '?'),
          String(payload?.step ?? '?'),
        )
      }
      const reminder = createReminder(text, summary)
      return { ...downstream, messages: [...messages, reminder] }
    }

    // 第一道：当前消息内部退化（主判据：窗口重复密度）
    const latest = texts[0]
    if (latest.length >= minChars) {
      const stats = repeatStats(latest, window)
      const densityDegenerate = stats.density >= repeatDensity
      const lineDegenerate = stats.maxLine >= lineRepeatThreshold && stats.maxLineRatio >= 0.5
      if (densityDegenerate || lineDegenerate) {
        const worst = stats.worstLine.length > 0
          ? stats.worstLine.slice(0, 140)
          : '(no single line dominates)'
        return inject(
          intraMessageReminder(Math.round(stats.density * 100), stats.maxLine, window, worst),
          `degenerate repetition: density ${Math.round(stats.density * 100)}%`,
          `repetition density ${(stats.density * 100).toFixed(1)}% (maxLine x${stats.maxLine})`,
        )
      }
    }

    // 第二道：上下文历史已被重复垃圾污染（旧会话的典型症状）
    if (!pollutedWarned.has(agent)) {
      const combined = texts.join(String.fromCharCode(10) + String.fromCharCode(10))
      if (combined.length >= minChars) {
        // 双条件：既要有足够多的重复，也要重复行占足够比例。
        // 只看次数会把正常的代码骨架行（`});`、`}`）误判成历史污染 ——
        // 实测放宽过滤后单条件会导致 13.5% 误报。
        // 占比门槛比第一道宽松（0.3 vs 0.5）：历史是聚合文本，本就混杂正常内容。
        const contextStats = repeatStats(combined, window, true)
        if (contextStats.maxLine >= contextLineRepeatThreshold
          && contextStats.maxLineRatio >= 0.3) {
          pollutedWarned.add(agent)
          return inject(
            pollutedContextReminder(contextStats.maxLine, contextLineRepeatThreshold),
            `polluted context: line x${contextStats.maxLine}`,
            `polluted context (line x${contextStats.maxLine})`,
          )
        }
      }
    }

    // 第三道：跨消息重复
    if (latest.length >= minChars) {
      const key = latest.replace(/\s+/g, ' ').trim().slice(0, 400)
      const chain = chains.get(agent)
      const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
      chains.set(agent, { key, count })
      if (crossStepThreshold > 1 && count >= crossStepThreshold && count % crossStepThreshold === 0) {
        return inject(
          crossStepReminder(count, key.slice(0, 200)),
          `repeated output x ${count}`,
          `cross-step repetition x${count}`,
        )
      }
    }

    return downstream
  })

  // 配置来源：插件的 Config（schemastery schema，见文件顶部的 `export const Config`）。
  // Settings 服务从 Config 自动派生以本行 id 命名的 namespace（`loop-guard`），
  // 客户端设置页通过 configForms 读写它；改动写入配置后重启生效 —— 这是官方标准行为。
  //
  // 这里刻意不再调用 settings.register(...)：那是 dsh-purge 往 dsh-settings 里补的
  // legacy API，只有装了 dsh-purge 的环境才有；依赖它会让别人装上本插件后无法配置。
  runtime = normalizeSettings(config)

  const preset = PRESETS[runtime.preset] ?? PRESETS[DEFAULT_PRESET]
  log(
    '[loop-guard] active — preset=%s(%s) density>=%s window=%s lineRepeat>=%s contextLineRepeat>=%s minChars=%s crossStep=%s',
    runtime.preset,
    preset.label,
    String(runtime.repeatDensity),
    String(runtime.window),
    String(runtime.lineRepeatThreshold),
    String(runtime.contextLineRepeatThreshold),
    String(runtime.minChars),
    String(runtime.crossStepThreshold),
  )
}

