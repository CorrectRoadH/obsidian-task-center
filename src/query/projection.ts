// View projection — projects a filtered EffectiveTask[] into per-area render
// models. Views are SwiftUI-style layout trees (row/col stacks of area leaves);
// each area projects independently. Today/Completed/Unscheduled are just list
// areas with different DSL, not view types.
//
// ARCHITECTURE.md §4.3 defines the projection semantics:
//   - List: area `when` narrows preset.filters into a flat task list. Multi-
//     segment views (Today) are several list areas in the layout, not sections.
//   - Week/Month: date columns/cells from effectiveScheduled. Trays are
//     separate list areas in the layout, not embedded here.
// Pure functions, no DOM, no Obsidian dependency.

import { recomputeTopLevelInQuery, type EffectiveTask } from "../task-tree";
import type {
  AreaConfig,
  AreaType,
  GridAreaConfig,
  ListAreaConfig,
  MonthAreaConfig,
  WeekAreaConfig,
} from "../types";
import { applyQueryFilters, queryFilterHasActiveConditions } from "./filter";
import { startOfWeek, addDays, startOfMonth, endOfMonth, daysBetween, todayISO } from "../dates";

// ── View model types ──

export interface DayColumnModel {
  date: string;
  tasks: EffectiveTask[];
}

export interface MonthCellModel {
  date: string;
  tasks: EffectiveTask[];
}

export interface ListViewModel {
  type: "list";
  /** Matching top-level cards before the area limit (US-720b). */
  total: number;
  // A list area is a single flat task list — no internal grouping.
  tasks: EffectiveTask[];
}

export interface WeekViewModel {
  type: "week";
  days: DayColumnModel[];
}

export interface MonthViewModel {
  type: "month";
  cells: MonthCellModel[];
}

export type ViewModel = ListViewModel | WeekViewModel | MonthViewModel;

// Per-area projection dispatch as a total registry. A `Record<AreaType, …>`
// (not a `switch` with a `default`) makes the table exhaustive: adding an
// AreaType to the union fails to compile until a projector is registered here,
// instead of silently falling through to the list projector. The per-type
// argument shapes are normalized behind one `AreaProjector` signature, removing
// the projectWeekArea / projectMonthArea parameter-order mismatch at the call
// site. (US-109z2 — see REFACTOR.md §4: AreaSpec / AreaView.)
type AreaProjector = (
  tasks: EffectiveTask[],
  area: AreaConfig,
  weekStartsOn: 0 | 1,
  anchorISO: string,
) => ViewModel;

const emptyListModel = (): ListViewModel => ({
  type: "list",
  total: 0,
  tasks: [],
});

const AREA_PROJECTORS: Record<AreaType | "unknown", AreaProjector> = {
  list: (tasks, area, weekStartsOn) => projectListArea(tasks, area as ListAreaConfig, weekStartsOn),
  grid: (tasks, area, weekStartsOn) => projectListArea(tasks, area as GridAreaConfig, weekStartsOn),
  week: (tasks, area, weekStartsOn, anchorISO) =>
    projectWeekArea(tasks, area as WeekAreaConfig, weekStartsOn, anchorISO),
  month: (tasks, area, weekStartsOn, anchorISO) =>
    projectMonthArea(tasks, area as MonthAreaConfig, anchorISO, weekStartsOn),
  drop: emptyListModel,
  unknown: emptyListModel,
};

/**
 * Project a single area into its ViewModel. Used by the CLI / API query-run,
 * which represents a preset's result via its primary content area. A `drop`
 * area has no data, so it projects to an empty ungrouped list.
 */
export function projectArea(
  area: AreaConfig,
  tasks: EffectiveTask[],
  weekStartsOn: 0 | 1,
  anchorISO: string = todayISO(),
): ViewModel {
  return AREA_PROJECTORS[area.type](tasks, area, weekStartsOn, anchorISO);
}

// ── Sorting ──

type SortKey = "title_asc" | "title_desc" | "scheduled_asc" | "scheduled_desc"
  | "deadline_asc" | "deadline_desc" | "completed_desc" | "created_desc"
  | "deadline_risk" | "priority_desc";

function parseSortKey(raw: string): SortKey | null {
  const valid = new Set<string>([
    "title_asc", "title_desc", "scheduled_asc", "scheduled_desc",
    "deadline_asc", "deadline_desc", "completed_desc", "created_desc",
    "deadline_risk", "priority_desc",
  ]);
  return valid.has(raw) ? (raw as SortKey) : null;
}

