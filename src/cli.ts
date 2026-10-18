import {
  ParsedTask,
  TaskStatus,
} from "./types";
import { t as tr } from "./i18n";
import { cliGroupingLabel, normalizeGroupingTags } from "./grouping";
import type { EffectiveTask } from "./task-tree";
import {
  buildAgentBrief,
  buildReviewSummary,
  computeStats,
  filterTasks,
  shortEst,
  TaskCenterApi,
  type AgentBriefResult,
  type QueryRunResult,
  type ReviewRangeSummary,
  type ReviewResult,
  type ReviewTask,
  type StatsResult,
} from "./api";

export {
  buildAgentBrief,
  buildReviewSummary,
  computeStats,
  filterTasks,
  TaskCenterApi,
};

// REMINDER: this module must NOT scan vault files directly. All parse work
// goes through `TaskCache`. Write verbs resolve refs via `cache.resolveRef`,
// which is single-file for `path:Lnnn`.
// (ARCHITECTURE.md §3.3 / §5.1, #2 large-vault regression)

// ---------- Formatters (human-readable) ----------

function statusCheckbox(s: TaskStatus): string {
  if (s === "done") return "[x]";
  if (s === "dropped") return "[-]";
  if (s === "in_progress") return "[/]";
  if (s === "cancelled") return "[>]";
  return "[ ]";
}

export interface CliFormatOptions {
  groupingTags?: string[];
}

function extractGrouping(tags: string[], opts: CliFormatOptions = {}): string {
  return cliGroupingLabel(tags, normalizeGroupingTags(opts.groupingTags));
}

// US-202: stable id (`path:Lnnn`) sits at column 0 of every list row so
// agents can `cut -d' ' -f1` to extract refs and pipe them straight back
// into write verbs. Status, quadrant, and title follow — all space-
// separated so awk-style field extraction stays trivial.
// see USER_STORIES.md
function formatTaskHeader(t: ParsedTask, opts: CliFormatOptions = {}): string {
  return `${t.path}:L${t.line + 1}  ${statusCheckbox(t.status)}  ${extractGrouping(t.tags, opts)}  ${t.title}`;
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

export function formatList(tasks: ParsedTask[], header: string, opts: CliFormatOptions = {}): string {
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
    renderTree(t, tasks, out, rendered, 0, opts);
  }
  return out.join("\n");
}

export function formatQueryRun(result: QueryRunResult, opts: CliFormatOptions = {}): string {
  const lines: string[] = [];
  lines.push(`Query ${result.preset.id} · ${result.preset.name}`);
  lines.push(`view ${result.viewModel.type} · ${result.filteredTasks.length} tasks · anchor ${result.anchorISO}`);
  lines.push("");

  for (const area of result.areas ?? [{ title: result.preset.name, viewModel: result.viewModel }]) {
    lines.push(area.title);
    switch (area.viewModel.type) {
      case "list": renderQueryList(lines, area.viewModel.tasks, opts); break;
      case "week": renderQueryWeek(lines, area.viewModel.days, opts); break;
      case "month": renderQueryMonth(lines, area.viewModel.cells, opts); break;
    }
  }
  return lines.join("\n");
}

function renderQueryList(lines: string[], tasks: EffectiveTask[], opts: CliFormatOptions): void {
  lines.push(`${tasks.length} tasks`);
  renderTaskRows(tasks, lines, "    ", opts);
  if (tasks.length === 0) lines.push("    —");
}

function renderQueryWeek(
  lines: string[],
  days: Array<{ date: string; tasks: EffectiveTask[] }>,
  opts: CliFormatOptions,
): void {
  for (const day of days) {
    lines.push(`${day.date} · ${day.tasks.length} tasks`);
    renderTaskRows(day.tasks, lines, "    ", opts);
    if (day.tasks.length === 0) lines.push("    —");
  }
}

function renderQueryMonth(
  lines: string[],
  cells: Array<{ date: string; tasks: EffectiveTask[] }>,
  opts: CliFormatOptions,
): void {
  const nonEmpty = cells.filter((cell) => cell.tasks.length > 0);
  lines.push(`dated cells · ${nonEmpty.length}/${cells.length}`);
  for (const cell of nonEmpty) {
    lines.push(`${cell.date} · ${cell.tasks.length} tasks`);
    renderTaskRows(cell.tasks, lines, "    ", opts);
  }
  if (nonEmpty.length === 0) lines.push("    —");
}

