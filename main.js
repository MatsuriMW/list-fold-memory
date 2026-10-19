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
 *   · 编辑视图（实时预览 / 源码）：插件用编辑器装饰把整行连换行一起抹掉，
 *     光标也进不去（当一个原子跳过），打字撞不到它
 * 想彻底清干净：命令「清除本文所有折叠标记」，一下全删掉，还原成没装插件时的原文。
 *
 * 标记写在文件里，所以换设备 / git / 导出 / 被 AI 重写都跟着内容走，
 * 不会像外部存档那样错位配对。
 */

"use strict";

const {
	Plugin, PluginSettingTab, Setting, Notice, MarkdownView, TFile,
	editorInfoField, editorLivePreviewField,
} = require("obsidian");
const { StateField, StateEffect } = require("@codemirror/state");
const { EditorView, Decoration, WidgetType, ViewPlugin } = require("@codemirror/view");

// 折叠直接借 Obsidian 自己那一套（⌥S 用的就是它），折出来的样子、行首那个箭头、
// 点一下展开的手感全都是原生的。拿不到这套 API 时才退回自己画一个占位
let foldEffect, unfoldEffect, foldedRanges, foldState, codeFolding;
try {
	const lang = require("@codemirror/language");
	foldEffect = lang.foldEffect;
	unfoldEffect = lang.unfoldEffect;
	foldedRanges = lang.foldedRanges;
	foldState = lang.foldState;
	codeFolding = lang.codeFolding;
} catch (e) { /* 老版本没有就算了，下面有退路 */ }
const HAS_FOLD = !!(foldEffect && unfoldEffect && foldedRanges && foldState);

const LIST_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+|$)(.*)$/;          // 列表项：无序（- * +）和有序（1. 1)）一样看待
const ATTR_RE = /^[ \t]*%%[ \t]*collapsed::[ \t]*true[ \t]*%%[ \t]*$/;   // 折叠标记那一行
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;                            // 代码块围栏：里面的「列表」不算
const CALLOUT_RE = /^((?:>[ \t]?)+)/;                               // callout：> - a 里的列表照样认。只认行首的 >，且每个 > 后面最多吃一个空白，不能把列表自己的缩进吃掉
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

