import { App } from "obsidian";
import { ParsedTask, TaskStatus } from "./types";
import { formatMinutes } from "./parser";
import {
  setScheduled,
  setDeadline,
  setActual,
  setEstimate,
  markDone,
  markUndone,
  markDropped,
  addTask,
  addTag,
  removeTag,
  addToActual,
  renameTask,
  nestUnder,
  TaskWriterError,
} from "./writer";
import { TaskCache } from "./cache";
import { todayISO, resolveWhen, isValidISO } from "./dates";
import { t as tr } from "./i18n";

// REMINDER: this module must NOT call `parseVaultTasks` or
// `app.vault.getMarkdownFiles()` directly. All parse work goes through
// `TaskCache`. Write verbs resolve refs via `cache.resolveRef`, which is
// single-file for `path:Lnnn`. (ARCHITECTURE.md §3.3 / §5.1, BUG.md #2)

export interface ListFilters {
  scheduled?: string;
  done?: string;
  overdue?: boolean;
  hasDeadline?: boolean;
  status?: "todo" | "done" | "dropped";
  tag?: string[];
  parent?: string;
  search?: string;
  limit?: number;
}

export interface StatsOpts {
  days?: number;
  group?: string;
  from?: string;
  to?: string;
}

export class TaskCenterApi {
  constructor(private readonly app: App, private readonly cache: TaskCache) {}

  /**
   * Whole-vault snapshot. Used by `list` / `stats` / formatters that need the
   * full set; cache primes once per session and subsequent calls are O(1).
   * Write verbs MUST NOT call this — they go through `cache.resolveRef`.
   */
  async allTasks(): Promise<ParsedTask[]> {
    return this.cache.ensureAll();
  }

  async list(filters: ListFilters): Promise<ParsedTask[]> {
    const all = await this.cache.ensureAll();
    return filterTasks(all, filters);
  }

  async show(id: string): Promise<ParsedTask> {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("task_not_found", `no task matches ${id}`);
    return task;
  }

  async stats(opts: StatsOpts = {}): Promise<StatsResult> {
    const all = await this.cache.ensureAll();
    return computeStats(all, opts);
  }

  async schedule(id: string, date: string | null) {
    if (date !== null && !isValidISO(date)) {
      throw new TaskWriterError("invalid_date", `not ISO YYYY-MM-DD: ${date}`);
    }
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("task_not_found", id);
    return await setScheduled(this.app, task, date);
  }

  async deadline(id: string, date: string | null) {
    if (date !== null && !isValidISO(date)) {
      throw new TaskWriterError("invalid_date", `not ISO YYYY-MM-DD: ${date}`);
    }
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("task_not_found", id);
    return await setDeadline(this.app, task, date);
  }

  async actual(id: string, minutes: number, mode: "set" | "add" = "set") {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("task_not_found", id);
    return mode === "add"
      ? await addToActual(this.app, task, minutes)
      : await setActual(this.app, task, minutes);
  }

  async estimate(id: string, minutes: number | null) {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("task_not_found", id);
    return await setEstimate(this.app, task, minutes);
  }

  async done(id: string, at: string | null = null, cascade = true) {
    if (at && !isValidISO(at)) {
      throw new TaskWriterError("invalid_date", `--at requires YYYY-MM-DD: ${at}`);
    }
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("task_not_found", id);
    // US-145: completing a parent cascades to its `todo` descendants. Tasks
    // that are already `[x] / [-] / [>]` are left alone — overwriting their
    // recorded ✅ / ❌ / 🛫 dates would destroy history. Cross-file parent /
    // child relationships are not modelled (ARCHITECTURE §1.4), so we walk
    // only this file's tasks.
    const fileTasks = this.cache.get(task.path)?.tasks ?? [task];
    const descendants = cascade
      ? collectDescendants(task, fileTasks).filter((t) => t.status === "todo")
      : [];
    const targets = [task, ...descendants];
    // Bottom-up so line numbers stay stable across each mutation.
    targets.sort((a, b) => b.line - a.line);
    let lastResult = await markDone(this.app, targets[0], at);
    for (let i = 1; i < targets.length; i++) {
      lastResult = await markDone(this.app, targets[i], at);
    }
    return lastResult;
  }

  async undone(id: string) {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("task_not_found", id);
    return await markUndone(this.app, task);
  }

