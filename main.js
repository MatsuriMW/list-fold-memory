/*
 * 列表折叠记忆
 *
 * Obsidian 自带的列表折叠不留痕：关掉笔记再打开，又全展开了。
 * 这个插件把折叠状态写进笔记本身 —— 在被折叠的那一项下面加一行注释：
 *
 *   - 父项
 *   	%% collapsed:: true %%        ← 缩进一级，跟 Logseq 的块属性放在同一个位置
 *   	- 子项一
 *   	- 子项二
 *
 * 写的是 Obsidian 的注释语法 %%…%%，所以这行东西平时一个字都看不见：
 *   · 阅读视图：Obsidian 自己就不渲染注释，天然没有
 *   · 编辑视图（实时预览 / 源码）：折着的时候它在折叠范围里；没折着时插件把它连同前面的换行一起替换掉，
 *     看起来就是母项那一行到头了。光标进不去，落到它后面会被挪回母项行尾，打字撞不到它
 * 想彻底清干净：命令「清除本文所有折叠标记」，一下全删掉，还原成没装插件时的原文。
 *
 * 标记写在文件里，所以换设备 / git / 导出 / 被 AI 重写都跟着内容走，
 * 不会像外部存档那样错位配对。
 *
 * 折叠本身用的是 Obsidian 自己那套（CodeMirror 的折叠状态：⌥S、行首箭头、Bullet 用的都是它），两边这样通气：
 *   · 标记 → 折叠：打开笔记时、文件被别的插件 / 同步改写后折叠丢了时，有标记的项补折上。只补折，不替你展开
 *   · 折叠 → 标记：你手动折 / 展开之后（⌥S、点箭头、点 …），照编辑器里实际折没折，一次写好这几项的标记。
 *     打字、文件被改写这类改正文的变动不算；别的插件折叠时用 quietly() 包住，就不会被当成你的操作记下来
 */

"use strict";

const {
	Plugin, PluginSettingTab, Setting, Notice, MarkdownView, TFile,
	editorInfoField, editorLivePreviewField,
} = require("obsidian");
const { StateField, StateEffect, EditorState, Annotation, Transaction } = require("@codemirror/state");
const { EditorView, Decoration, WidgetType, ViewPlugin } = require("@codemirror/view");

// Obsidian 的折叠就是 CodeMirror 的折叠状态：直接读写它，折出来跟 ⌥S 一模一样，也不用挪光标、不受屏幕范围限制
let lang = null;
try { lang = require("@codemirror/language"); } catch (e) { /* 拿不到就只管标记、不折叠 */ }
const HAS_FOLD = !!(lang && lang.foldEffect && lang.unfoldEffect && lang.foldedRanges && lang.foldable);
const OURS = Annotation.define();   // 插件自己发的折叠 / 改标记：不当成你的操作再记一遍