function sortTasks(tasks: EffectiveTask[], orderBy?: string[]): EffectiveTask[] {
  if (!orderBy || orderBy.length === 0) return tasks;
  const keys = orderBy.map(parseSortKey).filter((k): k is SortKey => k !== null);
  if (keys.length === 0) return tasks;

  return [...tasks].sort((a, b) => {
    for (const key of keys) {
      const cmp = compareByKey(a, b, key);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function compareByKey(a: EffectiveTask, b: EffectiveTask, key: SortKey): number {
  switch (key) {
    case "title_asc":
      return a.title.localeCompare(b.title);
    case "title_desc":
      return b.title.localeCompare(a.title);
    case "scheduled_asc":
      return (a.effectiveScheduled ?? "9999").localeCompare(b.effectiveScheduled ?? "9999");
    case "scheduled_desc":
      return (b.effectiveScheduled ?? "0000").localeCompare(a.effectiveScheduled ?? "0000");
    case "deadline_asc":
      return (a.effectiveDeadline ?? "9999").localeCompare(b.effectiveDeadline ?? "9999");
    case "deadline_desc":
      return (b.effectiveDeadline ?? "0000").localeCompare(a.effectiveDeadline ?? "0000");
    case "deadline_risk": {
      // Urgent (overdue) first, then nearest deadline, then no deadline
      const today = todayISO();
      const aRisk = deadlineRisk(a, today);
      const bRisk = deadlineRisk(b, today);
      if (aRisk !== bRisk) return aRisk - bRisk;
      return (a.effectiveDeadline ?? "9999").localeCompare(b.effectiveDeadline ?? "9999");
    }
    case "completed_desc":
      return (b.completed ?? "0000").localeCompare(a.completed ?? "0000");
    case "created_desc":
      return (b.effectiveCreated ?? "0000").localeCompare(a.effectiveCreated ?? "0000");
    case "priority_desc":
      return (priorityRank(b.priority) - priorityRank(a.priority));
    default:
      return 0;
  }
}

function deadlineRisk(t: EffectiveTask, today: string): number {
  if (!t.effectiveDeadline) return 3; // no deadline
  if (t.effectiveDeadline < today) return 0; // overdue
  const diff = daysBetween(today, t.effectiveDeadline);
  if (diff <= 3) return 1; // soon
  return 2; // later
}

function priorityRank(p: string | null): number {
  switch (p) {
    case "🔺": return 5;
    case "⏫": return 4;
    case "🔼": return 3;
    case "🔽": return 2;
    case "⏬": return 1;
    default: return 0;
  }
}

// ── Per-area projections ──

/**
 * List area projection: area `when` narrows the (already preset-filtered)
 * task set into a flat, sorted, limited task list. No internal grouping —
 * multi-segment views (Today) use several list areas in the layout. Today and
 * TODO share this projection.
 */
export function projectListArea(
  tasks: EffectiveTask[],
  area: ListAreaConfig | GridAreaConfig,
  weekStartsOn: 0 | 1,
  // US-153: ids that bypass the status filter only (just-completed cards in the
  // current view session). Threaded into the area `when` so a freshly-done card
  // keeps its place in a `status: todo` list. GUI-only; CLI / summary never pass it.
  exemptStatusIds?: ReadonlySet<string>,
): ListViewModel {
  const base = area.when && queryFilterHasActiveConditions(area.when)
    ? applyQueryFilters(tasks, area.when, weekStartsOn, undefined, exemptStatusIds)
    : tasks;
  const sorted = sortTasks(recomputeTopLevelInQuery(base), area.orderBy);
  const roots = sorted.filter((task) => task.isTopLevelInQuery);
  const selected = new Set((area.limit !== undefined && area.limit > 0
    ? roots.slice(0, area.limit) : roots).map((task) => task.id));
  const byId = new Map(sorted.map((task) => [task.id, task]));
  const limited = sorted.filter((task) => {
    let root = task;
    const visited = new Set<string>();
    while (!root.isTopLevelInQuery && root.renderParentId && !visited.has(root.id)) {
      visited.add(root.id);
      const parent = byId.get(root.renderParentId);
      if (!parent) break;
      root = parent;
    }
    return selected.has(root.id);
  });
  return { type: "list", tasks: limited, total: roots.length };
}

export function projectWeekArea(
  tasks: EffectiveTask[],
  area: WeekAreaConfig,
  weekStartsOn: 0 | 1,
  anchorISO: string = todayISO(),
): WeekViewModel {
  // US-109z2: the week area filters by its own `when` (e.g. status: todo).
  const scoped = area.when && queryFilterHasActiveConditions(area.when)
    ? applyQueryFilters(tasks, area.when, weekStartsOn, anchorISO)
    : tasks;
  const weekStart = startOfWeek(anchorISO, weekStartsOn);
  const days: DayColumnModel[] = [];
  for (let i = 0; i < 7; i++) {
    days.push({ date: addDays(weekStart, i), tasks: [] });
  }
  const daysByDate = new Map(days.map((day) => [day.date, day]));
  for (const task of scoped) {
    if (task.effectiveScheduled) {
      const dayCol = daysByDate.get(task.effectiveScheduled);
      if (dayCol) dayCol.tasks.push(task);
    }
  }
  return { type: "week", days };
}

export function projectMonthArea(
  tasks: EffectiveTask[],
  area: MonthAreaConfig,
  anchorISO: string = todayISO(),
  weekStartsOn: 0 | 1 = 1,
): MonthViewModel {
  // US-109z2: the month area filters by its own `when`.
  const scoped = area.when && queryFilterHasActiveConditions(area.when)
    ? applyQueryFilters(tasks, area.when, weekStartsOn, anchorISO)
    : tasks;
  const monthStart = startOfMonth(anchorISO);
  const monthEnd = endOfMonth(anchorISO);
  const totalDays = daysBetween(monthStart, monthEnd) + 1;
  const cells: MonthCellModel[] = [];
  for (let i = 0; i < totalDays; i++) {
    cells.push({ date: addDays(monthStart, i), tasks: [] });
  }
  const cellsByDate = new Map(cells.map((cell) => [cell.date, cell]));
  for (const task of scoped) {
    if (task.effectiveScheduled) {
      const cell = cellsByDate.get(task.effectiveScheduled);
      if (cell) cell.tasks.push(task);
    }
  }
  return { type: "month", cells };
}
