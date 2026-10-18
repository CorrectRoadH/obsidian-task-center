// Task cache — single source of truth for parsed tasks.
//
// All `parseVaultTasks` / `parseFileTasks` calls flow through here. Status bar,
// board view, and CLI all read `flatten()` / `resolveRef()` instead of
// re-walking the vault per request. Vault + metadataCache events fan in here
// (`metadataCache.on("changed", file)`) and fan out through `on("changed")`.
//
// The architecture forbids any other module from subscribing to
// `metadataCache.on("resolved")` — it triggers a vault-wide flood on large
// vaults and was the root cause of large-vault regression.

import { App, EventRef, TFile } from "obsidian";
import { ParsedTask } from "./types";
import { parseFileTasks, parseTaskFromLine } from "./parser";
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
type MetadataCacheWithCachedFiles = App["metadataCache"] & {
  getCache?: (path: string) => { listItems?: Array<{ task?: string }> } | null;
  getCachedFiles?: () => string[];
};

export class TaskCache {
  private readonly byPath = new Map<string, FileEntry>();
  private readonly byHash = new Map<string, ParsedTask[]>();
  private readonly pending = new Map<string, Promise<FileEntry | null>>();
  private readonly listeners = new Set<ChangedListener>();
  private readonly knownMarkdownPaths = new Set<string>();
  // US-208 / VAL-CLI-004: persists "path:Lnn → hash" mappings from previous
  // cache entries so that stale path:line refs can recover by hash even after
  // the cache has been re-parsed and the old entry is gone.
  private readonly staleHashByRef = new Map<string, string>();
  private allLoaded = false;
  private allLoadingPromise: Promise<ParsedTask[]> | null = null;
  private _flatCache: ParsedTask[] | null = null;

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
   *     `metadataCache.on("resolved")` (#3 large-vault event-flood regression / ARCHITECTURE.md §3.1).
   *   - `vault.on("delete" | "rename")` — keep `byPath` in sync.
   */
  bind(): EventRef[] {
    const refs: EventRef[] = [];
    refs.push(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.knownMarkdownPaths.add(file.path);
          void this.invalidateFile(file.path);
        }
      }),
    );
    refs.push(
      this.app.vault.on("create", (f) => {
        if (f instanceof TFile && f.extension === "md") {
          this.knownMarkdownPaths.add(f.path);
          void this.invalidateFile(f.path);
        }
      }),
    );
    refs.push(
      this.app.vault.on("delete", (f) => {
        if (f instanceof TFile && f.extension === "md") {
          this.knownMarkdownPaths.delete(f.path);
          this.dropPath(f.path);
        }
      }),
    );
    refs.push(
      this.app.vault.on("rename", (f, oldPath) => {
        if (f instanceof TFile && f.extension === "md") {
          this.knownMarkdownPaths.delete(oldPath);
          this.knownMarkdownPaths.add(f.path);
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
    this.knownMarkdownPaths.add(path);
    const meta = this.app.metadataCache.getFileCache(af);
    const hasTaskListItem =
      meta !== null
        ? (meta.listItems?.some((li) => li.task !== undefined) ?? false)
        : true; // metadata not yet indexed — must parse to be safe (#1 large-vault regression)
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
      for (const t of prev.tasks) {
        this.removeFromHash(t);
        // Persist the old hash mapping for stale-ref recovery (US-208, VAL-CLI-004).
        const ref = `${t.path}:L${t.line + 1}`;
        if (!this.staleHashByRef.has(ref)) {
          this.staleHashByRef.set(ref, t.hash);
        }
      }
    }
    this.byPath.set(path, next);
    for (const t of next.tasks) this.addToHash(t);
    this._flatCache = null;
  }

  private dropPath(path: string): void {
    this.knownMarkdownPaths.delete(path);
    const prev = this.byPath.get(path);
    if (!prev) return;
    for (const t of prev.tasks) {
      this.removeFromHash(t);
      // Persist hash for stale-ref recovery even after file deletion.
      const ref = `${t.path}:L${t.line + 1}`;
      if (!this.staleHashByRef.has(ref)) this.staleHashByRef.set(ref, t.hash);
    }
    this.byPath.delete(path);
    this._flatCache = null;
    this.emit(new Set([path]));
  }

  private renamePath(oldPath: string, newPath: string): void {
    this.knownMarkdownPaths.delete(oldPath);
    this.knownMarkdownPaths.add(newPath);
    const prev = this.byPath.get(oldPath);
    if (!prev) return;
    // Remap path on cached tasks rather than reparsing — file bytes haven't
    // changed; only the path identifier did. metadataCache.changed will fire
    // for the renamed file shortly and re-parse will pick up the new id.
    for (const t of prev.tasks) {
      this.removeFromHash(t);
      // Persist old ref→hash for stale-ref recovery.
      const oldRef = `${t.path}:L${t.line + 1}`;
      if (!this.staleHashByRef.has(oldRef)) this.staleHashByRef.set(oldRef, t.hash);
    }
    const remapped: ParsedTask[] = prev.tasks.map((t) => ({
      ...t,
      path: newPath,
      id: `${newPath}:L${t.line + 1}`,
    }));
    this.byPath.delete(oldPath);
    this.byPath.set(newPath, { ...prev, tasks: remapped });
    for (const t of remapped) this.addToHash(t);
    this._flatCache = null;
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
   * write verbs that just need ONE file (#2 large-vault regression: writes must not rescan
   * the whole vault).
   */
  async ensureFile(path: string): Promise<FileEntry | null> {
    const inFlight = this.pending.get(path);
    if (inFlight) return inFlight;
    const cached = this.byPath.get(path);
    if (cached) {
      const af = this.app.vault.getAbstractFileByPath(path);
      if (af instanceof TFile && af.extension === "md" && cached.mtime === af.stat.mtime) {
        return cached;
      }
    }
    return this.invalidateFile(path);
  }

  /**
   * Lazy whole-vault prime. The view triggers this once on first open;
   * `list` / `stats` / `show`-by-hash also need it. Subsequent calls are
   * cache-hit and synchronous-fast.
   *
   * Only files where `metadataCache` confirms `listItems[].task !== undefined`
   * are parsed (large-vault regression root cause: a ~6500-file vault parsed serially froze
   * the main thread). Files where metadata is not yet indexed are parsed
   * (we cannot prove no-task without bytes) — this is the eventual-consistency
   * guarantee from `metadataCache.changed`.
   */
  ensureAll(): Promise<ParsedTask[]> {
    if (this.allLoadingPromise) return this.allLoadingPromise;
    if (this.allLoaded && !this.canRefreshFromMetadataIndex()) {
      return Promise.resolve(this.flatten());
    }
    this.allLoadingPromise = this.loadAll().finally(() => {
      this.allLoadingPromise = null;
    });
    return this.allLoadingPromise;
  }

  private canRefreshFromMetadataIndex(): boolean {
    const metadataCache = this.app.metadataCache as MetadataCacheWithCachedFiles;
    return typeof metadataCache.getCachedFiles === "function";
  }

  private async loadAll(): Promise<ParsedTask[]> {
    this.__stats.ensureCount++;
    const { files, skipped } = this.collectMarkdownFilesToPrime();
    this.__stats.skipCount += skipped;
    const candidates: TFile[] = [];
    // US-404: skip files whose metadataCache confirms zero task list items.
    // Big vaults (~6500-file regression in #1 large-vault regression) parse-flooded the
    // main thread; this cheap filter keeps board-open snappy. Files with
    // metadata not yet indexed must still be parsed (we cannot prove
    // empty without bytes), so the skip is conservative.
    // see USER_STORIES.md
    for (const f of files) {
      const cached = this.byPath.get(f.path);
      if (cached && cached.mtime === f.stat.mtime) {
        continue;
      }
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
          this._flatCache = null;
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

  private collectMarkdownFilesToPrime(): { files: TFile[]; skipped: number } {
    const paths = new Set(this.knownMarkdownPaths);
    const metadataCache = this.app.metadataCache as MetadataCacheWithCachedFiles;
    let skipped = 0;
    if (typeof metadataCache.getCachedFiles === "function") {
      for (const path of metadataCache.getCachedFiles()) {
        if (!path.endsWith(".md") || paths.has(path)) continue;
        const meta =
          typeof metadataCache.getCache === "function"
            ? metadataCache.getCache(path)
            : null;
        if (meta !== null) {
          const hasTask = meta.listItems?.some((li) => li.task !== undefined) ?? false;
          if (!hasTask) {
            skipped++;
            continue;
          }
        }
        paths.add(path);
      }
    }

    const files: TFile[] = [];
    for (const path of paths) {
      const af = this.app.vault.getAbstractFileByPath(path);
      if (af instanceof TFile && af.extension === "md") {
        this.knownMarkdownPaths.add(af.path);
        files.push(af);
      } else {
        this.knownMarkdownPaths.delete(path);
      }
    }
    return { files, skipped };
  }

  flatten(): ParsedTask[] {
    if (this._flatCache) return this._flatCache;
    const out: ParsedTask[] = [];
    const paths = Array.from(this.byPath.keys()).sort();
    for (const p of paths) {
      const e = this.byPath.get(p);
      if (e) out.push(...e.tasks);
    }
    this._flatCache = out;
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
   * `TaskWriterError("not_found")` when the path:line target is gone.
   *
   * US-208: when `path:Lnnn` no longer points at the original task (file
   * shifted), the title-hash fallback in `parseTaskId` keeps the ref
   * resolvable so callers don't need to chase line drift themselves.
   * see USER_STORIES.md
   */
  async resolveRef(id: string, issuedHashes?: ReadonlyMap<string, string>): Promise<ParsedTask | null> {
    const expectedHash = issuedHashes?.get(id);
    const parsed = parseTaskId(id);
    if (parsed.path && parsed.line !== undefined) {
      const entry = await this.ensureFile(parsed.path);
      if (!entry) {
        throw new TaskWriterError(
          "not_found",
          `file not found: ${parsed.path}`,
        );
      }
      const t = entry.tasks.find((task) => task.line === parsed.line);
      if (t) {
        // US-208 / VAL-CLI-004: identity check — if the line is now
        // occupied by a different task (staleHashByRef has a different
        // hash for this position), fall through to hash-based recovery
        // instead of silently returning the wrong task.
        const staleRef = `${parsed.path}:L${(parsed.line ?? 0) + 1}`;
        const originalHash = expectedHash ?? this.staleHashByRef.get(staleRef);
        if (!originalHash) {
          return t;
        }
        if (originalHash === t.hash) {
          // US-208 / VAL-CLI-004: same-hash identity guard.
          // When the stored hash matches the current line occupant but
          // multiple tasks share that hash, we must distinguish:
          //
          //   a) Non-stale: the task hasn't moved (just re-parsed).
          //      The exact current-line task is the correct resolution.
          //   b) Stale: a *different* same-hash task moved into this
          //      position while the original task moved elsewhere.
          //      We can't guess — must return ambiguous_slug.
          //
          // Distinguish by checking whether other staleHashByRef entries
          // with the same hash have mismatches at their current positions.
          // If any entry's current position no longer has a task with
          // this hash, the task distribution changed → stale collision.
          const candidates = this.byHash.get(originalHash);
          if (candidates && candidates.length > 1) {
            let distributionChanged = false;
            for (const [key, h] of expectedHash === undefined ? this.staleHashByRef : issuedHashes!) {
              if (h !== originalHash || key === staleRef) continue;
              // Only check entries from the same file.
              if (!key.startsWith(parsed.path + ":L")) continue;
              const keyLine =
                parseInt(key.slice(key.lastIndexOf(":L") + 2), 10) - 1;
              const keyTask = entry.tasks.find(
                (t2) => t2.line === keyLine,
              );
              if (!keyTask || keyTask.hash !== originalHash) {
                distributionChanged = true;
                break;
              }
            }
            if (distributionChanged) {
              throw new TaskWriterError(
                "ambiguous_slug",
                `hash ${originalHash} matches ${candidates.length} tasks: ${candidates.map((m) => m.id).join(", ")}`,
              );
            }
          }
          return t;
        }
        // Line is occupied by a different task — fall through.
      }

      // US-208 / VAL-CLI-004: stale path:Lnn ref — try hash-based recovery.
      // The staleHashByRef map persists old path:line → hash mappings from
      // previous cache entries, so even after the cache has been re-parsed
      // and the task moved, we can still find it by hash.
      const staleRef = `${parsed.path}:L${(parsed.line ?? 0) + 1}`;
      const fallbackHash = expectedHash ?? this.staleHashByRef.get(staleRef);
      if (fallbackHash) {
        await this.refreshHashCandidates(fallbackHash);
        let matches = this.byHash.get(fallbackHash);
        if (!matches || matches.length === 0) {
          await this.ensureAll();
          matches = this.byHash.get(fallbackHash);
        }
        if (matches && matches.length > 0) {
          if (matches.length > 1) {
            throw new TaskWriterError(
              "ambiguous_slug",
              `hash ${fallbackHash} matches ${matches.length} tasks: ${matches.map((m) => m.id).join(", ")}`,
            );
          }
          return matches[0];
        }
      }

      throw new TaskWriterError(
        "not_found",
        `${parsed.path}:L${(parsed.line ?? 0) + 1} is not a task line. Use \`task-center list\` to find valid refs.`,
      );
    }
    if (parsed.hash) {
      await this.refreshHashCandidates(parsed.hash);
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

  /** US-203/227: an intentional rename preserves previously issued refs. */
  recordRename(task: ParsedTask, after: string): string | undefined {
    const renamed = parseTaskFromLine(task.path, task.line, after, null, task.mtime);
    if (!renamed) return;
    for (const [ref, hash] of this.staleHashByRef) {
      if (hash === task.hash) this.staleHashByRef.set(ref, renamed.hash);
    }
    this.staleHashByRef.set(task.id, renamed.hash);
    return renamed.hash;
  }

  private async refreshHashCandidates(hash: string): Promise<void> {
    if (!this.byHash.has(hash)) await this.ensureAll();
    const paths = new Set((this.byHash.get(hash) ?? []).map(task => task.path));
    for (const path of paths) await this.ensureFile(path);
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
    this.staleHashByRef.clear();
    this.pending.clear();
    this._flatCache = null;
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