  // US-124: dropping a parent cascades to its `todo` descendants — already
  // completed children are preserved so history isn't overwritten with `[-]`.
  // see USER_STORIES.md
  async drop(id: string, cascade = true) {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("task_not_found", id);
    // Cascade only to descendants that are still `todo` — don't overwrite a
    // done `[x] ✅ …` with a dropped `[-] ❌ …`; that would destroy history.
    // Cross-file parent/child relationships are not modelled (ARCHITECTURE
    // §1.4) so we only need this file's tasks.
    const fileTasks = this.cache.get(task.path)?.tasks ?? [task];
    const descendants = cascade
      ? collectDescendants(task, fileTasks).filter((t) => t.status === "todo")
      : [];
    const targets = [task, ...descendants];
    // Drop bottom-up so descending line numbers stay stable across each mutation
    targets.sort((a, b) => b.line - a.line);
    let lastResult = await markDropped(this.app, targets[0]);
    for (let i = 1; i < targets.length; i++) {
      lastResult = await markDropped(this.app, targets[i]);
    }
    return lastResult;
  }

  async add(opts: {
    text: string;
    to?: string;
    tag?: string[];
    scheduled?: string;
    deadline?: string;
    estimate?: number;
    parent?: string;
    stampCreated?: boolean;
    inboxFallback?: string;
  }) {
    let parent: ParsedTask | null = null;
    if (opts.parent) {
      parent = await this.cache.resolveRef(opts.parent);
      if (!parent) throw new TaskWriterError("task_not_found", `parent: ${opts.parent}`);
    }
    return await addTask(this.app, {
      text: opts.text,
      targetPath: opts.to,
      tags: opts.tag,
      scheduled: opts.scheduled ?? null,
      deadline: opts.deadline ?? null,
      estimate: opts.estimate ?? null,
      parent,
      stampCreated: opts.stampCreated,
      inboxFallback: opts.inboxFallback,
    });
  }

  async rename(id: string, newTitle: string) {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("task_not_found", id);
    return await renameTask(this.app, task, newTitle);
  }

  async tag(id: string, tag: string, remove = false) {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("task_not_found", id);
    return remove ? await removeTag(this.app, task, tag) : await addTag(this.app, task, tag);
  }

  async nest(childId: string, parentId: string) {
    const child = await this.cache.resolveRef(childId);
    if (!child) throw new TaskWriterError("task_not_found", `child: ${childId}`);
    const parent = await this.cache.resolveRef(parentId);
    if (!parent) throw new TaskWriterError("task_not_found", `parent: ${parentId}`);
    return await nestUnder(this.app, child, parent);
  }
}

function collectDescendants(task: ParsedTask, sameFileTasks: ParsedTask[]): ParsedTask[] {
  const out: ParsedTask[] = [];
  const queue: number[] = [...task.childrenLines];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const line = queue.shift()!;
    if (seen.has(line)) continue;
    seen.add(line);
    const child = sameFileTasks.find((t) => t.line === line);
    if (child) {
      out.push(child);
      queue.push(...child.childrenLines);
    }
  }
  return out;
}

