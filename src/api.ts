import { App } from "obsidian";
import {
  ParsedTask,
  isStackNode,
  type LayoutNode,
  TaskStatus,
  type QueryPreset,
  type QueryPresetViewConfig,
  type QueryViewType,
  type TaskFormatFlavor,
} from "./types";
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
import { todayISO, resolveWhen, isValidISO, addDays } from "./dates";
import { normalizeGroupingTags } from "./grouping";
import { deriveEffectiveTasks, type EffectiveTask } from "./task-tree";
import { collectAreas, normalizeQueryPreset } from "./saved-views";
import { applyQueryFilters } from "./query/filter";
import { projectArea, type ViewModel } from "./query/projection";
import { areaWeekStartsOn } from "./areas";
import { formatMinutes } from "./parser";

// REMINDER: this module must NOT scan vault files directly. All parse work
// goes through `TaskCache`. Write verbs resolve refs via `cache.resolveRef`,
// which is single-file for `path:Lnnn`.
// (ARCHITECTURE.md §3.3 / §5.1, #2 large-vault regression)

/** Per-line result returned by {@link TaskCenterApi.drop} for cascade undo. */
export interface DropResult {
  path: string;
  line: number;
  before: string;
  after: string;
  unchanged: boolean;
}

export interface ListFilters {
  scheduled?: string;
  done?: string;
  overdue?: boolean;
  hasDeadline?: boolean;
  status?: "todo" | "done" | "dropped" | "in_progress";
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

export interface AgentBriefOpts {
  today?: string;
  limit?: number;
}

export interface ReviewOpts {
  today?: string;
  days?: number;
  limit?: number;
  groupingTags?: string[];
}

export interface QueryRunOpts {
  weekStartsOn: 0 | 1;
  anchorISO?: string;
  view?: QueryViewType;
}

export interface QueryRunResult {
  preset: QueryPreset;
  view: QueryPresetViewConfig;
  anchorISO: string;
  filteredTasks: EffectiveTask[];
  viewModel: ViewModel;
  areas: Array<{ title: string; filteredTasks: EffectiveTask[]; viewModel: ViewModel }>;
}

export interface AgentBriefAction {
  label: string;
  command: string;
}

export interface AgentBriefTask {
  id: string;
  title: string;
  reason: string;
  scheduled: string | null;
  deadline: string | null;
  estimate: number | null;
  tags: string[];
  actions: AgentBriefAction[];
}

export interface AgentBriefResult {
  today: string;
  counts: {
    overdue: number;
    today: number;
    unscheduled: number;
  };
  sections: {
    overdue: AgentBriefTask[];
    today: AgentBriefTask[];
    unscheduled: AgentBriefTask[];
  };
  nextActions: AgentBriefTask[];
}

export interface ReviewTask {
  id: string;
  title: string;
  group: string;
  status: TaskStatus;
  completed: string | null;
  cancelled: string | null;
  scheduled: string | null;
  deadline: string | null;
  estimate: number | null;
  actual: number | null;
}

export interface ReviewGroupSummary {
  group: string;
  done: number;
  dropped: number;
  delayedOpen: number;
  estimate: number;
  actual: number;
  delta: number;
}

export interface ReviewRangeSummary {
  from: string;
  to: string;
  done: number;
  dropped: number;
  delayedOpen: number;
  estimate: {
    actual: number;
    estimate: number;
    delta: number;
    ratio: number | null;
    withBoth: number;
    withinBand: { count: number; total: number; pct: number };
  };
  byGroup: ReviewGroupSummary[];
  samples: {
    done: ReviewTask[];
    dropped: ReviewTask[];
    delayedOpen: ReviewTask[];
  };
}

export interface ReviewResult {
  asOf: string;
  days: number;
  today: ReviewRangeSummary;
  week: ReviewRangeSummary;
}

export class TaskCenterApi {
  constructor(
    private readonly app: App,
    private readonly cache: TaskCache,
    private readonly getWriteSettings: () => {
      taskFormatFlavor?: TaskFormatFlavor;
      scheduledWriteFormat?: TaskFormatFlavor;
      weekStartsOn?: 0 | 1;
    } = () => ({}),
  ) {}

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
    if (filters.parent) {
      const parent = await this.show(filters.parent);
      const ids = new Set(collectDescendants(parent, all.filter(t => t.path === parent.path)).map(t => t.id));
      const selected = filterTasks(all, { ...filters, parent: undefined, limit: undefined }, this.getWriteSettings().weekStartsOn).filter(t => ids.has(t.id));
      return filters.limit ? selected.slice(0, filters.limit) : selected;
    }
    return filterTasks(all, filters, this.getWriteSettings().weekStartsOn);
  }

