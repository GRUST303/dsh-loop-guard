# dsh-loop-guard

DeepSeek Harness (DSH) 插件：**纯文本死循环断路器**。

检测单条模型消息内部的**重复退化**（degeneration / 重复吸引子），并在命中阈值时向
下一步注入破环提醒，阻止 agent 循环无限空转。

> 起因是一台真实机器上的故障：`deepseek-v4.1-flash` 在 thinking 模式下反复吐
> 「好。写。执行。」，一个 tool call 都不产生，循环两小时无人察觉。

## 它解决什么问题

这个故障由四个因素叠加造成，**与上下文长度无关**：

1. **thinking 默认开启、effort 偏高** —— CoT 体量最大，重复轨迹最长。
2. **tools 场景下 `reasoning_content` 全量回传** —— DeepSeek 官方要求：请求带
   `tools` 时，历史所有轮次的 `reasoning_content` 必须完整传回并拼进上下文。
   于是重复轨迹每一轮都被重新强化一次，形成自增强闭环。
3. **有损 KV Cache 压缩在放大它** —— 该模型的核心卖点就是 KV cache 压缩。
   它把低熵重复内容压得几乎无损，却先抹掉稀疏的、带区分度的边缘信号 ——
   而那是唯一能打破循环的东西。
4. **上下文压缩永远等不到触发条件** —— 循环每轮只吐极少 token，上下文几乎不
   增长，compaction 全程旁观。**这就是「明明是死循环却从不触发上下文压缩」的
   原因：compaction 针对输入总量，而它在因果链之外。**

### 为什么调采样参数没用

DeepSeek 官方文档明确写着：thinking 模式下 **不支持 `temperature` /
`presence_penalty` / `frequency_penalty`**（设了不报错但完全无效），`top_p`
的下限被钉死在 0.95。指望靠采样多样性破环，方向就是错的。

## 关键认知：循环发生在单条消息内部

这是理解这个故障的分水岭。基于 **7917 条真实会话消息**的实测：

| 观测 | 结果 |
|---|---|
| 跨消息「相邻输出严格相同」 | **0 次**（全部会话） |
| 单条消息内部单行重复最大值 | **1729 次**（占比 97.8%） |
| 正常消息的单行重复 p99 | 3 |

**结论：循环是单条 assistant 消息内部的刷屏，不是跨消息重复。**
任何"比较前后两条消息是否相同"的守卫都够不着它。

## 循环有两种形态

它们外观完全不同，只覆盖第一种的判据会完全失效：

| 形态 | 例子 | 单行最多重复 | 单行占比 |
|---|---|---|---|
| **单行刷屏** | `"</parameter>` ×1729 | 1729 | 98% |
| **多标记交替滚动** | `（输出）（生成）（工具调用）（好。）` | 136 | **仅 21.7%** |

第二种是致命的：最常重复的行只占整条消息的 21.7%，被"占比 ≥ 50%"的门槛挡在外面，
**整个判据失效**。所以主判据必须是密度类指标。

## 主判据：窗口重复密度

滑动窗口（默认 12 行）内「出现次数 >1 的行」占比的均值。

| 内容 | 密度 | 说明 |
|---|---|---|
| 普通文档 / 代码 | **0.0%** | p50~p80 都是 0 |
| 含分隔线的 markdown 表格 | **15.0%** | 结构性重复的合理上限 |
| 多标记交替滚动（第二种形态） | **59.7%** | 真循环 |
| 单行刷屏（第一种形态） | **97.5%** | 真循环 |

真实分布：p90 = 0.3%、p95 = 7.6%、p99 = 17.7%、p100 = 97.5%。

**平衡档取 35%**：落在正常上限（17.7%）与真循环（60%+）之间的安全空档。
全量 7917 条真实消息实测命中 **2 条（0.03%）**，且命中的全是真循环。

## 三道防线

挂在 `agent/pre-step`（与 DSH 原生 guard 同一挂点）。

1. **当前消息内部退化** —— 密度超阈值，或单行极端重复（次数达标 **且** 占比 ≥ 50%）
   → 注入破环提醒，带上密度、重复次数与重复行原文。对上述两种形态都有效。