function renderTaskRows(tasks: EffectiveTask[], lines: string[], indent: string, opts: CliFormatOptions): void {
  const byId = new Map<string, EffectiveTask>();
  for (const task of tasks) byId.set(task.id, task);
  const rendered = new Set<string>();
  for (const task of tasks) {
    if (rendered.has(task.id)) continue;
    if (task.parentLine !== null && byId.has(`${task.path}:L${task.parentLine + 1}`)) continue;
    renderEffectiveTree(task, tasks, lines, rendered, indent, 0, opts);
  }
}

function renderEffectiveTree(
  task: EffectiveTask,
  all: EffectiveTask[],
  lines: string[],
  rendered: Set<string>,
  indent: string,
  depth: number,
  opts: CliFormatOptions,
): void {
  rendered.add(task.id);
  const prefix = indent + "    ".repeat(depth);
  const meta = inlineEffectiveMeta(task);
  lines.push(`${prefix}${formatTaskHeader(task, opts)}${meta ? `  ${meta}` : ""}`);
  const children = all.filter((child) => child.path === task.path && child.parentLine === task.line);
  for (const child of children) renderEffectiveTree(child, all, lines, rendered, indent, depth + 1, opts);
}

function inlineEffectiveMeta(task: EffectiveTask): string {
  const parts: string[] = [];
  if (task.effectiveScheduled) parts.push(`scheduled ${task.effectiveScheduled}`);
  if (task.effectiveDeadline) parts.push(`deadline ${task.effectiveDeadline}`);
  if (task.estimate) parts.push(`est ${shortEst(task.estimate)}`);
  if (task.actual) parts.push(`actual ${shortEst(task.actual)}`);
  return parts.join("  ");
}

