// 回归夹具：两种循环形态的代表性输出。
//
// 形态 A —— 单行刷屏：单个片段吃掉整条消息（真实数据实测占比 96%~98%）。
export const FLOOD_TEXT = (() => {
  let out = '**发现一个真实的逻辑缺陷。** 看 C 组:\n\n'
  out += '| 请求 | 结果 |\n|---|---|\n| `nonce=0000000000` | `status:0 非法请求` |\n\n'
  out += '这是典型的 `if (isset($_POST[\'nonce\']) && !wp_verify_nonce(...))` 写法。\n\n'
  // 退化开始：从这里起同一行被反复吐出
  for (let i = 0; i < 400; i += 1) out += '"</parameter>\n'
  return out
})()

// 形态 B —— 多标记交替滚动：最常重复的行只占整条消息约 22%，
// 因此"单行重复次数 + 该行占比"这一类判据会完全漏掉它。
export const ROLLING_TEXT = (() => {
  const beats = [
    '好。', '执行。', '（生成）', '好。', '好。', '（现在输出）',
    '关键：这是决定性的验证。', '好。', '（工具调用）', '好。', '好。',
    '—— 好，输出。', '好。', '（输出）', '好。', '好。', '好。',
  ]
  let out = '关键：输出被截断了（只显示到第 8 个 reset，没有显示差异结果）。\n'
  out += 'Hmm，Select-Object -First 30 截断了。\n'
  out += '关键：让me 重新看 —— 输出到 reset 0x1f71045f340 就断了。\n\n'
  for (let i = 0; i < 26; i += 1) out += `${beats[i % beats.length]}\n`
  return out
})()

// 正常对照：结构化但**不退化**的输出（表格分隔线与代码块围栏会重复，
// 但占比极低）。用来验证不会误报。
export const NORMAL_TABLE_TEXT = (() => {
  let out = '下面是审计结果汇总：\n\n'
  for (let i = 0; i < 8; i += 1) {
    out += `### 第 ${i + 1} 节\n\n`
    out += '| 项目 | 数值 | 说明 |\n|---|---|---|\n'
    for (let r = 0; r < 3; r += 1) out += `| 指标 ${i}-${r} | ${i * 10 + r} | 本行内容互不相同 |\n`
    out += '\n```bash\n'
    out += `echo "section ${i}"\n`
    out += '```\n\n'
  }
  return out
})()