  async show(id: string): Promise<ParsedTask> {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("not_found", `no task matches ${id}`);
    return task;
  }

  async stats(opts: StatsOpts = {}): Promise<StatsResult> {
    const all = await this.cache.ensureAll();
    const effective = deriveEffectiveTasks(all);
    return computeStats(effective, opts);
  }

  async agentBrief(opts: AgentBriefOpts = {}): Promise<AgentBriefResult> {
    const all = await this.cache.ensureAll();
    return buildAgentBrief(all, opts);
  }

  async review(opts: ReviewOpts = {}): Promise<ReviewResult> {
    const all = await this.cache.ensureAll();
    return buildReviewSummary(all, opts);
  }

  async runQueryPreset(preset: QueryPreset, opts: QueryRunOpts): Promise<QueryRunResult> {
    const normalized = normalizeQueryPreset(preset);
    const effective = deriveEffectiveTasks(await this.cache.ensureAll());
    const anchorISO = opts.anchorISO ?? todayISO();
    const view = opts.view ? { ...normalized.view, layout: overrideLayout(normalized.view.layout, opts.view) } : normalized.view;
    const areas = collectAreas(view.layout).filter(area => area.type !== "drop").map(area => {
      const when = "when" in area ? area.when : undefined;
      const weekStartsOn = area.type === "week" || area.type === "month" ? areaWeekStartsOn(area, opts.weekStartsOn) : opts.weekStartsOn;
      return {
        title: area.title ?? area.id ?? area.type,
        filteredTasks: when ? applyQueryFilters(effective, when, weekStartsOn, anchorISO) : effective,
        viewModel: projectArea(area, effective, weekStartsOn, anchorISO),
      };
    });
    return {
      preset: normalized, view, anchorISO, areas,
      filteredTasks: [...new Map(areas.flatMap(area => area.filteredTasks).map(task => [task.id, task])).values()],
      viewModel: areas[0]?.viewModel ?? { type: "list", tasks: [], total: 0 },
    };
  }

  async schedule(id: string, date: string | null) {
    if (date !== null && !isValidISO(date)) {
      throw new TaskWriterError("invalid_date", `not ISO YYYY-MM-DD: ${date}`);
    }
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("not_found", id);
    return await setScheduled(this.app, task, date, this.taskFormatFlavor());
  }

  async deadline(id: string, date: string | null) {
    if (date !== null && !isValidISO(date)) {
      throw new TaskWriterError("invalid_date", `not ISO YYYY-MM-DD: ${date}`);
    }
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("not_found", id);
    return await setDeadline(this.app, task, date, this.taskFormatFlavor());
  }

  async actual(id: string, minutes: number, mode: "set" | "add" = "set") {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("not_found", id);
    return mode === "add"
      ? await addToActual(this.app, task, minutes)
      : await setActual(this.app, task, minutes);
  }

  async estimate(id: string, minutes: number | null) {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("not_found", id);
    return await setEstimate(this.app, task, minutes);
  }