const LIST_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+|$)(.*)$/;          // 列表项：无序（- * +）和有序（1. 1)）一样看待
const ATTR_RE = /^[ \t]*%%[ \t]*collapsed::[ \t]*true[ \t]*%%[ \t]*$/;   // 折叠标记那一行
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;                            // 代码块围栏：里面的「列表」不算
const CALLOUT_RE = /^((?:>[ \t]?)+)/;                               // callout：> - a 里的列表照样认。只认行首的 >，且每个 > 后面最多吃一个空白，不能把列表自己的缩进吃掉
const BLOCK_ID_RE = /^[ \t]*\^[A-Za-z0-9-]+[ \t]*$/;                 // 单独一行的块 ID（^q-gufz，制卡插件常这么写，多半顶格）：算上一项的
const CHECKBOX_RE = /^\[[^\]]\][ \t]*/;                             // 复选框：勾没勾选不能影响指纹，先剥掉
const MARKDOWN_RE = /(\*\*|__|[*_`~]{1,2}|!?\[\[|\]\]|!?\[|\]\([^)]*\)|\(\))/g;

const TAB_SIZE = 4;
const ANCHOR_LEN = 16;      // 指纹取标题头几个字
const ATTR_TEXT = "%% collapsed:: true %%";

const DEFAULTS = {
	hoverHandle: true,       // 展开着的项：鼠标划过时尾巴上冒出折叠按钮
	reading: true,           // 阅读视图也照这些标记折叠
	showCount: true,         // 标记上写后代条数（⋯ 3）
	sourceFold: false,       // 源码模式也折叠（默认只藏标记，原文照样给你看）
};

// 你自己在改正文（打字、删、撤销、拖动）：这时候折叠跟着变不算「文件被改写」
const isTyping = (tr) => ["input", "delete", "undo", "redo", "move", "drop"].some((ev) => tr.isUserEvent(ev));
const foldCount = (state) => (HAS_FOLD ? lang.foldedRanges(state).size : 0);
const isAttrLine = (text) => ATTR_RE.test(text.replace(CALLOUT_RE, ""));

module.exports = class ListFoldMemory extends Plugin {

	// ------------------------------------------------------------ 生命周期

	async onload() {
		this.cache = new Map();      // 文件路径 → 解析结果（按内容缓存，打字不会反复重算）
		this.rawCache = new Map();   // 文件路径 → 正文文本（阅读视图要用，那里没有编辑器）
		this.reveal = false;         // 「临时露出折叠标记」
		this.quiet = 0;              // >0 时别的插件正在折叠（见 quietly）：这期间的折叠变化不记
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());
		this.refreshFx = StateEffect.define();   // 重画编辑器装饰

		this.registerEditorExtension(this.editorExtension());
		this.registerMarkdownPostProcessor((el, ctx) => {
			// 阅读视图的装饰同样不能因为一个坏标记 / 坏结构把整篇渲染弄挂
			try { this.readingView(el, ctx); }
			catch (e) { console.error("[list-fold-memory] 阅读视图折叠失败，跳过这一块", e); }
		});

		this.addCommand({
			id: "toggle-fold",
			name: "折叠 / 展开光标所在的列表项",
			checkCallback: (checking) => this.pickCursorItem(checking, (it, ctx) => this.flipItems([it], !this.shownFolded(ctx, it))),
		});
		this.addCommand({
			id: "collapse-all",
			name: "折叠本文所有列表项",
			checkCallback: (checking) => this.pickDoc(checking, (items, ctx) => {
				this.flipItems(items.filter((i) => i.childCount && !i.folded), true);
				if (ctx.cm) this.applyFolds(ctx.cm);   // 有标记却没折着的也补上
			}),
		});
		this.addCommand({
			id: "expand-all",
			name: "展开本文所有列表项",
			checkCallback: (checking) => this.pickDoc(checking, (items, ctx) => {
				const marked = items.filter((i) => i.folded);
				if (marked.length) this.flipItems(marked, false);
				if (ctx.cm) this.applyFolds(ctx.cm, true);   // 没有标记、但折着的（比如日记整理收起的 DONE 区）也展开
			}),
		});
		this.addCommand({
			id: "collapse-top-level",
			name: "只折叠顶层的列表项（子层保持现状）",
			checkCallback: (checking) => this.pickDoc(checking, (items) => this.flipItems(items.filter((i) => i.childCount && !i.folded && i.depth === 0), true)),
		});
		this.addCommand({
			id: "clear-markers",
			name: "清除本文所有折叠标记（还原成干净原文）",
			checkCallback: (checking) => this.pickDoc(checking, () => this.clearMarkers()),
		});
		this.addCommand({
			id: "reveal-markers",
			name: "临时露出折叠标记（再按一次藏回去）",
			callback: () => {
				this.reveal = !this.reveal;
				this.refreshAll();
				new Notice(this.reveal ? "折叠标记露出来了" : "折叠标记藏回去了");
			},
		});

		this.addSettingTab(new FoldSettingTab(this.app, this));

		this.registerEvent(this.app.vault.on("modify", (file) => this.forget(file)));

		// 切到另一个窗格 / 打开一篇笔记时，按标记把该折的折上
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view && view.editor && view.editor.cm) this.applyFolds(view.editor.cm);
		}));
	}

	onunload() {
		this.cache.clear();
		this.rawCache.clear();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshAll();
	}

	// 给别的插件用：fn 里发生的折叠 / 展开不写成标记（比如日记整理收起 DONE 区）。fn 里的折叠要是同步发出的
	quietly(fn) {
		this.quiet++;
		try { return fn(); }
		finally { this.quiet--; }
	}

	forget(file) {
		this.cache.delete(file.path);
		this.rawCache.delete(file.path);
	}

	// ------------------------------------------------------------ 上下文

	// 当前在编辑 / 阅读的文件：编辑器、CM 实例、正文文本
	activeCtx() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !(view.file instanceof TFile)) return null;
		const editor = view.editor || null;
		let text = editor ? editor.getValue() : null;
		if (text == null) text = this.rawCache.has(view.file.path) ? this.rawCache.get(view.file.path) : null;   // 阅读视图：用缓存的正文
		return {
			view, file: view.file,
			editor,
			cm: editor && editor.cm ? editor.cm : null,
			text,
		};
	}

	pickDoc(checking, fn) {
		const ctx = this.activeCtx();
		if (!ctx || ctx.text == null) return false;
		if (checking) return true;
		fn(this.doc(ctx.file, ctx.text).items, ctx);
		return true;
	}

	// 光标落在哪一项上（在续行 / 子项上时算它所属的母项）
	pickCursorItem(checking, fn) {
		const ctx = this.activeCtx();
		if (!ctx || ctx.text == null || !ctx.editor) return false;
		const line = ctx.editor.getCursor().line;
		const items = this.doc(ctx.file, ctx.text).items;
		let hit = null;
		for (const it of items) {
			if (it.line === line) { hit = it; break; }
			if (it.line < line && line <= it.end) hit = it;
		}
		if (!hit) return false;
		if (checking) return true;
		fn(hit, ctx);
		return true;
	}

	// ------------------------------------------------------------ 解析

	doc(file, text) {
		const key = hash32(text) + ":" + text.length;
		const hit = this.cache.get(file.path);
		if (hit && hit.key === key) return hit;
		const built = parseDoc(text);
		built.key = key;
		this.cache.set(file.path, built);
		this.rawCache.set(file.path, text);
		return built;
	}

	// 这一项的内层缩进用什么：缩进字符跟着文件习惯走（tab 还是空格），缩进量取文件里实际的层差
	unitOf(parsed, it) {
		return parsed.useTab ? "\t" : " ".repeat(parsed.unit || TAB_SIZE);
	}

	// 标记行前面要垫什么：callout 的 > 前缀 + 这一项自己的缩进 + 再一级
	padOf(parsed, it) {
		return (it.callout || "") + it.rawIndent + this.unitOf(parsed, it);
	}

	// ------------------------------------------------------------ 编辑器里的折叠状态

	// 从这一项起头的折叠：起点在母项那一行，或者在它下面的标记行（标记是后插进去的，折叠会被挤到标记行后面）
	foldsOf(state, it) {
		if (!HAS_FOLD) return [];
		const doc = state.doc;
		const head = doc.line(it.line + 1);
		const to = it.folded && it.line + 2 <= doc.lines ? doc.line(it.line + 2).to : head.to;
		const out = [];
		lang.foldedRanges(state).between(head.from, to, (f, t) => { if (f >= head.from && f <= to) out.push({ from: f, to: t }); });
		return out;
	}

	// 屏幕上这一项是不是折着（不管有没有标记）
	shownFolded(ctx, it) {
		return ctx.cm && HAS_FOLD ? this.foldsOf(ctx.cm.state, it).length > 0 : it.folded;
	}

	// 这一项按 Obsidian 自己的规则该折哪一段（跟 ⌥S 一样）；问不到就从行尾折到最后一个子孙
	nativeRange(state, it) {
		const doc = state.doc;
		const head = doc.line(it.line + 1);
		let r = null;
		try { r = lang.foldable(state, head.from, head.to); } catch (e) { r = null; }
		const last = doc.line(Math.min(it.end, doc.lines - 1) + 1);
		// 原生范围停在顶格的块 ID 行前面时，延到这一项真正的末尾
		if (r && r.from >= head.from && r.to > r.from) return last.to > r.to ? { from: r.from, to: last.to } : r;
		return last.to > head.to ? { from: head.to, to: last.to } : null;
	}

	// 标记 → 折叠：有标记却没折着的折上。unfold 为真时（只有「展开本文所有列表项」这种明确的操作），没标记却折着的也展开
	applyFolds(view, unfold) {
		if (!HAS_FOLD || !view || !view.state || !view.dom || !view.dom.isConnected) return;
		const state = view.state;
		const file = state.field(editorInfoField, false)?.file;
		if (!file) return;
		// 源码模式（没开「源码模式下也折叠」）不折，标记只由装饰藏起来
		if (!state.field(editorLivePreviewField, false) && !this.settings.sourceFold) return;
		const parsed = this.doc(file, state.doc.toString());
		const effects = [];
		for (const it of parsed.items) {
			if (!it.childCount) continue;
			const have = this.foldsOf(state, it);
			if (it.folded) {
				const want = this.nativeRange(state, it);
				if (!want || have.some((r) => r.from === want.from && r.to >= want.to)) continue;   // 已经折对了（⌥S 折出来的范围可能短一截，漏了末尾的块 ID 行）
				for (const r of have) effects.push(lang.unfoldEffect.of(r));      // 折歪了的（起点在标记行后面）先拆掉
				effects.push(lang.foldEffect.of(want));
			} else if (unfold) {
				for (const r of have) effects.push(lang.unfoldEffect.of(r));
			}
		}
		if (effects.length) view.dispatch({ effects, annotations: OURS.of(true) });
	}

	// 折叠 → 标记：positions 是你刚折 / 展开的那几处折叠起点。照编辑器里现在实际折没折，一次写好这几项的标记
	recordFolds(view, positions) {
		const state = view.state;
		const file = state.field(editorInfoField, false)?.file;
		if (!file) return;
		const parsed = this.doc(file, state.doc.toString());
		const on = [], off = [], seen = new Set();
		for (const pos of positions) {
			if (pos == null || pos < 0 || pos > state.doc.length) continue;
			const ln = state.doc.lineAt(pos).number - 1;
			const it = parsed.items.find((x) => x.childCount && (x.line === ln || (x.folded && x.line + 1 === ln)));
			if (!it || seen.has(it)) continue;
			seen.add(it);
			const now = this.foldsOf(state, it).length > 0;
			if (now && !it.folded) on.push(it);
			else if (!now && it.folded) off.push(it);
		}
		if (!on.length && !off.length) { if (seen.size) this.applyFolds(view); return; }   // 标记早就有了：只把范围扶正
		const edits = [...this.attrEdits(state.doc, parsed, on, true), ...this.attrEdits(state.doc, parsed, off, false)].sort((a, b) => a.from - b.from);
		if (!edits.length) return;
		// 标记不进撤销历史：⌘Z 撤的是你写的字，不是折叠记录
		view.dispatch({ changes: edits, annotations: [OURS.of(true), Transaction.addToHistory.of(false)] });
		this.forget(file);
		if (on.length) this.applyFolds(view);   // 新标记插在折叠起点上，会把折叠挤到标记行后面：按原生范围扶正
	}

	// ------------------------------------------------------------ 改标记

	// ctxOverride：从某个具体的编辑器现场传进来（比如那个窗格不是当前活动的那个）
	flipItems(targets, fold, ctxOverride) {
		const ctx = ctxOverride || this.activeCtx();
		if (!ctx || ctx.text == null || !targets.length) {
			if (!targets.length) new Notice(fold ? "没有可以折叠的项" : "没有折叠着的项");
			return;
		}
		const parsed = this.doc(ctx.file, ctx.text);
		const sorted = targets.slice().sort((a, b) => b.line - a.line);   // 从后往前，行号不塌

		if (ctx.cm) {
			// 编辑器里改：不碰磁盘、不弹重载、⌘Z 能撤销
			const view = ctx.cm;
			// 展开：先拆编辑器里的折叠，再删标记（先删标记就认不出折叠是从哪一项起头的了）
			if (!fold && HAS_FOLD) {
				const effects = [];
				for (const it of sorted) for (const r of this.foldsOf(view.state, it)) effects.push(lang.unfoldEffect.of(r));
				if (effects.length) view.dispatch({ effects, annotations: OURS.of(true) });
			}
			const edits = this.attrEdits(view.state.doc, parsed, sorted, fold);
			if (edits.length) view.dispatch({ changes: edits, annotations: [OURS.of(true), Transaction.addToHistory.of(true)] });
			this.forget(ctx.file);
			if (fold) this.applyFolds(view);   // 标记写好了：照标记真的折起来
		} else {
			// 阅读视图：直接改文件，Obsidian 会自己重渲染
			let text = ctx.text;
			for (const it of sorted) text = setAttrLine(text, it.line, fold, this.padOf(parsed, it));
			this.app.vault.modify(ctx.file, text);
			this.forget(ctx.file);
		}
		this.refresh(ctx.file);
		if (fold) new Notice(`折叠了 ${targets.length} 项`);
	}

	// 写 / 删标记行。只动真有（或真没有）标记的那一行：下面那行不是标记就绝不删，已经有了就不重复插
	attrEdits(doc, parsed, targets, fold) {
		const edits = [];
		for (const it of targets) {
			const a = it.line + 1;                                   // 标记行（0 起）
			const has = a < doc.lines && isAttrLine(doc.line(a + 1).text);
			if (fold) {
				if (has) continue;
				const at = doc.line(it.line + 1).to;
				edits.push({ from: at, to: at, insert: "\n" + this.padOf(parsed, it) + ATTR_TEXT });
			} else {
				if (!has) continue;
				// 删标记行要连它前面的换行一起删，不留空行
				edits.push({ from: doc.line(a).to, to: doc.line(a + 1).to, insert: "" });
			}
		}
		edits.sort((x, y) => x.from - y.from);
		return edits;
	}

	clearMarkers() {
		const ctx = this.activeCtx();
		if (!ctx || ctx.text == null) return;
		const lines = ctx.text.split("\n");
		const hits = [];
		lines.forEach((l, i) => { if (isAttrLine(l)) hits.push(i); });
		if (!hits.length) { new Notice("本文没有折叠标记"); return; }
		if (ctx.cm) {
			// 一行一行删，别整篇替换：整篇替换会把编辑器里所有折叠一起冲掉
			const doc = ctx.cm.state.doc;
			const changes = hits.map((i) => (i > 0
				? { from: doc.line(i).to, to: doc.line(i + 1).to, insert: "" }
				: { from: 0, to: Math.min(doc.length, doc.line(1).to + 1), insert: "" }));
			ctx.cm.dispatch({ changes, annotations: [OURS.of(true), Transaction.addToHistory.of(true)] });
		} else {
			this.app.vault.modify(ctx.file, lines.filter((l) => !isAttrLine(l)).join("\n"));
		}
		this.forget(ctx.file);
		this.refresh(ctx.file);
		new Notice(`清掉 ${hits.length} 行折叠标记，原文还原了`);
	}

	// ------------------------------------------------------------ 刷新

	refresh(file) {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file && view.file.path === file.path && view.editor && view.editor.cm) {
				view.editor.cm.dispatch({ effects: this.refreshFx.of(null) });
			}
		});
	}

	refreshAll() {
		this.cache.clear();
		this.rawCache.clear();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.editor && view.editor.cm) {
				view.editor.cm.dispatch({ effects: this.refreshFx.of(null) });
			}
		});
	}

	// ------------------------------------------------------------ 编辑器（实时预览 / 源码）

	editorExtension() {
		const plugin = this;

		// 展开着的项：鼠标划到那一行时在行尾冒出来的折叠按钮
		// （折起来之后的占位是 Obsidian 自己的，跟 ⌥S 折出来长得一模一样，不用我们画）
		class HoverHandle extends WidgetType {
			constructor(count, key) { super(); this.count = count; this.key = key; }
			eq(o) { return o.count === this.count && o.key === this.key; }
			toDOM() {
				const el = createSpan({ cls: "lf-collapse-handle" });
				el.setText(plugin.settings.showCount ? "⌄ " + this.count : "⌄");
				el.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					plugin.flipItems(plugin.itemsByKey(this.key), true);
				});
				return el;
			}
			ignoreEvent() { return false; }
		}

		const HIDE = Decoration.replace({ lfHide: true });

		const buildInner = (state) => {
			const file = state.field(editorInfoField, false)?.file;
			if (!file) return Decoration.none;
			const doc = state.doc;
			const parsed = plugin.doc(file, doc.toString());
			// 源码模式（没开「源码模式下也折叠」）Obsidian 不画折叠：折叠状态还在（从实时预览带过来的），但屏幕上是全展开的，不能拿它当「已经盖住了」
			const wantFold = !!state.field(editorLivePreviewField, false) || plugin.settings.sourceFold;
			const folds = HAS_FOLD && wantFold ? lang.foldedRanges(state) : null;
			const covered = (from, to) => {
				let hit = false;
				if (folds) folds.between(from, to, (a, b) => { if (a <= from && b >= to) hit = true; });
				return hit;
			};
			const decos = [];

			// 一、标记行：连同它前面的换行一起替换掉，母项那一行看起来就到头了；光标进不去（见下面 atomicRanges 和 snap）。
			//     这种替换跨了换行，所以必须由 StateField 直接提供 —— ViewPlugin 给的跨行替换 CodeMirror 不认，整个编辑器会挂。
			//     已经在折叠范围里的不用再管
			if (!plugin.reveal) {
				for (const ln of parsed.attrLines) {
					if (ln >= doc.lines) continue;
					const self = doc.line(ln + 1);
					const from = ln > 0 ? doc.line(ln).to : self.from;
					if (self.to <= from || covered(from, self.to)) continue;
					decos.push(HIDE.range(from, self.to));
				}
			}

			// 二、展开着的项：鼠标划过去时行尾那个折叠按钮
			if (HAS_FOLD && wantFold && plugin.settings.hoverHandle) {
				for (const it of parsed.items) {
					if (!it.childCount || it.folded) continue;
					const head = doc.line(it.line + 1);
					if (covered(head.to, head.to)) continue;   // 自己折着，或者在折着的母项里
					decos.push(Decoration.widget({
						widget: new HoverHandle(it.descCount, plugin.keyOf(file, it)),
						side: 1,
					}).range(head.to));
				}
			}

			return decos.length ? Decoration.set(decos, true) : Decoration.none;
		};

		// 装饰只是锦上添花：算的时候出任何错都不该把整篇笔记的编辑器带崩（那样看起来就是「笔记打不开」）
		const build = (state) => {
			try { return buildInner(state); }
			catch (e) {
				console.error("[list-fold-memory] 生成折叠装饰失败，跳过这一次", e);
				return Decoration.none;
			}
		};

		const isLP = (state) => !!state.field(editorLivePreviewField, false);
		const field = StateField.define({
			create: build,
			update(value, tr) {
				const foldMoved = HAS_FOLD && lang.foldedRanges(tr.startState) !== lang.foldedRanges(tr.state);
				if (tr.docChanged || foldMoved || isLP(tr.startState) !== isLP(tr.state) || tr.effects.some((e) => e.is(plugin.refreshFx))) return build(tr.state);
				return value;
			},
			provide: (f) => [
				EditorView.decorations.from(f),
				// 藏起来的标记行是一个原子：光标直接跳过，不可能停进去把它打坏
				EditorView.atomicRanges.of((view) => view.state.field(f, false) || Decoration.none),
			],
		});

		// 光标落到藏起来那段的后头（视觉上跟母项行尾是同一个位置）就挪回母项行尾：在那儿打字才是接着母项写，不会写进标记行。
		// 从母项行尾往右走的那一下例外，直接去下一行行首
		const snap = EditorState.transactionFilter.of((tr) => {
			const decos = tr.startState.field(field, false);
			if (!decos) return tr;
			// 改动把藏起来的标记行拆了半截，或者把它拼进了别的行（母项行尾往后删时 Obsidian 会把「母项 + 标记行」整段换成拼好的一行；
			// 子项行首退格会把子项接到标记行后面）：标记行要么整行在、要么整行没有，坏一半就成了露出来的乱码。
			// 这种改动换成「只把这一段标记删掉」—— 这一项本来就展开着，等于不再记它折叠；再按一次才是原来那个操作
			// 只管你在光标处按键引起的改动（打字、删除，或者 Obsidian 列表命令这种带着光标的）：文件被日记整理 / 同步改写后
			// 同步进编辑器的那次改动不能拦，拦了编辑器就跟文件对不上了
			const cur = tr.startState.selection.main.head;
			const byKey = tr.isUserEvent("input") || tr.isUserEvent("delete") || !!tr.selection;
			if (tr.docChanged && byKey && !tr.annotation(OURS)) {
				let hit = null;
				tr.changes.iterChanges((fA, tA, fB, tB, ins) => {
					if (hit || cur < fA || cur > tA) return;   // 这处改动没碰到光标
					decos.between(Math.max(0, fA - 1), tA, (from, to, d) => {
						if (hit || !d.spec.lfHide) return;
						const inside = fA < to && tA > from;          // 动到了藏起来那段里面
						const eatsTail = fA === to && tA > to;        // 删掉了标记行后面的换行，下一行会接上来
						if (!inside && !eatsTail) return;
						const whole = fA <= from && tA >= to && !/collapsed::/.test(ins.toString());   // 整段一起删掉、没再写回来：照常
						if (!whole) hit = { from, to };
					});
				});
				if (!hit) return tr;
				return { changes: { from: hit.from, to: hit.to }, selection: { anchor: hit.from }, userEvent: "delete", scrollIntoView: true };
			}
			if (!tr.selection || tr.docChanged) return tr;
			const sel = tr.selection;
			if (sel.ranges.length !== 1 || !sel.main.empty) return tr;
			const head = sel.main.head;
			let hit = null;
			decos.between(head, head, (from, to, d) => { if (d.spec.lfHide && to === head && from < to) hit = { from, to }; });
			if (!hit) return tr;
			const prev = tr.startState.selection.main.head;
			const pos = prev === hit.from && hit.to < tr.startState.doc.length ? hit.to + 1 : hit.from;
			return [tr, { selection: { anchor: pos }, sequential: true }];
		});

		this.markField = field;   // 排错用：view.state.field(plugin.markField) 是当前藏起来的标记行
		return [field, snap, this.foldSyncExtension()];
	}

	// ------------------------------------------------------------ 跟 Obsidian 自带折叠互相通气

	foldSyncExtension() {
		const plugin = this;
		return ViewPlugin.fromClass(class {
			constructor(view) {
				this.view = view;
				this.pending = [];   // 你刚折 / 展开的折叠起点，等这一轮更新画完一起记
				this.lost = false;   // 文件被改写、折叠跟着丢了：按标记补回来
				this.timer = 0;
				this.settle();
			}

			// 刚打开一篇笔记：按标记补折。live preview 有时还没就绪、Obsidian 也会稍后恢复它自己记的折叠，
			// 所以过一会儿再补两次；这段时间里的折叠变化是「恢复」不是你的操作，不记
			settle() {
				this.calmUntil = Date.now() + 1500;
				for (const ms of [0, 300, 1200]) setTimeout(() => plugin.applyFolds(this.view), ms);
			}

			update(u) {
				if (!HAS_FOLD) return;
				for (const tr of u.transactions) {
					if (tr.docChanged) {
						this.pending = this.pending.map((p) => tr.changes.mapPos(p, -1));
						let whole = false;
						tr.changes.iterChangedRanges((fA, tA) => { if (fA === 0 && tA === tr.startState.doc.length) whole = true; });
						if (whole && tr.startState.doc.length) { this.settle(); continue; }   // 整篇换掉 = 换了一篇笔记 / 重新载入
						if (!tr.annotation(OURS) && !isTyping(tr) && foldCount(tr.state) < foldCount(tr.startState)) this.lost = true;
						continue;
					}
					if (tr.annotation(OURS) || plugin.quiet || Date.now() < this.calmUntil) continue;
					for (const e of tr.effects) {
						if (e.is(lang.foldEffect) || e.is(lang.unfoldEffect)) this.pending.push(e.value.from);
					}
				}
				if ((this.pending.length || this.lost) && !this.timer) {
					// 不能在这一轮更新里再改文档：等它画完
					this.timer = setTimeout(() => {
						this.timer = 0;
						const ps = this.pending, lost = this.lost;
						this.pending = [];
						this.lost = false;
						if (!this.view.dom.isConnected) return;
						try {
							if (ps.length) plugin.recordFolds(this.view, ps);
							if (lost) plugin.applyFolds(this.view);
						} catch (e) { console.error("[list-fold-memory] 同步折叠失败", e); }
					}, 0);
				}
			}

			destroy() { clearTimeout(this.timer); }
		});
	}

	keyOf(file, it) {
		return file.path + "|" + it.depth + "|" + it.fingerprint;
	}

	// 从标记 / 按钮上的 key 反查到具体那一项（点的时候才知道要动谁）
	itemsByKey(key) {
		const ctx = this.activeCtx();
		if (!ctx || ctx.text == null) return [];
		const parts = key.split("|");
		const path = parts[0];
		if (path !== ctx.file.path) return [];
		const depth = Number(parts[1]);
		const fp = parts.slice(2).join("|");
		const hit = this.doc(ctx.file, ctx.text).items.find((it) => it.depth === depth && it.fingerprint === fp);
		return hit ? [hit] : [];
	}

	// ------------------------------------------------------------ 阅读视图

	readingView(el, ctx) {
		if (!this.settings.reading) return;
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) return;

		let text = this.rawCache.get(file.path);
		if (text == null) {
			// 第一次渲染还没读到：异步读进来，读到了让预览重渲染一次
			this.app.vault.cachedRead(file).then((t) => {
				this.rawCache.set(file.path, t);
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view && view.file && view.file.path === file.path) {
					try { view.previewMode.rerender(true); } catch (e) { /* 版本不支持就算了 */ }
				}
			});
			return;
		}

		const parsed = this.doc(file, text);
		const listEls = [];
		collectLists(el, listEls);

		for (const li of listEls) {
			const sub = directSubList(li);
			if (!sub) continue;
			if (li.querySelector(":scope > .lf-collapse-marker")) continue;
			const key = depthOfLi(li) + "|" + fingerprintOf(liText(li));
			const item = parsed.items.find((it) => it.depth + "|" + it.fingerprint === key);
			const folded = !!(item && item.folded);
			const badge = createSpan({ cls: "lf-collapse-marker lf-reading" + (folded ? "" : " lf-idle") });
			badge.createSpan({ cls: "lf-dots", text: folded ? "⋯" : "⌄" });
			if (folded && this.settings.showCount) {
				const n = countDomItems(sub);
				if (n) badge.createSpan({ cls: "lf-count", text: String(n) });
			}
			li.insertBefore(badge, sub);
			if (folded) li.classList.add("lf-li-collapsed");
			if (!item) continue;
			badge.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				// 点的时候重新读一遍：渲染完之后可能又改过，行号早就不一样了
				this.app.vault.process(file, (t) => {
					const p = parseDoc(t);
					const target = p.items.find((x) => x.depth + "|" + x.fingerprint === key);
					if (!target) return t;
					const pad = (target.callout || "") + target.rawIndent + this.unitOf(p, target);
					return setAttrLine(t, target.line, !folded, pad);
				});
			});
		}
	}
};

// ---------------------------------------------------------------- 解析

// 把一个文件里的列表全拎出来：
//   items      —— 所有列表项，先序（母项一定排在它的子项前面）
//   attrLines  —— 所有折叠标记的行号（0 起）
//   unit/useTab —— 这个文件习惯用什么缩进
function parseDoc(text) {
	const lines = text.split("\n");
	const n = lines.length;
	const items = [];
	const attrLines = [];
	const stack = [];
	let fenceMark = null;

	for (let i = 0; i < n; i++) {
		const raw = lines[i];

		// 代码块：整段跳过（留着列表的上下文不动 —— 列表里经常嵌代码块，跳完还得认得回去）
		const fence = raw.match(FENCE_RE);
		if (fence) {
			const mark = fence[1][0];
			if (fenceMark === null) fenceMark = mark;
			else if (fenceMark === mark) fenceMark = null;
			continue;
		}
		if (fenceMark !== null) {
			// 代码块算进母项的范围：这一项折叠时，嵌在里面的代码块也跟着藏起来
			if (stack.length && i > stack[stack.length - 1].item.end) stack[stack.length - 1].item.end = i;
			continue;
		}

		// callout：> - a 里的列表照样认，把 > 前缀先剥掉（标记行也可能在 callout 里）
		const body = raw.replace(CALLOUT_RE, "");

		// 折叠标记行：算进母项的范围（折叠时连它一起藏），单独收纳
		if (ATTR_RE.test(body)) {
			attrLines.push(i);
			if (stack.length && i > stack[stack.length - 1].item.end) stack[stack.length - 1].item.end = i;
			continue;
		}

		const m = body.match(LIST_RE);
		if (!m) {
			if (!stack.length) continue;
			const top = stack[stack.length - 1];
			if (body.trim() === "") {
				// 空行：往下看一眼，还是缩进的内容就当这段列表没断
				const j = nextContent(lines, i);
				if (j < 0) { stack.length = 0; continue; }
				const nb = lines[j].replace(CALLOUT_RE, "");
				const nm = nb.match(LIST_RE);
				if (nm && indentWidth(nm[1]) > top.indent) continue;
				if (!nm && indentWidth(nb) > 0) continue;
				stack.length = 0;
				continue;
			}
			// 单独一行的块 ID：哪怕顶格，Markdown 也当它是上一段的续行（还在这一项里），折叠时一起收进去，列表不在这儿断
			if (BLOCK_ID_RE.test(body)) {
				if (i > top.item.end) top.item.end = i;
				continue;
			}
			// 缩进的普通文字：算进母项的范围
			if (indentWidth(body) > top.indent) {
				if (i > top.item.end) top.item.end = i;
				continue;
			}
			stack.length = 0;
			continue;
		}

		const indent = indentWidth(m[1]);
		while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
		const parent = stack.length ? stack[stack.length - 1].item : null;
		const callout = raw.match(CALLOUT_RE);
		const it = {
			line: i, end: i, indent, depth: stack.length,
			rawIndent: m[1], body: m[4], children: [], parent,
			callout: callout ? callout[1] : "",
			childCount: 0, descCount: 0, folded: false,
			fingerprint: fingerprintOf(m[4]),
		};
		items.push(it);
		if (parent) parent.children.push(it);
		stack.push({ indent, item: it });
	}

	for (const it of items) if (!it.parent) settle(it);

	// 标记认领：紧跟在某一项后面，就算这一项的
	const byLine = new Map();
	for (const it of items) byLine.set(it.line + 1, it);
	for (const ln of attrLines) {
		const owner = byLine.get(ln);
		if (owner && owner.childCount > 0) owner.folded = true;
	}

	// 这个文件习惯怎么缩进：母项/子项的缩进差取最小值，知道基准别科
	let unit = 0;
	let prev = null;
	let useTab = false;
	for (const it of items) {
		if (it.rawIndent.indexOf("\t") >= 0) useTab = true;
		if (prev !== null && it.indent > prev) {
			const d = it.indent - prev;
			if (!unit || d < unit) unit = d;
		}
		prev = it.indent;
	}

	return { items, attrLines, unit: unit || TAB_SIZE, useTab };
}

// 向上汇总范围和子孙数
function settle(it) {
	let end = it.end;
	let desc = 0;
	let kids = 0;
	for (const c of it.children) {
		const ce = settle(c);
		kids++;
		desc += 1 + c.descCount;
		if (ce > end) end = ce;
	}
	it.end = end;
	it.childCount = kids;
	it.descCount = desc;
	return end;
}

function nextContent(lines, from) {
	for (let j = from + 1; j < lines.length; j++) if (lines[j].trim() !== "") return j;
	return -1;
}

function indentWidth(str) {
	let w = 0;
	for (let i = 0; i < str.length; i++) {
		const c = str[i];
		if (c === "\t") w += TAB_SIZE - (w % TAB_SIZE);
		else if (c === " ") w += 1;
		else break;
	}
	return w;
}

// 标题指纹：剥掉复选框和 markdown 记号、压平空白、小写、取头 ANCHOR_LEN 个字。
// 编辑器里算的是源码行，阅读视图里算的是渲染后的文字，两边剥干净了才对得上
function fingerprintOf(s) {
	let t = String(s || "").replace(CHECKBOX_RE, "");
	t = t.replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, a, b) => b || a);
	t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
	t = t.replace(MARKDOWN_RE, "");
	t = t.replace(/\s+/g, " ").trim().toLowerCase();
	return hash32(Array.from(t).slice(0, ANCHOR_LEN).join(""));
}

function hash32(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}

// 在某一项下面加上 / 删掉标记行（幂等：已经有了不重复插）
function setAttrLine(text, line, fold, pad) {
	const lines = text.split("\n");
	const has = isAttrLine(lines[line + 1] || "");
	if (fold && !has) lines.splice(line + 1, 0, pad + ATTR_TEXT);
	if (!fold && has) lines.splice(line + 1, 1);
	return lines.join("\n");
}

// ---------------------------------------------------------------- 阅读视图 DOM

function directSubList(li) {
	for (const el of Array.from(li.children)) if (el.tagName === "UL" || el.tagName === "OL") return el;
	return null;
}

// 把一段渲染好的 HTML 里所有带子列表的 li 按先序收出来
function collectLists(root, out) {
	for (const child of Array.from(root.children)) {
		if (child.tagName === "UL" || child.tagName === "OL") walkList(child, out);
		else collectLists(child, out);
	}
}

function walkList(ul, out) {
	for (const li of Array.from(ul.children)) {
		if (li.tagName !== "LI") continue;
		if (directSubList(li)) {
			out.push(li);
			walkList(directSubList(li), out);
		}
	}
}

// li 自己的文字（不含子列表）。万一 Obsidian 没剥干净注释，也别让它毁了指纹
function liText(li) {
	let s = "";
	for (const node of Array.from(li.childNodes)) {
		if (node.nodeType === 3) s += node.textContent || "";
		else if (node.tagName === "UL" || node.tagName === "OL") continue;
		else s += node.textContent || "";
	}
	return s.replace(/%%[ \t]*collapsed::[ \t]*true[ \t]*%%/g, "").replace(/collapsed::\s*true/g, "");
}

function depthOfLi(li) {
	let d = 0;
	let cur = li.parentElement;
	while (cur) {
		if (cur.tagName === "UL" || cur.tagName === "OL") d++;
		cur = cur.parentElement;
	}
	return Math.max(0, d - 1);
}

function countDomItems(ul) {
	let n = 0;
	for (const li of Array.from(ul.children)) {
		if (li.tagName !== "LI") continue;
		n++;
		const sub = directSubList(li);
		if (sub) n += countDomItems(sub);
	}
	return n;
}

// ---------------------------------------------------------------- 设置

class FoldSettingTab extends PluginSettingTab {
	constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
	display() {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl).setName("标记的样子").setHeading();
		new Setting(containerEl)
			.setName("鼠标划过时显示折叠按钮")
			.setDesc("展开着的列表项，鼠标移到那一行时尾巴上冒出一个小按钮，点一下折叠。不划过去的时候不占地方")
			.addToggle((t) => t.setValue(s.hoverHandle).onChange(async (v) => { s.hoverHandle = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("折叠按钮上显示后代条数")
			.setDesc("鼠标划到某一项上时，那个折叠按钮显示成「⌄ 3」，数字是它下面一共有几条。折起来之后的占位是 Obsidian 自己的（⋯），这个改不了")
			.addToggle((t) => t.setValue(s.showCount).onChange(async (v) => { s.showCount = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName("在哪些视图里生效").setHeading();
		new Setting(containerEl)
			.setName("阅读视图也折叠")
			.setDesc("阅读视图里按文件里的标记收起列表，点那个小标记能展开")
			.addToggle((t) => t.setValue(s.reading).onChange(async (v) => { s.reading = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("源码模式下也折叠")
			.setDesc("默认只在实时预览里折叠；源码模式只把标记行藏起来，列表原文照样给你看。想让源码模式也折叠就打开")
			.addToggle((t) => t.setValue(s.sourceFold).onChange(async (v) => { s.sourceFold = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName("排错").setHeading();
		new Setting(containerEl)
			.setName("临时露出折叠标记")
			.setDesc("想知道笔记里到底写了什么就用这个（也可以跑命令「临时露出折叠标记」）。命令「清除本文所有折叠标记」能把它们彻底删掉")
			.addToggle((t) => t.setValue(!!this.plugin.reveal).onChange(async (v) => { this.plugin.reveal = v; await this.plugin.refreshAll(); }));
	}
}