2. **上下文已被污染** —— 全部历史聚合后单行重复 ≥ 20 次 **且** 该行占比 ≥ 30%
   → 每会话注入一次强化提醒。
   **这是「旧会话装了插件仍循环」的对策**：污染在装插件之前就写进历史了。
3. **跨消息重复** —— 连续输出同一文本达到阈值的整数倍。

## 安装

> **注意**：`dsh plugin --profile <name> add <target>` 实际是转调 **pnpm**，它只把包写进
> `dependencies`，**不会**把包名加进 `dsh.profile.bundles`。而 bundle 层才是决定插件
> 是否加载的地方。下面的第 2 步不能省，否则装完不生效。

### 从 GitHub 安装

```sh
# 1) 取到本地并安装为 profile 依赖
git clone https://github.com/GRUST303/dsh-loop-guard.git
dsh plugin --profile <你的 profile> add ./dsh-loop-guard

# 或直接作为 git 依赖（同样是 pnpm add）
dsh plugin --profile <你的 profile> add github:GRUST303/dsh-loop-guard
```

**2) 把 `dsh-loop-guard` 加进 profile 的 `package.json`：**

```jsonc
{
  "dependencies": { "dsh-loop-guard": "link:./dsh-loop-guard" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-loop-guard"        // ← 必须在这一行
      ]
    }
  }
}
```

**3) 在 profile 目录 `pnpm install`，然后完整重启 profile。**

bundle 层在启动时被读取并合成 `cordis.yml`，所以**必须重启**，HMR 不够。

### 如果你有 DSH 的插件管理器工具

官方推荐路径是用 `plugin_manager` 的 `install_bundle`（它会自己处理安装 + bundle
选择，不用手工改 `package.json`）：

```
plugin_manager({ action: "install_bundle", target: "<到 dsh-loop-guard 的绝对路径>" })
```

### 依赖

`@deepseek-ai/schemastery`（官方包，pnpm 会自动拉取）。插件用它声明 `Config`——
用原生 schema 而不是裸 JS 对象，后者会让 cordis 的 `resolveConfig` 抛
`Cannot read properties of undefined (reading 'validate')` 并**让整个 profile 起不来**。

## 配置

配置通过 profile 插件行的 `config` 段提供：

```yaml
- id: loop-guard
  name: dsh-loop-guard
  config:
    preset: balanced        # conservative | balanced | aggressive
    repeatDensity: 0.35     # 主判据：窗口重复密度阈值
    window: 12              # 滑动窗口行数
    lineRepeatThreshold: 6  # 单行重复次数（需同时满足占比 ≥ 50%）
    contextLineRepeatThreshold: 20   # 历史污染阈值
    minChars: 120           # 短于此长度的消息不参与判定
    crossStepThreshold: 3   # 跨步重复次数
    debug: false            # 写入调试日志
```

改完**重启 profile** 生效。

### 档位对照

| 档位 | 密度阈值 | 适用场景 |
|---|---|---|
| **保守** | `0.5` | 误报率最低。适合大量输出表格 / 代码的场景，宁可漏报也不打断正常输出 |
| **平衡**（默认） | `0.35` | 7917 条真实消息实测误报率 0.03%，不漏任何一种已观察到的循环形态 |
| **激进** | `0.25` | 最早介入，轻微重复也会提醒。适合长任务 / 无人值守，代价是提醒更频繁 |

### 关于图形设置页

插件声明了官方 `Config`（schemastery schema），DSH 的 Settings 服务会据此派生配置项；
客户端也注册了设置页（`settings.plugins.tab` 槽位）。

**在实测的 DSH 0.1.7-rc.2 上，该设置页没有被渲染出来。** 已确认的部分：
插件出现在 Web 端 boot manifest 里、`dsh.client` 声明正确、client bundle 可正常
加载（HTTP 200）。但 tab 不出现，根因未定位。

**这不影响核心功能** —— 防循环完全由 host 端承担，与设置页无关。
请使用上面的 `config` 段配置。如果你定位到了原因，欢迎提 PR。

## 验证

仓库自带验证脚本。它们默认从 `DSH_HOME` 读取会话数据，先设置该环境变量：

```sh
export DSH_HOME=/path/to/harness          # PowerShell: $env:DSH_HOME="..."
```