  async done(id: string, at: string | null = null, cascade = true) {
    if (at && !isValidISO(at)) {
      throw new TaskWriterError("invalid_date", `--at requires YYYY-MM-DD: ${at}`);
    }
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("not_found", id);
    // US-145: completing a parent cascades to its `todo` descendants. Tasks
    // that are already `[x] / [-] / [>]` are left alone — overwriting their
    // recorded ✅ / ❌ / 🛫 dates would destroy history. Cross-file parent /
    // child relationships are not modelled (ARCHITECTURE §1.4), so we walk
    // only this file's tasks.
    const fileTasks = this.cache.get(task.path)?.tasks ?? [task];
    const descendants = cascade
      ? collectDescendants(task, fileTasks).filter((t) => (t.status === "todo" || t.status === "in_progress"))
      : [];
    const targets = [task, ...descendants];
    // Bottom-up so line numbers stay stable across each mutation.
    targets.sort((a, b) => b.line - a.line);
    // Mirror `drop`: return one entry per affected line in `results` so undo
    // callers can restore the parent AND every cascaded child atomically,
    // with the parent's fields kept at top level for backward compatibility.
    const results: DropResult[] = [];
    for (const t of targets) {
      const r = await markDone(this.app, t, at, this.taskFormatFlavor());
      results.push({ path: t.path, line: t.line, before: r.before, after: r.after, unchanged: r.unchanged });
    }
    const parentResult = results.find((r) => r.line === task.line) ?? results[results.length - 1];
    return {
      before: parentResult.before,
      after: parentResult.after,
      unchanged: parentResult.unchanged,
      results,
    };
  }

  async undone(id: string) {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("not_found", id);
    return await markUndone(this.app, task);
  }