function renderTree(
  t: ParsedTask,
  all: ParsedTask[],
  out: string[],
  rendered: Set<string>,
  depth: number,
  opts: CliFormatOptions = {},
) {
  rendered.add(t.id);
  if (depth === 0) {
    out.push(formatTaskHeader(t, opts));
    if (hasMeta(t)) out.push(formatTaskMeta(t));
  } else {
    const prefix = "    ".repeat(depth - 1);
    out.push(`${prefix}├ L${t.line + 1}  ${statusCheckbox(t.status)}  ${t.title}   ${inlineMeta(t)}`);
  }
  const children = all.filter(
    (c) => c.path === t.path && c.parentLine === t.line,
  );
  for (const c of children) {
    renderTree(c, all, out, rendered, depth + 1, opts);
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

export function formatShow(t: ParsedTask, opts: CliFormatOptions = {}): string {
  const lines: string[] = [];
  lines.push(`${t.path}:L${t.line + 1}  (hash ${t.hash})`);
  lines.push(`${statusCheckbox(t.status)} ${extractGrouping(t.tags, opts)} ${t.title}`);
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

export function formatAgentBrief(b: AgentBriefResult): string {
  const lines: string[] = [];
  lines.push(`Agent brief · ${b.today}`);
  lines.push(`counts overdue=${b.counts.overdue} today=${b.counts.today} unscheduled=${b.counts.unscheduled}`);
  lines.push("");
  lines.push("Next actions");
  if (b.nextActions.length === 0) {
    lines.push("    none");
  } else {
    b.nextActions.forEach((t, idx) => {
      lines.push(`${idx + 1}. ${t.id}  ${t.title}`);
      lines.push(`    why: ${t.reason}`);
      lines.push(`    meta: scheduled=${t.scheduled ?? "—"} deadline=${t.deadline ?? "—"} estimate=${shortEst(t.estimate)} tags=${t.tags.join(" ") || "—"}`);
      for (const action of t.actions.slice(0, 3)) {
        lines.push(`    ${action.label}: ${action.command}`);
      }
    });
  }
  lines.push("");
  lines.push("Sections");
  lines.push(`    overdue: ${b.sections.overdue.map((t) => t.id).join(", ") || "—"}`);
  lines.push(`    today: ${b.sections.today.map((t) => t.id).join(", ") || "—"}`);
  lines.push(`    unscheduled: ${b.sections.unscheduled.map((t) => t.id).join(", ") || "—"}`);
  return lines.join("\n");
}

export function formatReviewSummary(r: ReviewResult): string {
  const lines: string[] = [];
  lines.push(`Review · ${r.asOf}`);
  lines.push(`periods today=${r.today.from} week=${r.week.from}..${r.week.to} (${r.days} days)`);
  lines.push("");
  renderReviewRange(lines, "Today", r.today);
  lines.push("");
  renderReviewRange(lines, "Week", r.week);
  return lines.join("\n");
}

function renderReviewRange(lines: string[], label: string, range: ReviewRangeSummary): void {
  lines.push(`${label} · ${range.from}${range.from === range.to ? "" : ` → ${range.to}`}`);
  lines.push(`    done=${range.done} dropped=${range.dropped} delayed_open=${range.delayedOpen}`);
  lines.push(
    `    estimate actual=${range.estimate.actual}m estimate=${range.estimate.estimate}m delta=${signedMinutes(range.estimate.delta)} ratio=${range.estimate.ratio === null ? "—" : range.estimate.ratio.toFixed(2)} within_band=${range.estimate.withinBand.count}/${range.estimate.withinBand.total}`,
  );
  lines.push("    by_group");
  if (range.byGroup.length === 0) {
    lines.push("        —");
  } else {
    for (const group of range.byGroup.slice(0, 8)) {
      lines.push(
        `        ${group.group}  done=${group.done} dropped=${group.dropped} delayed_open=${group.delayedOpen} actual=${group.actual}m estimate=${group.estimate}m delta=${signedMinutes(group.delta)}`,
      );
    }
  }
  lines.push("    samples");
  lines.push(`        done: ${range.samples.done.map(sampleReviewTask).join(" | ") || "—"}`);
  lines.push(`        dropped: ${range.samples.dropped.map(sampleReviewTask).join(" | ") || "—"}`);
  lines.push(`        delayed_open: ${range.samples.delayedOpen.map(sampleReviewTask).join(" | ") || "—"}`);
}

function sampleReviewTask(task: ReviewTask): string {
  const parts = [task.id, task.title, task.group];
  if (task.completed) parts.push(`done=${task.completed}`);
  if (task.cancelled) parts.push(`cancelled=${task.cancelled}`);
  if (task.scheduled) parts.push(`scheduled=${task.scheduled}`);
  if (task.deadline) parts.push(`deadline=${task.deadline}`);
  if (task.estimate) parts.push(`est=${shortEst(task.estimate)}`);
  if (task.actual) parts.push(`actual=${shortEst(task.actual)}`);
  return parts.join(" ");
}

function signedMinutes(minutes: number): string {
  if (minutes === 0) return "0m";
  return `${minutes > 0 ? "+" : ""}${minutes}m`;
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
  titleOverride?: string,
): string {
  const ref = task ? task.id : path && line !== null ? `${path}:L${line + 1}` : "-";
  const title = titleOverride ?? (task ? task.title : "");
  const label = extraNote ?? (unchanged ? "unchanged" : action);
  const out: string[] = [];
  out.push(`ok  ${ref}  ${title}`);
  if (unchanged) {
    out.push(`    ${label}`);
  } else {
    const oldLines = before.split("\n");
    const newLines = after.split("\n");
    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      out.push(`    before  ${oldLines[i] ?? ""}`);
      out.push(`    after   ${newLines[i] ?? ""}`);
    }
  }
  return out.join("\n");
}

// US-211 + US-412: error format = English `code` (stable for grep / AI)
// + localized "一句人话". The English code stays English so scripts /
// agents can match `error not_found` regardless of locale; the
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
  return `error ${code}\n${display.replace(/\s*\n\s*/g, " ")}`;
}

export function formatAdd(result: { path: string; line: number; created: string }): string {
  return `ok  ${result.path}:L${result.line + 1}  created (each run adds a new task)\n    ${result.created.trim()}`;
}