export function filterTasks(all: ParsedTask[], filters: ListFilters): ParsedTask[] {
  let filtered = [...all];
  // By default, hide tasks whose ancestor is done / dropped. Only keep them
  // when the caller explicitly asks for inherited-terminal context (e.g. status=done
  // lookups) — the terminal status filter below overrides this where needed.
  if (!filters.status || filters.status === "todo") {
    filtered = filtered.filter((t) => !t.inheritsTerminal);
  }
  if (filters.scheduled) {
    const r = resolveWhen(filters.scheduled);
    if (r.unscheduled) {
      filtered = filtered.filter((t) => !t.scheduled && t.status === "todo");
    } else if (r.exact) {
      filtered = filtered.filter((t) => t.scheduled === r.exact);
    } else if (r.from && r.to) {
      filtered = filtered.filter(
        (t) => t.scheduled && t.scheduled >= r.from! && t.scheduled <= r.to!,
      );
    }
  }
  if (filters.done) {
    const r = resolveWhen(filters.done);
    if (r.exact) filtered = filtered.filter((t) => t.completed === r.exact);
    else if (r.from && r.to) {
      filtered = filtered.filter(
        (t) => t.completed && t.completed >= r.from! && t.completed <= r.to!,
      );
    }
  }
  if (filters.overdue) {
    const today = todayISO();
    filtered = filtered.filter(
      (t) => t.status === "todo" && t.deadline && t.deadline < today,
    );
  }
  if (filters.hasDeadline) filtered = filtered.filter((t) => !!t.deadline);
  if (filters.status) filtered = filtered.filter((t) => t.status === filters.status);
  if (filters.tag && filters.tag.length > 0) {
    filtered = filtered.filter((t) => {
      return filters.tag!.every((needle) => {
        const n = needle.startsWith("#") ? needle : "#" + needle;
        if (n.includes("*")) {
          const re = new RegExp(
            "^" + n.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
          );
          return t.tags.some((tag) => re.test(tag));
        }
        return t.tags.includes(n);
      });
    });
  }
  if (filters.parent) {
    // Children of the given parent (by id or hash)
    const parentRef = filters.parent;
    filtered = filtered.filter((t) => {
      if (t.parentLine === null) return false;
      const parentId = `${t.path}:L${t.parentLine + 1}`;
      return parentId === parentRef;
    });
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    filtered = filtered.filter((t) => t.title.toLowerCase().includes(q));
  }
  if (filters.limit && filters.limit > 0) {
    filtered = filtered.slice(0, filters.limit);
  }
  return filtered;
}

export interface StatsResult {
  periodFrom: string;
  periodTo: string;
  days: number;
  doneCount: number;
  sumActual: number;
  sumEstimate: number;
  ratio: number | null;
  perTaskMean: number | null;
  perTaskStd: number | null;
  withinBand: { count: number; total: number; pct: number };
  byTag: Array<{ tag: string; minutes: number; pct: number }>;
  byGroup?: { prefix: string; entries: Array<{ tag: string; minutes: number; pct: number }> };
}

export function computeStats(all: ParsedTask[], opts: StatsOpts): StatsResult {
  const today = todayISO();
  let from = opts.from ?? "";
  const to = opts.to ?? today;
  const days = opts.days ?? 7;
  if (!from) {
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1));
    from = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")}`;
  }

  const done = all.filter(
    (t) => t.status === "done" && t.completed && t.completed >= from && t.completed <= to,
  );

  const withEst = done.filter((t) => t.estimate && t.estimate > 0 && t.actual && t.actual > 0);
  const sumActual = done.reduce((s, t) => s + (t.actual ?? 0), 0);
  const sumEst = done.reduce((s, t) => s + (t.estimate ?? 0), 0);
  const ratio = sumEst > 0 ? sumActual / sumEst : null;
  const ratios = withEst.map((t) => (t.actual ?? 0) / (t.estimate ?? 1));
  const mean = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
  const std =
    mean !== null && ratios.length > 1
      ? Math.sqrt(ratios.reduce((s, r) => s + (r - mean) ** 2, 0) / ratios.length)
      : null;
  const band = ratios.filter((r) => r >= 0.8 && r <= 1.25);

  const tagMinutes = new Map<string, number>();
  for (const t of done) {
    const time = t.actual ?? t.estimate ?? 0;
    if (time <= 0) continue;
    for (const tag of t.tags) {
      tagMinutes.set(tag, (tagMinutes.get(tag) ?? 0) + time);
    }
  }
  const totalTimeForPct = Array.from(tagMinutes.values()).reduce((s, v) => s + v, 0) || 1;
  const byTag = Array.from(tagMinutes.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([tag, minutes]) => ({
      tag,
      minutes,
      pct: Math.round((minutes / totalTimeForPct) * 100),
    }));

  let byGroup: StatsResult["byGroup"];
  if (opts.group) {
    const prefix = opts.group;
    const entries = byTag.filter((e) => e.tag.includes(prefix));
    byGroup = { prefix, entries };
  }

  return {
    periodFrom: from,
    periodTo: to,
    days,
    doneCount: done.length,
    sumActual,
    sumEstimate: sumEst,
    ratio,
    perTaskMean: mean,
    perTaskStd: std,
    withinBand: {
      count: band.length,
      total: ratios.length,
      pct: ratios.length > 0 ? Math.round((band.length / ratios.length) * 100) : 0,
    },
    byTag,
    byGroup,
  };
}