  // US-124: dropping a parent cascades to its `todo` descendants — already
  // completed children are preserved so history isn't overwritten with `[-]`.
  // see USER_STORIES.md
  //
  // fix-m4-abandon-undo-cascade: returns `results` array with one entry per
  // affected line so DnD/tray abandon callers can push a multi-op undo entry
  // that restores parent + all cascaded children atomically.
  async drop(id: string, cascade = true) {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("not_found", id);
    // Cascade only to descendants that are still `todo` — don't overwrite a
    // done `[x] ✅ …` with a dropped `[-] ❌ …`; that would destroy history.
    // Cross-file parent/child relationships are not modelled (ARCHITECTURE
    // §1.4) so we only need this file's tasks.
    const fileTasks = this.cache.get(task.path)?.tasks ?? [task];
    const descendants = cascade
      ? collectDescendants(task, fileTasks).filter((t) => (t.status === "todo" || t.status === "in_progress"))
      : [];
    const targets = [task, ...descendants];
    // Drop bottom-up so descending line numbers stay stable across each mutation
    targets.sort((a, b) => b.line - a.line);
    const results: DropResult[] = [];
    for (const t of targets) {
      const r = await markDropped(this.app, t, null, this.taskFormatFlavor());
      results.push({
        path: t.path,
        line: t.line,
        before: r.before,
        after: r.after,
        unchanged: r.unchanged,
      });
    }
    // Backward-compat: return first (parent) result fields at top level
    const parentResult = results.find((r) => r.line === task.line) ?? results[results.length - 1];
    return {
      before: parentResult.before,
      after: parentResult.after,
      unchanged: parentResult.unchanged,
      results,
    };
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
  }) {
    let parent: ParsedTask | null = null;
    if (opts.parent) {
      parent = await this.cache.resolveRef(opts.parent);
      if (!parent) throw new TaskWriterError("not_found", `parent: ${opts.parent}`);
    }
    return await addTask(this.app, {
      text: opts.text,
      targetPath: opts.to,
      tags: opts.tag,
      scheduled: opts.scheduled ?? null,
      taskFormat: this.taskFormatFlavor(),
      deadline: opts.deadline ?? null,
      estimate: opts.estimate ?? null,
      parent,
      stampCreated: opts.stampCreated,
    });
  }

  async rename(id: string, newTitle: string) {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("not_found", id);
    const result = await renameTask(this.app, task, newTitle);
    this.cache.recordRename(task, result.after);
    return result;
  }

  async tag(id: string, tag: string, remove = false) {
    const task = await this.cache.resolveRef(id);
    if (!task) throw new TaskWriterError("not_found", id);
    return remove ? await removeTag(this.app, task, tag) : await addTag(this.app, task, tag);
  }

  async nest(childId: string, parentId: string) {
    const child = await this.cache.resolveRef(childId);
    if (!child) throw new TaskWriterError("not_found", `child: ${childId}`);
    const parent = await this.cache.resolveRef(parentId);
    if (!parent) throw new TaskWriterError("not_found", `parent: ${parentId}`);
    return await nestUnder(this.app, child, parent);
  }

  private taskFormatFlavor(): TaskFormatFlavor {
    const settings = this.getWriteSettings();
    const flavor = settings.taskFormatFlavor ?? settings.scheduledWriteFormat;
    return flavor === "dataview" ? "dataview" : "tasks";
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

export function filterTasks(all: ParsedTask[], filters: ListFilters, weekStart: 0 | 1 = 1): ParsedTask[] {
  let filtered = effectiveDates(all);
  // By default, hide tasks whose ancestor is done / dropped. Only keep them
  // when the caller explicitly asks for inherited-terminal context (e.g. status=done
  // lookups) — the terminal status filter below overrides this where needed.
  if (!filters.status || filters.status === "todo") {
    filtered = filtered.filter((t) => !t.inheritsTerminal);
  }
  if (filters.scheduled) {
    const r = resolveWhen(filters.scheduled, todayISO(), weekStart);
    if (r.unscheduled) {
      filtered = filtered.filter((t) => !t.scheduled && (t.status === "todo" || t.status === "in_progress"));
    } else if (r.exact) {
      filtered = filtered.filter((t) => t.scheduled === r.exact);
    } else if (r.from && r.to) {
      filtered = filtered.filter(
        (t) => t.scheduled && t.scheduled >= r.from! && t.scheduled <= r.to!,
      );
    }
  }
  if (filters.done) {
    const r = resolveWhen(filters.done, todayISO(), weekStart);
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
      (t) => (t.status === "todo" || t.status === "in_progress") && t.deadline && t.deadline < today,
    );
  }
  if (filters.hasDeadline) filtered = filtered.filter((t) => !!t.deadline);
  if (filters.status) filtered = filtered.filter((t) => t.status === filters.status || (filters.status === "todo" && t.status === "in_progress"));
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
  // US-212: `list parent=<id>` — children of one parent task. Compared
  // against the canonical `path:Lnnn` id so agents can pipe `list ...`
  // output's first column straight back into a follow-up `list`. Hash-
  // form parent refs are intentionally NOT supported here (the parent's
  // id changes as line numbers shift; pass the resolved path:line).
  // see USER_STORIES.md
  if (filters.parent) {
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

// US-206 + US-303: estimate-vs-actual stats over a rolling window. The
// `ratio = sum(actual) / sum(estimate)` is the AI / human calibration
// signal — paired with within-band hit rate (±25% target) and per-tag
// minute totals (top contributors). `byGroup` (US-301) lets callers
// roll the per-tag table up by a substring like `象限`.
// see USER_STORIES.md
export function computeStats(all: EffectiveTask[], opts: StatsOpts): StatsResult {
  const today = todayISO();
  let from = opts.from ?? "";
  const to = opts.to ?? today;
  const days = opts.days ?? 7;
  if (!from) {
    from = addDays(to, -(days - 1));
  }

  const done = all.filter(
    (t) => t.effectiveStatus === "done" && t.completed && t.completed >= from && t.completed <= to,
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

// US-723: agent brief. This is the compact machine-readable-enough summary
// an AI needs before proposing action: what is overdue, what is scheduled
// today, what is available to pull in, and which stable CLI write commands
// can execute the next step without screen scraping.
// see USER_STORIES.md
export function buildAgentBrief(all: ParsedTask[], opts: AgentBriefOpts = {}): AgentBriefResult {
  all = effectiveDates(all);
  const today = opts.today ?? todayISO();
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 5;
  const tomorrow = addDaysISO(today, 1);
  const actionable = all.filter((t) => (t.status === "todo" || t.status === "in_progress") && !t.inheritsTerminal);
  const overdueRaw = actionable.filter(
    (t) => (!!t.deadline && t.deadline < today) || (!!t.scheduled && t.scheduled < today),
  );
  const overdueIds = new Set(overdueRaw.map((t) => t.id));
  const todayRaw = actionable.filter(
    (t) => !overdueIds.has(t.id) && (t.scheduled === today || t.deadline === today),
  );
  const todayIds = new Set(todayRaw.map((t) => t.id));
  const unscheduledRaw = actionable.filter(
    (t) => !overdueIds.has(t.id) && !todayIds.has(t.id) && !t.scheduled,
  );

  const overdue = overdueRaw.slice(0, limit).map((t) => briefTask(t, `overdue ${t.deadline && t.deadline < today ? `deadline ${t.deadline}` : `scheduled ${t.scheduled}`}`, today, tomorrow));
  const todayTasks = todayRaw.slice(0, limit).map((t) => {
    const reason =
      t.scheduled === today && t.deadline === today
        ? "scheduled and due today"
        : t.scheduled === today
          ? "scheduled today"
          : "deadline today";
    return briefTask(t, reason, today, tomorrow);
  });
  const unscheduled = unscheduledRaw.slice(0, limit).map((t) => briefTask(t, "unscheduled candidate", today, tomorrow));
  const nextActions = [...overdue, ...todayTasks, ...unscheduled].slice(0, limit);

  return {
    today,
    counts: {
      overdue: overdueRaw.length,
      today: todayRaw.length,
      unscheduled: unscheduledRaw.length,
    },
    sections: { overdue, today: todayTasks, unscheduled },
    nextActions,
  };
}

// US-722: review mode. This is the evening / weekly retrospective slice:
// users and agents can ask "what actually happened?" without scraping the
// visual board. It deliberately reports both a same-day view and a rolling
// week window so the output is useful at shutdown and during weekly retro.
// see USER_STORIES.md
export function buildReviewSummary(all: ParsedTask[], opts: ReviewOpts = {}): ReviewResult {
  all = effectiveDates(all);
  const today = opts.today ?? todayISO();
  const days = opts.days && opts.days > 0 ? opts.days : 7;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 5;
  const groupingTags = normalizeGroupingTags(opts.groupingTags);
  return {
    asOf: today,
    days,
    today: summarizeReviewRange(all, today, today, groupingTags, limit),
    week: summarizeReviewRange(all, addDaysISO(today, -(days - 1)), today, groupingTags, limit),
  };
}

function summarizeReviewRange(
  all: ParsedTask[],
  from: string,
  to: string,
  groupingTags: string[],
  limit: number,
): ReviewRangeSummary {
  const visible = all.filter((t) => !t.inheritsTerminal);
  const done = visible.filter(
    (t) => t.status === "done" && !!t.completed && t.completed >= from && t.completed <= to,
  );
  const dropped = visible.filter(
    (t) =>
      t.status === "dropped" &&
      !!terminalDate(t) &&
      terminalDate(t)! >= from &&
      terminalDate(t)! <= to,
  );
  const delayedOpen = visible.filter(
    (t) => (t.status === "todo" || t.status === "in_progress") && ((!!t.deadline && t.deadline < to) || (!!t.scheduled && t.scheduled < to)),
  );

  const estimate = estimateReview(done);
  const groupMap = new Map<string, ReviewGroupSummary>();
  const ensureGroup = (group: string): ReviewGroupSummary => {
    let row = groupMap.get(group);
    if (!row) {
      row = { group, done: 0, dropped: 0, delayedOpen: 0, estimate: 0, actual: 0, delta: 0 };
      groupMap.set(group, row);
    }
    return row;
  };

  for (const task of done) {
    const row = ensureGroup(reviewGroup(task, groupingTags));
    row.done += 1;
    row.estimate += task.estimate ?? 0;
    row.actual += task.actual ?? 0;
    row.delta = row.actual - row.estimate;
  }
  for (const task of dropped) {
    ensureGroup(reviewGroup(task, groupingTags)).dropped += 1;
  }
  for (const task of delayedOpen) {
    ensureGroup(reviewGroup(task, groupingTags)).delayedOpen += 1;
  }

  return {
    from,
    to,
    done: done.length,
    dropped: dropped.length,
    delayedOpen: delayedOpen.length,
    estimate,
    byGroup: Array.from(groupMap.values()).sort(reviewGroupSort),
    samples: {
      done: done.slice(0, limit).map((t) => reviewTask(t, groupingTags)),
      dropped: dropped.slice(0, limit).map((t) => reviewTask(t, groupingTags)),
      delayedOpen: delayedOpen.slice(0, limit).map((t) => reviewTask(t, groupingTags)),
    },
  };
}

function terminalDate(t: ParsedTask): string | null {
  return t.completed ?? t.cancelled ?? extractEmojiDate(t.rawLine, "❌");
}

function extractEmojiDate(raw: string, emoji: string): string | null {
  const escaped = emoji.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw.match(new RegExp(`${escaped}\\s*(\\d{4}-\\d{2}-\\d{2})`))?.[1] ?? null;
}

function estimateReview(done: ParsedTask[]): ReviewRangeSummary["estimate"] {
  const actual = done.reduce((sum, task) => sum + (task.actual ?? 0), 0);
  const estimate = done.reduce((sum, task) => sum + (task.estimate ?? 0), 0);
  const withBoth = done.filter((task) => (task.estimate ?? 0) > 0 && (task.actual ?? 0) > 0);
  const ratios = withBoth.map((task) => (task.actual ?? 0) / (task.estimate ?? 1));
  const within = ratios.filter((ratio) => ratio >= 0.8 && ratio <= 1.25);
  return {
    actual,
    estimate,
    delta: actual - estimate,
    ratio: estimate > 0 ? actual / estimate : null,
    withBoth: withBoth.length,
    withinBand: {
      count: within.length,
      total: ratios.length,
      pct: ratios.length > 0 ? Math.round((within.length / ratios.length) * 100) : 0,
    },
  };
}

function reviewGroup(task: ParsedTask, groupingTags: string[]): string {
  for (const tag of groupingTags) {
    if (task.tags.includes(tag)) return tag;
  }
  return "unclassified";
}

function reviewGroupSort(a: ReviewGroupSummary, b: ReviewGroupSummary): number {
  const scoreA = a.done + a.dropped + a.delayedOpen;
  const scoreB = b.done + b.dropped + b.delayedOpen;
  if (scoreA !== scoreB) return scoreB - scoreA;
  return a.group.localeCompare(b.group);
}

function reviewTask(t: ParsedTask, groupingTags: string[]): ReviewTask {
  return {
    id: t.id,
    title: t.title,
    group: reviewGroup(t, groupingTags),
    status: t.status,
    completed: t.completed,
    cancelled: t.cancelled,
    scheduled: t.scheduled,
    deadline: t.deadline,
    estimate: t.estimate,
    actual: t.actual,
  };
}

function briefTask(t: ParsedTask, reason: string, today: string, tomorrow: string): AgentBriefTask {
  return {
    id: t.id,
    title: t.title,
    reason,
    scheduled: t.scheduled,
    deadline: t.deadline,
    estimate: t.estimate,
    tags: t.tags,
    actions: briefActions(t, today, tomorrow),
  };
}

function briefActions(t: ParsedTask, today: string, tomorrow: string): AgentBriefAction[] {
  const ref = quoteCli(t.id);
  const actions: AgentBriefAction[] = [
    { label: "done", command: `obsidian task-center:done ref=${ref}` },
    { label: "abandon", command: `obsidian task-center:abandon ref=${ref}` },
  ];
  if (t.scheduled !== today) {
    actions.push({ label: "schedule_today", command: `obsidian task-center:schedule ref=${ref} date=${today}` });
  }
  actions.push({ label: "schedule_tomorrow", command: `obsidian task-center:schedule ref=${ref} date=${tomorrow}` });
  actions.push({ label: "add_actual_15m", command: `obsidian task-center:actual ref=${ref} minutes=+15m` });
  return actions;
}

function quoteCli(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

function addDaysISO(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map((part) => parseInt(part, 10));
  const d = new Date(year, month - 1, day);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")}`;
}

export function shortEst(mins: number | null): string {
  return mins ? formatMinutes(mins) : "—";
}

function effectiveDates(all: ParsedTask[]): ParsedTask[] {
  return deriveEffectiveTasks(all).map(task => ({ ...task, scheduled: task.effectiveScheduled, deadline: task.effectiveDeadline }));
}

function overrideLayout(node: LayoutNode, type: QueryViewType): LayoutNode {
  if (isStackNode(node)) return { ...node, children: node.children.map(child => overrideLayout(child, type)) };
  if (node.type === "drop" || node.type === "unknown") return node;
  return { ...node, type };
}
