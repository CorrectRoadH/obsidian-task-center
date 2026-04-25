# BUG: Plugin freezes Obsidian on large vaults

## Symptom

Enabling Task Center on a real vault (`~/LifeSystem`, ~6589 md files) freezes Obsidian — even when the Task Board view is never opened. Small dev vaults (<100 files) don't show the issue, which is why this was missed.

## Root cause

Every event triggers a full vault rescan with no caching. On a large vault, events fire continuously during startup indexing, and the rescans chain through the main thread.

## Problem chain

### 1. `parseVaultTasks()` rescans the whole vault every call (no cache)

`src/parser.ts:238-256` — `app.vault.getMarkdownFiles()` returns all 6589 files, then for each file with `listItems` (daily notes almost all qualify) runs `cachedRead` + ancestor-chain walk + several regexes. Serial `await` per file. No memoization across calls.

### 2. Every API entry point starts with a full rescan

`src/cli.ts:45-190` — `list / show / stats / schedule / deadline / actual / estimate / done / undone / drop / add / rename / tag / nest` all begin with `await this.allTasks()`. Toggling one checkbox re-parses the entire vault just to resolve a `path:Lnnn` ref.

### 3. Double event subscription → event flood

- `src/main.ts:89-98` subscribes to vault `modify / create / delete / rename` + `metadataCache.on("resolved")` to drive the **status bar**.
- `src/view.ts:128-139` subscribes to **the same events again** to drive the view.
- `metadataCache.on("resolved")` fires repeatedly while Obsidian's batch metadata indexer runs on startup for a large vault.
- Each fire schedules a 400ms / 500ms debounce → eventually fires a full rescan → during the seconds-long rescan more events arrive → next rescan queued → loop never quiets.

### 4. Status bar is always active — freezes even without opening the view

`src/main.ts:85-98` wires the status bar on `onload`, independent of whether the user ever opens Task Board. `refreshStatusBar()` calls `this.api.allTasks()`. So simply *having the plugin enabled* triggers full scans on every metadata resolve. This is the "freezes on launch without touching anything" behavior.

### 5. View render is O(tasks) per render

`src/view.ts:311-317` — `renderTabBar` filters the full task list four times (week / month / completed / unscheduled) on every render. Render runs on every user interaction. Not the primary freeze cause but amplifies it once the view is open.

## Why small vaults hide this

A dev fixture of ~50 notes completes `parseVaultTasks` in <50ms and `metadataCache.resolved` fires once or twice. Everything feels snappy. Only at 1000+ task-bearing files with Obsidian's staged indexing does the event flood + serial scan start thrashing the main thread.

## Fix directions (ROI-ordered)

1. **Stop always-on status bar scans.** Drop `metadataCache.on("resolved")`; switch to `metadataCache.on("changed", file => …)` and invalidate only the affected file. Or defer status bar work entirely until the view is opened at least once.
2. **Cache parsed tasks per-file.** `Map<path, { mtime, tasks: ParsedTask[] }>`. File events invalidate one entry. `allTasks()` returns the flattened cache.
3. **Single-file resolve for writes.** `resolveTaskRef` for `path:Lnnn` or `hash` can parse one file (or only task-bearing files for hash) instead of the whole vault.
4. **Deduplicate event subscriptions.** Plugin owns the data + events; view subscribes to a plugin-level change event instead of re-registering vault/metadata listeners.
5. **Memoize tab counts.** Compute once per `reloadTasks`, not per `render`.

## Repro

- Vault: `~/LifeSystem` (~6589 md files, many daily notes with task bullets).
- Steps: enable `obsidian-task-center` in community plugins.
- Expected: Obsidian stays responsive whether or not Task Board is opened.
- Actual: main thread stalls; UI unresponsive for many seconds, then re-freezes as more `metadataCache.resolved` batches arrive.

## Current workaround

Disabled — removed from `~/LifeSystem/.obsidian/community-plugins.json` on 2026-04-24.