```sh
node verify-static.mjs    # 43 项接入契约（Config 是 Standard Schema、槽位名、前后端档位一致性…）
node verify-real.mjs      # 真实循环形态召回 + 全量消息误报率
node verify-chain.mjs     # 跨步判据与自引自环防护
node verify-polluted.mjs  # 历史污染场景
node verify.mjs           # 激活路径与事件契约
node density-study.mjs    # 在真实数据上重算密度分布与阈值
```

不需要 DSH 环境的纯离线脚本：`verify-static.mjs`、`verify-chain.mjs`、`verify.mjs`。

## 实现说明（给二次开发者）

**1. 不要导出裸对象的 `Config`。**
cordis 的 `resolveConfig()` 要求 `Config` 是 Standard Schema（读
`Config["~standard"].validate`）；裸对象会抛
`Cannot read properties of undefined (reading 'validate')` **并让整个 profile
起不来**。默认值与校验全部由本文件自己承担（fail-loud）。

**2. 不要在 `apply` 里 `await ctx.inject([...])`。**
`ctx.inject()` 返回 fiber，**依赖不可用时 await 永不 settle** —— 这会让整个插件
永久挂起，连核心注册都不执行。可选增强必须用「同步探测 + 异步兜底」，且绝不阻塞
核心路径。

**3. `repeatStats` 的空行过滤不能省。**
空行天然"重复"，一旦计入窗口统计会让密度虚高 —— 实测这一个疏漏把误报率从
0.03% 抬到 **12.5%**。

**4. 主动过滤自己注入的提醒。**
提醒本身是 `user` role，不过滤掉它就会被当成链上的下一个「重复项」，
把守卫变成自我引爆器。

**5. DSH 会话是「每行一个独立 zstd 帧」。**
`session.v4.jsonl.zstd` 不是单个 zstd 流。单次 `zstdDecompressSync` 只返回第一帧
（一个 2.6MB 的会话因此只解出 189 字节）。用 `zstd-frames.mjs` 逐帧解压。

**6. 测试时必须给每个样本独立的 agent 对象。**
复用同一个 agent 会把互不相干的样本累计成一条假的「跨步重复链」，制造假误报。

**7. 设置页槽位用 `settings.plugins.tab`。**
官方 `dsh-client-ui-settings-agent-loop` 用的是 `plugins.item`，但在 DSH
0.1.7-rc.2 上**没有任何宿主消费该槽位**（全量搜索 0 命中），注册进去不会显示。

## 设计边界（刻意为之）

- **不改写任何 LLM 请求参数。** 降 `temperature` / `reasoning_effort` 这类动作要么
  被 thinking 模式静默忽略，要么会打掉 KV Cache 的前缀复用，得不偿失。
- **不 veto、不 block、不重置会话。** 上游若用 `reject` 拒绝这一步，原样透传。
- **按 agent 隔离状态**（WeakMap / WeakSet），agent 回收后自动清理。
- **任何可选增强失败都不得影响核心功能** —— 这是硬约束，不是偏好。

## 判据演进史

洗手记录，避免重蹈（每一版都被真实数据推翻过）：

| 版本 | 判据 | 结论 |
|---|---|---|
| v1 | 跨消息相等 | **全错**。实测相邻输出严格相同的次数为 0 |
| v2 | 单行次数 + 该行占比 | **过拟合**。第二种形态的占比只有 21.7%，被 50% 门槛挡住 |
| v3 | **窗口重复密度**（当前） | 同时覆盖两种形态，正常内容上限 15% |

## 与 `dsh-purge` 的关系

`dsh-purge` 的补丁 #18（`REPEAT_TOOL_REMINDER_DISABLED`）会把 DSH 原生的
`dsh-repeat-tool-reminder` 整个拆掉（`tools/post-execute` 与 `agent/pre-step`
两个监听都被移除，注释写着 "The guard is fully inert."）。

原生守卫处理的是「重复调用同一工具」，本插件处理的是「单条消息内部的纯文本重复」——
后者在原生体系里本就没有覆盖。两者监听同一挂点但互不冲突。

**本插件不依赖 `dsh-purge`。** 它的配置路径是官方 `Config`，任何 DSH 0.1.7
环境都能用。

## License

MIT