module.exports = class ListFoldMemory extends Plugin {

	// ------------------------------------------------------------ 生命周期

	async onload() {
		this.cache = new Map();      // 文件路径 → 解析结果（按内容缓存，打字不会反复重算）
		this.rawCache = new Map();   // 文件路径 → 正文文本（阅读视图要用，那里没有编辑器）
		this.reveal = false;         // 「临时露出折叠标记」
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());
		this.refreshFx = StateEffect.define();   // 重画编辑器装饰
		this.lfFx = StateEffect.define();        // 标记「这次折叠是插件自己发的」，免得又当成你手动折的写回文件

		this.registerEditorExtension(this.editorExtension());
		this.registerMarkdownPostProcessor((el, ctx) => this.readingView(el, ctx));

		this.addCommand({
			id: "toggle-fold",
			name: "折叠 / 展开光标所在的列表项",
			checkCallback: (checking) => this.pickCursorItem(checking, (it) => this.flipItems([it], !it.folded)),
		});
		this.addCommand({
			id: "collapse-all",
			name: "折叠本文所有列表项",
			checkCallback: (checking) => this.pickDoc(checking, (items) => this.flipItems(items.filter((i) => i.childCount && !i.folded), true)),
		});
		this.addCommand({
			id: "expand-all",
			name: "展开本文所有列表项",
			checkCallback: (checking) => this.pickDoc(checking, (items) => this.flipItems(items.filter((i) => i.folded), false)),
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

		this.registerEvent(this.app.vault.on("modify", (file) => {
			this.cache.delete(file.path);
			this.rawCache.delete(file.path);
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
			const { Transaction } = require("@codemirror/state");
			const edits = this.attrEdits(ctx.cm.state.doc, parsed, sorted, fold);
			if (!edits.length) return;
			ctx.cm.dispatch({ changes: edits, annotations: Transaction.addToHistory.of(true) });
		} else {
			// 阅读视图：直接改文件，Obsidian 会自己重渲染
			let text = ctx.text;
			for (const it of sorted) text = setAttrLine(text, it.line, fold, this.padOf(parsed, it));
			this.app.vault.modify(ctx.file, text);
		}
		this.cache.delete(ctx.file.path);
		this.rawCache.delete(ctx.file.path);
		this.refresh(ctx.file);
		if (fold) new Notice(`折叠了 ${targets.length} 项`);
	}

	attrEdits(doc, parsed, targets, fold) {
		const edits = [];
		for (const it of targets) {
			if (fold) {
				const at = doc.line(it.line + 1).to;
				edits.push({ from: at, to: at, insert: "\n" + this.padOf(parsed, it) + ATTR_TEXT });
			} else {
				// 删标记行要连它前面的换行一起删，不留空行；它是全文最后一行时只删自己
				const a = it.line + 1;
				if (a >= doc.lines) continue;
				const self = doc.line(a + 1);
				let from = self.from;
				let to = self.to;
				if (a > 0) from = doc.line(a).to;
				else if (doc.lines > 1) to = doc.line(2).from;
				edits.push({ from, to, insert: "" });
			}
		}
		edits.sort((x, y) => x.from - y.from);
		return edits;
	}

	clearMarkers() {
		const ctx = this.activeCtx();
		if (!ctx || ctx.text == null) return;
		const lines = ctx.text.split("\n");
		const kept = lines.filter((l) => !ATTR_RE.test(l));
		const removed = lines.length - kept.length;
		if (!removed) { new Notice("本文没有折叠标记"); return; }
		const text = kept.join("\n");
		if (ctx.cm) {
			const { Transaction } = require("@codemirror/state");
			ctx.cm.dispatch({ changes: { from: 0, to: ctx.cm.state.doc.length, insert: text }, annotations: Transaction.addToHistory.of(true) });
		} else {
			this.app.vault.modify(ctx.file, text);
		}
		this.cache.delete(ctx.file.path);
		this.rawCache.delete(ctx.file.path);
		this.refresh(ctx.file);
		new Notice(`清掉 ${removed} 行折叠标记，原文还原了`);
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
		const refresh = this.refreshFx;

		// 拿不到 Obsidian 自带折叠时才用的占位：一个能点开的标记，写着里面藏了几条
		// （能拿到就用原生的，它长在行尾、跟 ⌥S 折出来的一模一样）
		class CollapsedMarker extends WidgetType {
			constructor(count, key) { super(); this.count = count; this.key = key; }
			eq(o) { return o.count === this.count && o.key === this.key; }
			toDOM() {
				const el = createDiv({ cls: "lf-collapse-marker" });
				el.createSpan({ cls: "lf-dots", text: "⋯" });
				if (plugin.settings.showCount) el.createSpan({ cls: "lf-count", text: String(this.count) });
				el.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					plugin.flipItems(plugin.itemsByKey(this.key), false);
				});
				return el;
			}
			ignoreEvent() { return false; }
		}

		// 展开着的项：鼠标划到那一行时在行尾冒出来的折叠按钮
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

		const build = (state) => {
			const file = state.field(editorInfoField, false)?.file;
			if (!file) return Decoration.none;
			const livePreview = !!state.field(editorLivePreviewField, false);
			const parsed = plugin.doc(file, state.doc.toString());
			const { items, attrLines } = parsed;
			const decos = [];
			const wantFold = livePreview || plugin.settings.sourceFold;

			// 一、标记行藏起来：连换行一起抹掉
			//     已经折起来的项不用管 —— 整段都被原生折叠盖住了，再藏一次会跟它撞车
			if (!plugin.reveal) {
				for (const ln of attrLines) {
					if (ln >= state.doc.lines) continue;
					const self = state.doc.line(ln + 1);
					if (wantFold && plugin.foldAt(state, self.from, self.to)) continue;
					const next = ln + 2 <= state.doc.lines ? state.doc.line(ln + 2) : null;
					decos.push(Decoration.replace({ block: true }).range(self.from, next ? next.from : self.to));
				}
			}

			if (wantFold) {
				// 二、折叠：交给 Obsidian 自己那套（见 foldSyncExtension），这里什么都不画
				//     拿不到原生折叠时才自己画一个占位（不带 block，才会贴在行尾而不是另起一行）
				if (!HAS_FOLD) {
					for (const it of items) {
						if (!it.folded || !it.childCount || ancestorFolded(it)) continue;
						const head = state.doc.line(it.line + 1);
						const tail = state.doc.line(Math.min(it.end, state.doc.lines - 1) + 1);
						if (tail.to <= head.to) continue;
						decos.push(Decoration.replace({
							widget: new CollapsedMarker(it.descCount, plugin.keyOf(file, it)),
						}).range(head.to, tail.to));
					}
				}
				// 三、展开着的项：鼠标划到那一行时行尾冒出来的折叠按钮
				if (plugin.settings.hoverHandle) {
					for (const it of items) {
						if (!it.childCount || ancestorFolded(it)) continue;
						const head = state.doc.line(it.line + 1);
						if (plugin.foldAt(state, head.from, head.to + 1)) continue;
						decos.push(Decoration.widget({
							widget: new HoverHandle(it.descCount, plugin.keyOf(file, it)),
							side: 1,
						}).range(head.to));
					}
				}
			}

			return decos.length ? Decoration.set(decos, true) : Decoration.none;
		};

		return [
			StateField.define({
				create: build,
				update: (val, tr) => (tr.docChanged || tr.effects.some((e) => e.is(refresh)) ? build(tr.state) : val),
				provide: (f) => EditorView.decorations.from(f),
			}),
			...this.foldSyncExtension(),
		];
	}

	// ------------------------------------------------------------ 跟 Obsidian 自带折叠互相通气

	// 双向：文件里的标记 → 折起来；你按 ⌥S（或点行首箭头）折 / 展开 → 写进文件。
	// 所以日常根本不用碰这个插件的按钮，怎么折叠都记得住
	foldSyncExtension() {
		const plugin = this;
		if (!HAS_FOLD) return [];
		return [ViewPlugin.fromClass(class {
			constructor(view) { this.busy = false; this.soon(view); }
			update(u) {
				// 你手动折的 / 展开的：记进文件。插件自己发的那一次带 lfFx 标记，跳过
				for (const tr of u.transactions) {
					if (tr.effects.some((e) => e.is(plugin.lfFx))) continue;
					for (const e of tr.effects) {
						if (e.is(foldEffect)) plugin.noteFold(u.view, e.value, true);
						else if (e.is(unfoldEffect)) plugin.noteFold(u.view, e.value, false);
					}
				}
				// 折叠自己没了（比如光标挪到折着的那一行的行尾，Obsidian 会顺手把它展开）：跟着删标记。
				// 只在正文没变的时候看 —— 打字会让折叠的位置整体平移，那不是「没了」
				const before = u.startState.field(foldState, false);
				const after = u.state.field(foldState, false);
				const mine = u.transactions.some((tr) => tr.effects.some((e) => e.is(plugin.lfFx)));
				if (!u.docChanged && !mine && before && after && before !== after) {
					before.between(0, u.state.doc.length, (f, t) => {
						let still = false;
						after.between(f, Math.max(t, f + 1), (a, b) => { if (a === f && b === t) still = true; });
						if (!still) plugin.noteFold(u.view, { from: f, to: t }, false);
					});
				}
				this.soon(u.view);
			}
			soon(view) {
				if (this.busy) return;
				this.busy = true;
				setTimeout(() => { this.busy = false; plugin.applyFolds(view); }, 0);
			}
		})];
	}

	// 这一行上有没有一个折叠（有就返回它的范围）
	foldAt(state, from, to) {
		if (!HAS_FOLD) return null;
		let hit = null;
		foldedRanges(state).between(from, Math.max(to, from + 1), (f, t) => { if (!hit) hit = { from: f, to: t }; });
		return hit;
	}

	// 按文件里的标记，把该折的折上、该展开的展开
	applyFolds(view) {
		if (!HAS_FOLD || !view.dom || !view.dom.isConnected) return;
		const state = view.state;
		const file = state.field(editorInfoField, false)?.file;
		if (!file) return;
		const wantFold = !!state.field(editorLivePreviewField, false) || this.settings.sourceFold;
		const doc = state.doc;
		const items = this.doc(file, doc.toString()).items;
		const effects = [];
		for (const it of items) {
			if (!it.childCount || ancestorFolded(it)) continue;
			const head = doc.line(it.line + 1);
			const tail = doc.line(Math.min(it.end, doc.lines - 1) + 1);
			if (tail.to <= head.to) continue;
			const got = this.foldAt(state, head.from, head.to + 1);
			if (it.folded && wantFold && !got) effects.push(foldEffect.of({ from: head.to, to: tail.to }));
			else if ((!it.folded || !wantFold) && got) effects.push(unfoldEffect.of({ from: got.from, to: got.to }));
		}
		if (!effects.length) return;
		if (!state.field(foldState, false) && codeFolding) effects.push(StateEffect.appendConfig.of(codeFolding()));
		view.dispatch({ effects: effects.concat(this.lfFx.of(null)) });
	}

	// 你手动折 / 展开了：把这一项对应的标记行写上或删掉
	noteFold(view, range, wantFold) {
		const state = view.state;
		const file = state.field(editorInfoField, false)?.file;
		if (!file) return;
		const doc = state.doc;
		if (range.from > doc.length) return;
		const lineNo = doc.lineAt(range.from).number - 1;
		const it = this.doc(file, doc.toString()).items.find((x) => x.line === lineNo && x.childCount > 0);
		if (!it || it.folded === wantFold) return;
		this.flipItems([it], wantFold, { file, cm: view, text: doc.toString() });
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

	// 哪些标记行已经跟着母项一起被替换掉了：那几行不用再单独藏一次，否则两条装饰叠在同一个地方
	const covered = new Set();
	for (const it of items) if (it.folded && !ancestorFolded(it)) covered.add(it.line + 1);

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

	return { items, attrLines, covered, unit: unit || TAB_SIZE, useTab };
}

// 往上有没有任何一个祖先是折叠着的（有就轮不到这一项自己出装饰）
function ancestorFolded(it) {
	let p = it.parent;
	while (p) {
		if (p.folded) return true;
		p = p.parent;
	}
	return false;
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
	const has = ATTR_RE.test(lines[line + 1] || "");
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