// ---------- Formatters (human-readable) ----------

function statusCheckbox(s: TaskStatus): string {
  if (s === "done") return "[x]";
  if (s === "dropped") return "[-]";
  if (s === "in_progress") return "[/]";
  if (s === "cancelled") return "[>]";
  return "[ ]";
}

function extractQuadrant(tags: string[]): string {
  for (const tag of tags) {
    const m = tag.match(/^#([1-4])象限$/);
    if (m) return `#${m[1]}`;
  }
  return "  ";
}

function shortEst(mins: number | null): string {
  return mins ? formatMinutes(mins) : "—";
}

function formatTaskHeader(t: ParsedTask): string {
  return `${t.path}:L${t.line + 1}  ${statusCheckbox(t.status)}  ${extractQuadrant(t.tags)}  ${t.title}`;
}

function formatTaskMeta(t: ParsedTask, indent = "    "): string {
  const parts: string[] = [];
  if (t.scheduled) parts.push(`scheduled ${t.scheduled}`);
  if (t.deadline) parts.push(`deadline ${t.deadline}`);
  if (t.estimate) parts.push(`est ${shortEst(t.estimate)}`);
  if (t.actual) parts.push(`actual ${shortEst(t.actual)}`);
  if (t.completed) parts.push(`done ${t.completed}`);
  return indent + parts.join("  ");
}

export function formatList(tasks: ParsedTask[], header: string): string {
  const out: string[] = [];
  out.push(header);
  out.push("");
  // Build parent/children tree (per file)
  const byId = new Map<string, ParsedTask>();
  for (const t of tasks) byId.set(t.id, t);
  const rendered = new Set<string>();

  for (const t of tasks) {
    if (rendered.has(t.id)) continue;
    // Skip if parent is also in the list (it will render us)
    if (t.parentLine !== null) {
      const parentId = `${t.path}:L${t.parentLine + 1}`;
      if (byId.has(parentId)) continue;
    }
    renderTree(t, tasks, out, rendered, 0);
  }
  return out.join("\n");
}

function renderTree(
  t: ParsedTask,
  all: ParsedTask[],
  out: string[],
  rendered: Set<string>,
  depth: number,
) {
  rendered.add(t.id);
  if (depth === 0) {
    out.push(formatTaskHeader(t));
    if (hasMeta(t)) out.push(formatTaskMeta(t));
  } else {
    const prefix = "    ".repeat(depth - 1);
    out.push(`${prefix}├ L${t.line + 1}  ${statusCheckbox(t.status)}  ${t.title}   ${inlineMeta(t)}`);
  }
  const children = all.filter(
    (c) => c.path === t.path && c.parentLine === t.line,
  );
  for (const c of children) {
    renderTree(c, all, out, rendered, depth + 1);
  }
}

function hasMeta(t: ParsedTask): boolean {
  return !!(t.scheduled || t.deadline || t.estimate || t.actual || t.completed);
}

function inlineMeta(t: ParsedTask): string {
  const parts: string[] = [];
  if (t.estimate) parts.push(`est ${shortEst(t.estimate)}`);
  if (t.scheduled) parts.push(`⏳${t.scheduled}`);
  if (t.deadline) parts.push(`📅${t.deadline}`);
  return parts.join(" ");
}

export function formatShow(t: ParsedTask): string {
  const lines: string[] = [];
  lines.push(`${t.path}:L${t.line + 1}  (hash ${t.hash})`);
  lines.push(`${statusCheckbox(t.status)} ${extractQuadrant(t.tags)} ${t.title}`);
  lines.push(`    scheduled  ${t.scheduled ?? "—"}`);
  lines.push(`    deadline   ${t.deadline ?? "—"}`);
  lines.push(`    estimate   ${shortEst(t.estimate)}`);
  lines.push(`    actual     ${shortEst(t.actual)}`);
  lines.push(`    created    ${t.created ?? "—"}`);
  lines.push(`    completed  ${t.completed ?? "—"}`);
  lines.push(`    cancelled  ${t.cancelled ?? "—"}`);
  lines.push(`    parent     ${t.parentLine !== null ? `${t.path}:L${t.parentLine + 1}` : "—"}`);
  if (t.childrenLines.length > 0) {
    lines.push(
      `    children   ${t.childrenLines.map((l) => `${t.path}:L${l + 1}`).join(", ")}`,
    );
  } else {
    lines.push(`    children   —`);
  }
  const mt = new Date(t.mtime);
  lines.push(
    `    file_mtime ${mt.toISOString().replace(/\.\d+Z$/, "Z")}`,
  );
  lines.push(`    tags       ${t.tags.join(" ") || "—"}`);
  lines.push(`    raw        ${t.rawLine.trim()}`);
  return lines.join("\n");
}

function bar(pct: number, width = 14): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled);
}

