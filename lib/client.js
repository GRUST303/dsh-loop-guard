// dsh-loop-guard 客户端半体：DSH 设置 → 插件页里的「循环断路器」页面。
//
// 页面通过 configForms 读写宿主注册的 `loop-guard` settings namespace。
// 宿主端（lib/index.js）watch 该 namespace 并热替换运行时配置，所以在页面上
// 改完阈值**保存即生效，无需重启**。
//
// 档位（preset）是「一键套用一组阈值」的语义：点档位会把该档的
// repeatDensity 一起写进暂存草稿，用户仍可单独微调任何数值字段。
window.__ModuleLoader__.load({
	id: "dsh-loop-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region locales
		/** Dictionary namespace owned by this page. */
		const NS = "settings.loopGuard";

		const en = {
			title: "Loop guard",
			description: "Detect and break pure-text degenerate repetition in the agent loop.",
			preset: "Preset",
			presetHint: "Applies a tested set of thresholds. You can still override any value below.",
			presetConservative: "Conservative",
			presetBalanced: "Balanced (recommended)",
			presetAggressive: "Aggressive",
			presetConservativeHint: "Lowest false-positive rate. Best when you output many tables or code blocks.",
			presetBalancedHint: "Recommended default. 0.05% false positives measured over 3723 real messages.",
			presetAggressiveHint: "Intervenes earliest. For long unattended runs; reminders will be more frequent.",
			density: "Repetition density",
			densityHint: "Share of lines repeating inside a sliding window. Real loops measure 60%-97%; normal content stays under ~18%. Lower = earlier intervention.",
			window: "Sliding window (lines)",
			windowHint: "How many lines the density is measured over. 12 suits most output shapes.",
			lineRepeat: "Single-line repeat count",
			lineRepeatHint: "Secondary rule: one line repeated this many times AND taking over half the message counts as degenerate.",
			contextRepeat: "Polluted-history threshold",
			contextRepeatHint: "Across all earlier model output, one line repeating this many times marks the history as polluted. 20 keeps normal code fences out.",
			minChars: "Minimum message length",
			minCharsHint: "Messages shorter than this are not judged. 120 characters suits most chat turns.",
			crossStep: "Cross-step repeat count",
			crossStepHint: "Consecutive steps producing identical text before a reminder is injected.",
			debug: "Debug logging",
			debugHint: "Log every injection to the host console.",
			overridden: "Overridden",
			reset: "Reset to default",
			unavailable: "This plugin is not loaded, so it cannot be configured right now."
		};

		const zh = {
			title: "循环断路器",
			description: "检测并打断 Agent 循环里的纯文本重复退化。",
			preset: "档位",
			presetHint: "一键套用一组经过实测校准的阈值。下方每个数值仍可单独微调。",
			presetConservative: "保守",
			presetBalanced: "平衡（推荐）",
			presetAggressive: "激进",
			presetConservativeHint: "误报率最低。适合大量输出表格或代码的场景。",
			presetBalancedHint: "推荐默认。3723 条真实消息实测误报率 0.05%。",
			presetAggressiveHint: "最早介入。适合无人值守的长任务，代价是提醒更频繁。",
			density: "重复密度阈值",
			densityHint: "滑动窗口内重复行所占比例。真循环实测 60%~97%，正常内容上限约 18%。数值越低介入越早。",
			window: "滑动窗口（行数）",
			windowHint: "密度统计所覆盖的行数。12 适配大多数输出形态。",
			lineRepeat: "单行重复次数",
			lineRepeatHint: "辅助判据：同一行重复达到该次数、且占整条消息一半以上，才算退化。",
			contextRepeat: "历史污染阈值",
			contextRepeatHint: "全部历史输出里，同一行重复达到该次数即判定历史已被污染。取 20 可排除正常的代码块围栏。",
			minChars: "最小消息长度",
			minCharsHint: "短于该长度的消息不参与判定。120 字符适配大多数对话轮次。",
			crossStep: "跨步重复次数",
			crossStepHint: "连续多少步输出完全相同的文本后注入提醒。",
			debug: "调试日志",
			debugHint: "每次注入都写入宿主控制台。",
			overridden: "已覆盖",
			reset: "恢复默认",
			unavailable: "该插件当前未加载，暂时无法配置。"
		};
		//#endregion

		/** 档位 → 密度值。与宿主端 PRESETS 保持一致。 */
		const PRESET_VALUES = { conservative: 0.5, balanced: 0.35, aggressive: 0.25 };
		/** Namespace of loop-guard's user-owned settings, registered by the host half. */
		const LOOP_GUARD_NS = "loop-guard";

		/**
		 * 渲染页面的摘要行或设置表单。
		 * @param props - 视图类型、文案、表单快照与动作。
		 */
		function LoopGuardCard(props) {
			const t = props.t;
			const state = props.useLoopGuardCard((snapshot) => snapshot);
			if (props.view === "summary") return t("description");

			const j = react_jsx_runtime;
			const field = (id, key, labelKey, hintKey, numeric) => j.jsx(
				primitives.SettingsValueField,
				{
					id: `loop-guard-${id}`,
					label: t(labelKey),
					hint: t(hintKey),
					overriddenLabel: t("overridden"),
					resetLabel: t("reset"),
					numeric: numeric === true,
					disabled: !state.writable,
					...state[key],
					onEdit: (text) => { props.edit(key, text); },
					onReset: () => { props.resetField(key); },
				},
				id,
			);

			// 档位：当前值与草稿里的 preset 一致时才高亮。
			const presetNow = state.preset?.text || "balanced";
			const presetText = {
				conservative: { label: "presetConservative", title: "presetConservativeHint" },
				balanced: { label: "presetBalanced", title: "presetBalancedHint" },
				aggressive: { label: "presetAggressive", title: "presetAggressiveHint" },
			};
			const presetOptions = ["conservative", "balanced", "aggressive"].map((value) => {
				const keys = presetText[value] ?? presetText.balanced;
				return { value, label: t(keys.label), title: t(keys.title) };
			});

			return j.jsxs(primitives.SettingsForm, {
				labels: { unavailable: t("unavailable"), save: t("save"), saving: t("saving") },
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [
					j.jsxs("div", { key: "preset" }, [
						j.jsx(primitives.SegmentedControl, {
							id: "loop-guard-preset",
							value: presetNow,
							options: presetOptions,
							label: t("preset"),
							disabled: !state.writable,
							onChange: (value) => {
								props.edit("preset", value);
								// 一键套用该档的密度值，用户之后仍可覆盖。
								props.edit("repeatDensity", String(PRESET_VALUES[value] ?? 0.35));
							},
						}, "seg"),
						j.jsx("p", { key: "hint" }, t(`${presetNow}Hint`.replace("conservativeHint", "presetConservativeHint"))),
					]),
					field("density", "repeatDensity", "density", "densityHint", true),
					field("window", "window", "window", "windowHint", true),
					field("line-repeat", "lineRepeatThreshold", "lineRepeat", "lineRepeatHint", true),
					field("context-repeat", "contextLineRepeatThreshold", "contextRepeat", "contextRepeatHint", true),
					field("min-chars", "minChars", "minChars", "minCharsHint", true),
					field("cross-step", "crossStepThreshold", "crossStep", "crossStepHint", true),
				],
			});
		}

		/** 把 `loop-guard` namespace 桥接到页面的暂存表单上。 */
		class LoopGuardCardController {
			constructor(scope) {
				this.form = new primitives.SettingsFormModel(scope, [
					primitives.settingsTextField("preset"),
					primitives.settingsNumberField("repeatDensity"),
					primitives.settingsNumberField("window"),
					primitives.settingsNumberField("lineRepeatThreshold"),
					primitives.settingsNumberField("contextLineRepeatThreshold"),
					primitives.settingsNumberField("minChars"),
					primitives.settingsNumberField("crossStepThreshold"),
				]);
				this.store = this.form.bind(() => this.projection());
			}

			projection() {
				return {
					...this.form.shell(),
					preset: this.form.field("preset"),
					repeatDensity: this.form.field("repeatDensity"),
					window: this.form.field("window"),
					lineRepeatThreshold: this.form.field("lineRepeatThreshold"),
					contextLineRepeatThreshold: this.form.field("contextLineRepeatThreshold"),
					minChars: this.form.field("minChars"),
					crossStepThreshold: this.form.field("crossStepThreshold"),
				};
			}

			inject() {
				return {
					hooks: { loopGuardCard: this.store },
					...this.form.actions(),
				};
			}

			dispose() {
				this.form.dispose();
			}
		}

		//#region index
		const inject = ["slots", "locale", "configForms"];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-settings-loop-guard: dictionaries");

			// 槽位必须是 `settings.plugins.tab` —— 那是「插件」设置节里由
			// dsh-client-ui-settings-plugins 声明并消费的子槽位，注册后会成为该节的一个 tab。
			// 不要用 `plugins.item`：官方 settings-agent-loop 用的是它，但当前 0.1.7-rc.2 里
			// 没有任何宿主消费该槽位（全量搜索 0 命中），注册进去等于石沉大海。
			ctx.effect(() => ctx.configForms.whileServed([LOOP_GUARD_NS], () => {
				let card;
				try {
					card = new LoopGuardCardController(ctx.configForms.get(LOOP_GUARD_NS));
				} catch {
					// 能进入回调说明已被服务；仍失败则安静放弃，不让 slot 崩掉。
					return;
				}
				ctx.effect(() => () => card.dispose(), "ui-settings-loop-guard: form subscription");
				return ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
					name: "settings.plugins.tab",
					id: "loop-guard",
					order: 40,
					label: () => t("title"),
					locale: NS,
					inject: () => card.inject(),
				}, LoopGuardCard));
			}), "ui-settings-loop-guard: page");
		}
		//#endregion

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
