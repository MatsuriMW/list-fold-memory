# List Fold Memory（列表折叠记忆）

> **Your lists stay folded the way you left them.**

An Obsidian plugin that remembers how each list item was collapsed, by writing one comment line into the note instead of keeping the state somewhere outside it.

**English** · [简体中文](./README.zh-CN.md)

## What it does

Fold something in a list, close the note, come back tomorrow — it is still folded.

```markdown
- 周会纪要
	%% collapsed:: true %%
	- 数据源整理
	- 口径核对
- 待办
	- 还没折叠的项
```

The marker sits one indent level in, right under the item it belongs to — the same place Logseq puts a `collapsed:: true` block property. It is written with Obsidian's own comment syntax, `%% … %%`, and the plugin hides those lines **everywhere you look**:

- **Reading view** — Obsidian does not render comments, so nothing is there to begin with.
- **Live Preview and Source mode** — the plugin deletes the line from the view, newline and all. It is not dimmed or squeezed; it is gone, and the cursor treats the spot as one atomic step, so you cannot land inside it while typing.

Nothing else about your note changes.

## How it folds

The folding itself is not drawn by this plugin — it calls the same CodeMirror fold that ⌥S uses. What you get is Obsidian's own: the arrow at the left of the line, the `…` at the end of it, the same click to unfold. Nothing about the fold looks foreign.

Marker and fold are kept in sync in both directions:

- A marker in the file folds that item when the note opens, and again whenever another plugin or a sync rewrites the file and the fold gets lost. This direction only ever folds; it never unfolds something for you.
- Fold something yourself — ⌥S, the arrow at the left, whatever you already use — and the marker is written for you. Unfold it and the marker is removed. Typing and rewrites of the file don't count as folding, and folds that are off screen are read from the editor's state, not from what happens to be drawn.
- Another plugin that folds on its own (say, to collapse a "done" section) can wrap that in `app.plugins.plugins["list-fold-memory"].quietly(() => …)`, and those folds are not recorded as yours.

So the plugin's own button is optional. Fold the way you already do, and the state is kept anyway.

## Why the state lives in the file

The obvious design is a JSON file in the plugin folder, with each list item identified by its line number or by a hash of its text. Both fall apart on a note that something else keeps rewriting:

- Line numbers shift the moment anything is inserted above, which is exactly what an agent appending to a daily journal does.
- Text hashes break when the wording changes, even slightly.

A line written into the note has neither problem. It travels with its own content through git, sync, export and any rewrite that keeps the block itself — which is why this is worth having even though it touches your text.

## Commands

| Command | What it does |
|---|---|
| 折叠 / 展开光标所在的列表项 | Toggle the item the cursor is on (an item without children cannot be folded) |
| 折叠本文所有列表项 | Fold every list item in the note at once |
| 展开本文所有列表项 | Unfold everything |
| 只折叠顶层的列表项 | Fold only the outermost items, leaving inner levels as they are |
| 清除本文所有折叠标记 | Delete every marker in the note — back to text as it was before the plugin existed |
| 临时露出折叠标记 | Show the marker lines as plain text, for checking what is actually in the file. Run again to hide them |

Bind any of them to a hotkey in **Settings → Hotkeys**.

## Settings

| Setting | Default | What it does |
|---|---|---|
| 鼠标划过时显示折叠按钮 | On | An item that is unfolded grows a small collapse button at the end of its line while the mouse is over it. Nothing shows otherwise |
| 折叠按钮上显示后代条数 | On | Show `⌄ 3` instead of just `⌄`, counting everything inside. The `…` shown once folded is Obsidian's own and cannot be changed |
| 阅读视图也折叠 | On | Honour the markers in Reading view, with a clickable marker to unfold |
| 源码模式下也折叠 | Off | Source mode hides the marker either way; turn this on to fold the list there too |
| 临时露出折叠标记 | Off | Show the marker lines as plain text for checking. Same as the command |

## Cleaning up

Everything the plugin writes is one line per folded item, always matching `%% collapsed:: true %%`. Two ways out:

- The **清除本文所有折叠标记** command removes them from the open note.
- Any text editor or search-and-replace pass can strip them: they are ordinary lines, they carry no IDs, and removing them loses nothing but the fold state itself.

## Installing

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/list-fold-memory/`, reload Obsidian, and enable **List Fold Memory** in **Settings → Community plugins**. Or add it through [BRAT](https://github.com/TfTHacker/obsidian42-brat) from `MatsuriMW/list-fold-memory`.

## Notes and limits

- Markers survive any tool that keeps the block they belong to. A rewrite that deletes or re-words the block itself loses its fold state, which is unavoidable.
- Outside Obsidian — exporting to plain Markdown, opening the file in another editor — `%% … %%` is Obsidian-specific syntax and will show up as text. Run the clear command first if that matters.
- Code blocks, callouts, ordered lists and checklists are all handled. Lists inside tables are not folded.
- Markers are matched by the item's own text fingerprint within its nesting level, so two identical items at the same depth in one note share a fold state.
- The plugin only ever writes its own marker lines; nothing else in a note is modified.
