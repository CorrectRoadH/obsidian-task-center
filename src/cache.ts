// Task cache — single source of truth for parsed tasks.
//
// All `parseVaultTasks` / `parseFileTasks` calls flow through here. Status bar,
// board view, and CLI all read `flatten()` / `resolveRef()` instead of
// re-walking the vault per request. Vault + metadataCache events fan in here
// (`metadataCache.on("changed", file)`) and fan out through `on("changed")`.
//
// The architecture forbids any other module from subscribing to
// `metadataCache.on("resolved")` — it triggers a vault-wide flood on large
// vaults and was the root cause of BUG.md.

import { App, EventRef, TFile } from "obsidian";
import { ParsedTask } from "./types";
import { parseFileTasks } from "./parser";
import { TaskWriterError, parseTaskId } from "./writer";

// Re-exported so cache.test.mjs can construct TFile instances that pass the
// bundle's `instanceof TFile` checks. esbuild's `--alias:obsidian=...` makes
// this resolve to the same class the bundle uses internally; using a fresh
// `import { TFile } from "obsidian-stub"` in the test would yield a *sibling*
// class and `instanceof` would silently fail.
export { TFile } from "obsidian";

export interface FileEntry {
  mtime: number;
  tasks: ParsedTask[];
  hasTaskListItem: boolean;
}

type ChangedListener = (paths: Set<string>) => void;

export class TaskCache {
  private readonly byPath = new Map<string, FileEntry>();
  private readonly byHash = new Map<string, ParsedTask[]>();
  private readonly pending = new Map<string, Promise<FileEntry | null>>();
  private readonly listeners = new Set<ChangedListener>();
  private allLoaded = false;
  private allLoadingPromise: Promise<ParsedTask[]> | null = null;

  // Test / perf hooks (always live; documented in ARCHITECTURE.md §8.5).
  readonly __stats = {
    ensureCount: 0,
    parseCount: 0,
    skipCount: 0,
    parseErrCount: 0,
    invalidateCount: 0,
  };

  constructor(private readonly app: App) {}