export function formatStats(s: StatsResult): string {
  const lines: string[] = [];
  lines.push(`Period: ${s.periodFrom} → ${s.periodTo} (${s.days} days)`);
  lines.push(`Tasks done: ${s.doneCount}`);
  lines.push("");
  lines.push("Estimate accuracy");
  lines.push(`    sum actual    ${s.sumActual}m`);
  lines.push(`    sum estimate  ${s.sumEstimate}m`);
  if (s.ratio !== null) {
    const pct = Math.round((s.ratio - 1) * 100);
    const sign = pct >= 0 ? "+" : "";
    lines.push(`    ratio         ${s.ratio.toFixed(2)}        (${sign}${pct}%)`);
  } else {
    lines.push(`    ratio         —`);
  }
  if (s.perTaskMean !== null) lines.push(`    per-task mean ${s.perTaskMean.toFixed(2)}`);
  if (s.perTaskStd !== null) lines.push(`    per-task σ    ${s.perTaskStd.toFixed(2)}`);
  lines.push(
    `    within band   ${s.withinBand.count}/${s.withinBand.total} (${s.withinBand.pct}%)  target [0.8, 1.25]`,
  );
  lines.push("");
  lines.push("Top tags (minutes / %)");
  for (const row of s.byTag.slice(0, 12)) {
    lines.push(`    ${row.tag.padEnd(12)} ${String(row.minutes).padStart(4)}m  ${String(row.pct).padStart(2)}%  ${bar(row.pct)}`);
  }
  if (s.byGroup) {
    lines.push("");
    lines.push(`By ${s.byGroup.prefix} (minutes / %)`);
    for (const row of s.byGroup.entries) {
      lines.push(`    ${row.tag.padEnd(12)} ${String(row.minutes).padStart(4)}m  ${String(row.pct).padStart(2)}%  ${bar(row.pct)}`);
    }
  }
  return lines.join("\n");
}

// US-204: every CLI write verb returns `before / after` two-line diff so
// the caller can verify exactly what byte-level edit happened. Unchanged
// writes collapse the diff to a single `unchanged` note (US-203).
// see USER_STORIES.md
export function formatOkWrite(
  task: ParsedTask | null,
  path: string | null,
  line: number | null,
  before: string,
  after: string,
  unchanged: boolean,
  action: string,
  extraNote?: string,
): string {
  const ref = task ? task.id : path && line !== null ? `${path}:L${line + 1}` : "-";
  const title = task ? task.title : "";
  const label = extraNote ?? (unchanged ? "unchanged" : action);
  const out: string[] = [];
  out.push(`ok  ${ref}  ${title}`);
  if (unchanged) {
    out.push(`    ${label}`);
  } else {
    out.push(`    before  ${before.trim()}`);
    out.push(`    after   ${after.trim()}`);
  }
  return out.join("\n");
}

// US-211 + US-412: error format = English `code` (stable for grep / AI)
// + localized "一句人话". The English code stays English so scripts /
// agents can match `error task_not_found` regardless of locale; the
// human message routes through the i18n table when a key exists.
//
// Falls back to the raw `message` when the i18n table doesn't have a
// matching `err.<code>` entry — keeps unfamiliar codes loud rather than
// silently swallowing them.
export function formatError(code: string, message: string): string {
  const key = `err.${code}` as Parameters<typeof tr>[0];
  const localized = tr(key, { ref: message });
  // tr() returns the key string verbatim when it has no translation;
  // detect that and fall back to the raw message.
  const display = localized === key ? message : localized;
  return `error  ${code}\n    ${display}`;
}

export function formatAdd(result: { path: string; line: number; created: string }): string {
  return `ok  ${result.path}:L${result.line + 1}  created\n    ${result.created.trim()}`;
}