  /**
   * Returns the EventRefs the caller (Plugin) should `registerEvent()` so
   * cleanup happens in `onunload`.
   *
   * Subscribes to:
   *   - `metadataCache.on("changed", file)` — single-file invalidation.
   *     This fires once per file as Obsidian indexes it (including during
   *     startup), AND on every subsequent edit. We do NOT subscribe to
   *     `metadataCache.on("resolved")` (BUG.md #3 / ARCHITECTURE.md §3.1).
   *   - `vault.on("delete" | "rename")` — keep `byPath` in sync.
   */
  bind(): EventRef[] {
    const refs: EventRef[] = [];
    refs.push(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          void this.invalidateFile(file.path);
        }
      }),
    );
    refs.push(
      this.app.vault.on("delete", (f) => {
        if (f instanceof TFile && f.extension === "md") {
          this.dropPath(f.path);
        }
      }),
    );
    refs.push(
      this.app.vault.on("rename", (f, oldPath) => {
        if (f instanceof TFile && f.extension === "md") {
          this.renamePath(oldPath, f.path);
        }
      }),
    );
    return refs;
  }

  on(_event: "changed", cb: ChangedListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(paths: Set<string>): void {
    for (const cb of this.listeners) {
      try {
        cb(paths);
      } catch (e) {
        console.warn("[task-center] cache listener error:", e);
      }
    }
  }

  /**
   * Schedule a single-file re-parse. Returns a Promise that resolves once the
   * new entry is committed to `byPath` and `cache.changed` has fired.
   *
   * Multiple calls before the first finishes share the same in-flight Promise
   * (debounce). The architecture guarantees that any subscriber receiving a
   * `changed` event can synchronously read the freshly parsed `flatten()`.
   */
  invalidateFile(path: string): Promise<FileEntry | null> {
    this.__stats.invalidateCount++;
    const inFlight = this.pending.get(path);
    if (inFlight) return inFlight;
    const p = this.reparse(path).finally(() => this.pending.delete(path));
    this.pending.set(path, p);
    return p;
  }

  private async reparse(path: string): Promise<FileEntry | null> {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!af || !(af instanceof TFile) || af.extension !== "md") {
      this.dropPath(path);
      return null;
    }
    const meta = this.app.metadataCache.getFileCache(af);
    const hasTaskListItem =
      meta !== null
        ? (meta.listItems?.some((li) => li.task !== undefined) ?? false)
        : true; // metadata not yet indexed — must parse to be safe (BUG.md #1)
    if (meta !== null && !hasTaskListItem) {
      this.replaceEntry(path, {
        mtime: af.stat.mtime,
        tasks: [],
        hasTaskListItem: false,
      });
      this.__stats.skipCount++;
      this.emit(new Set([path]));
      return this.byPath.get(path) ?? null;
    }
    let tasks: ParsedTask[];
    try {
      tasks = await parseFileTasks(this.app, af);
      this.__stats.parseCount++;
    } catch (e) {
      console.warn(`[task-center] cache: parseFileTasks failed for ${path}:`, e);
      this.__stats.parseErrCount++;
      return null;
    }
    this.replaceEntry(path, {
      mtime: af.stat.mtime,
      tasks,
      hasTaskListItem: tasks.length > 0,
    });
    this.emit(new Set([path]));
    return this.byPath.get(path) ?? null;
  }

  private replaceEntry(path: string, next: FileEntry): void {
    const prev = this.byPath.get(path);
    if (prev) {
      for (const t of prev.tasks) this.removeFromHash(t);
    }
    this.byPath.set(path, next);
    for (const t of next.tasks) this.addToHash(t);
  }

  private dropPath(path: string): void {
    const prev = this.byPath.get(path);
    if (!prev) return;
    for (const t of prev.tasks) this.removeFromHash(t);
    this.byPath.delete(path);
    this.emit(new Set([path]));
  }

  private renamePath(oldPath: string, newPath: string): void {
    const prev = this.byPath.get(oldPath);
    if (!prev) return;
    // Remap path on cached tasks rather than reparsing — file bytes haven't
    // changed; only the path identifier did. metadataCache.changed will fire
    // for the renamed file shortly and re-parse will pick up the new id.
    for (const t of prev.tasks) this.removeFromHash(t);
    const remapped: ParsedTask[] = prev.tasks.map((t) => ({
      ...t,
      path: newPath,
      id: `${newPath}:L${t.line + 1}`,
    }));
    this.byPath.delete(oldPath);
    this.byPath.set(newPath, { ...prev, tasks: remapped });
    for (const t of remapped) this.addToHash(t);
    this.emit(new Set([oldPath, newPath]));
  }

  private addToHash(t: ParsedTask): void {
    const list = this.byHash.get(t.hash);
    if (list) list.push(t);
    else this.byHash.set(t.hash, [t]);
  }

  private removeFromHash(t: ParsedTask): void {
    const list = this.byHash.get(t.hash);
    if (!list) return;
    const idx = list.indexOf(t);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.byHash.delete(t.hash);
  }

  /**
   * Force the named file's entry to be present and up-to-date. Used by CLI
   * write verbs that just need ONE file (BUG.md #2: writes must not rescan
   * the whole vault).
   */
  async ensureFile(path: string): Promise<FileEntry | null> {
    const inFlight = this.pending.get(path);
    if (inFlight) return inFlight;
    const cached = this.byPath.get(path);
    if (cached) return cached;
    return this.invalidateFile(path);
  }

  /**
   * Lazy whole-vault prime. The view triggers this once on first open;
   * `list` / `stats` / `show`-by-hash also need it. Subsequent calls are
   * cache-hit and synchronous-fast.
   *
   * Only files where `metadataCache` confirms `listItems[].task !== undefined`
   * are parsed (BUG.md root cause: a 6589-file vault parsed serially froze
   * the main thread). Files where metadata is not yet indexed are parsed
   * (we cannot prove no-task without bytes) — this is the eventual-consistency
   * guarantee from `metadataCache.changed`.
   */
  ensureAll(): Promise<ParsedTask[]> {
    if (this.allLoaded) return Promise.resolve(this.flatten());
    if (this.allLoadingPromise) return this.allLoadingPromise;
    this.allLoadingPromise = this.loadAll().finally(() => {
      this.allLoadingPromise = null;
    });
    return this.allLoadingPromise;
  }

  private async loadAll(): Promise<ParsedTask[]> {
    this.__stats.ensureCount++;
    const files = this.app.vault.getMarkdownFiles();
    const candidates: TFile[] = [];
    for (const f of files) {
      const meta = this.app.metadataCache.getFileCache(f);
      const hasTask =
        meta !== null
          ? (meta.listItems?.some((li) => li.task !== undefined) ?? false)
          : true; // metadata not indexed → cannot prove empty, must parse
      if (meta !== null && !hasTask) {
        // Confirmed no-task file. Cache an empty entry so renames/deletes are
        // tracked, but don't touch disk.
        if (!this.byPath.has(f.path)) {
          this.byPath.set(f.path, {
            mtime: f.stat.mtime,
            tasks: [],
            hasTaskListItem: false,
          });
        }
        this.__stats.skipCount++;
        continue;
      }
      candidates.push(f);
    }

    const updated = new Set<string>();
    await mapLimit(candidates, 32, async (f) => {
      try {
        const tasks = await parseFileTasks(this.app, f);
        this.replaceEntry(f.path, {
          mtime: f.stat.mtime,
          tasks,
          hasTaskListItem: tasks.length > 0,
        });
        updated.add(f.path);
        this.__stats.parseCount++;
      } catch (e) {
        console.warn(`[task-center] cache: parseFileTasks failed for ${f.path}:`, e);
        this.__stats.parseErrCount++;
      }
    });
    this.allLoaded = true;
    if (updated.size > 0) this.emit(updated);
    return this.flatten();
  }

  flatten(): ParsedTask[] {
    const out: ParsedTask[] = [];
    const paths = Array.from(this.byPath.keys()).sort();
    for (const p of paths) {
      const e = this.byPath.get(p);
      if (e) out.push(...e.tasks);
    }
    return out;
  }

  get(path: string): FileEntry | undefined {
    return this.byPath.get(path);
  }

  /**
   * Resolve a CLI / API ref to a single ParsedTask without scanning the whole
   * vault. `path:Lnnn` resolves via `ensureFile`; bare hash falls back to
   * `ensureAll` only when not already in `byHash`.
   *
   * Throws `TaskWriterError("ambiguous_slug")` for hash collisions and
   * `TaskWriterError("task_not_found")` when the path:line target is gone.
   *
   * US-208: when `path:Lnnn` no longer points at the original task (file
   * shifted), the title-hash fallback in `parseTaskId` keeps the ref
   * resolvable so callers don't need to chase line drift themselves.
   * see USER_STORIES.md
   */
  async resolveRef(id: string): Promise<ParsedTask | null> {
    const parsed = parseTaskId(id);
    if (parsed.path && parsed.line !== undefined) {
      const entry = await this.ensureFile(parsed.path);
      if (!entry) {
        throw new TaskWriterError(
          "task_not_found",
          `file not found: ${parsed.path}`,
        );
      }
      const t = entry.tasks.find((task) => task.line === parsed.line);
      if (t) return t;
      throw new TaskWriterError(
        "task_not_found",
        `${parsed.path}:L${(parsed.line ?? 0) + 1} is not a task line. Use \`task-center list\` to find valid refs.`,
      );
    }
    if (parsed.hash) {
      let matches = this.byHash.get(parsed.hash);
      if (!matches || matches.length === 0) {
        await this.ensureAll();
        matches = this.byHash.get(parsed.hash);
      }
      if (!matches || matches.length === 0) return null;
      if (matches.length > 1) {
        throw new TaskWriterError(
          "ambiguous_slug",
          `hash ${parsed.hash} matches ${matches.length} tasks: ${matches.map((t) => t.id).join(", ")}`,
        );
      }
      return matches[0];
    }
    return null;
  }

  /**
   * Wait for all in-flight reparses + the in-flight ensureAll to settle.
   * Used by `plugin.__forFlush()` so e2e tests can advance deterministically
   * without polling DOM (ARCHITECTURE.md §8.5).
   */
  async forFlush(): Promise<void> {
    // Loop because listeners may schedule new reparses synchronously.
    while (this.pending.size > 0 || this.allLoadingPromise !== null) {
      const promises: Promise<unknown>[] = Array.from(this.pending.values());
      if (this.allLoadingPromise) promises.push(this.allLoadingPromise);
      await Promise.all(promises);
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.byPath.clear();
    this.byHash.clear();
    this.pending.clear();
    this.allLoaded = false;
    this.allLoadingPromise = null;
  }
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  };
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
}
