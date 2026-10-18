// US-109z2: area behaviour as a small class hierarchy (Strategy pattern).
//
// The area *data* stays plain JSON (AreaConfig in types.ts) so it serializes to
// the Query DSL. The *behaviour / capabilities* of each area type live here as
// classes with inheritance, so adding a capability is an override in one class
// — not another `if (type === "list" || type === "grid" || ...)` scattered
// across the editor / projection / renderers (those kept dropping cases like
// week/month whenever a new capability was added).
//
// Per-INSTANCE behaviour that differs between two areas of the same type — e.g.
// the unscheduled tray's "drop here clears ⏳" — stays data-driven on the area
// itself via `onDrop`; it is not a per-type concern and so is not modelled here.

import { addDays, todayISO } from "./dates";
import { isQueryDate } from "./query/schema";

import type {
  AreaConfig,
  AreaType,
  GridAreaConfig,
  ListAreaConfig,
  MonthAreaConfig,
  WeekAreaConfig,
} from "./types";

export type FilterableAreaConfig = ListAreaConfig | GridAreaConfig | WeekAreaConfig | MonthAreaConfig;

// Base: a generic area. Defaults are the "least capable" (a pure marker), so a
// new subclass opts INTO capabilities rather than forgetting to opt out.
export abstract class AreaHandler {
  abstract readonly type: AreaType | "unknown";
  /** Lucide icon id shown in the layout tree / area picker. */
  abstract readonly icon: string;
  /** i18n key for the human label (resolved with `t()` by the caller). */
  abstract readonly labelKey: string;
  /** Renders task cards (vs. a pure action target / malformed area). */
  rendersTasks(): boolean { return false; }
  /** Carries a `when` and so shows the 过滤条件 (filter) controls. */
  filterable(): boolean { return false; }
  /** Offers the 编辑区域 entry (title / type / filter). */
  editable(): boolean { return false; }
  /**
   * Whether dropping a card onto this area does something. The *effect* is
   * per-instance data (`area.onDrop` — e.g. the unscheduled tray clears ⏳, the
   * abandon zone sets `dropped`), so the default is "accepts a drop iff the area
   * declares an onDrop". Date grids (week/month) override this: each day cell is
   * implicitly a reschedule target even without an explicit `onDrop`.
   */
  acceptsDrop(area: AreaConfig): boolean { return !!area.onDrop; }
}

// Shared base for every area that renders a task collection and so can be
// filtered, titled and edited (list / grid / week / month). Subclasses only
// differ by icon + label.
abstract class TaskAreaHandler extends AreaHandler {
  override rendersTasks(): boolean { return true; }
  override filterable(): boolean { return true; }
  override editable(): boolean { return true; }
}

// Base for the date grids (week / month): every day cell is implicitly a
// reschedule drop target, so they accept drops regardless of an explicit onDrop.
abstract class DateGridAreaHandler extends TaskAreaHandler {
  override acceptsDrop(): boolean { return true; }
}

class ListAreaHandler extends TaskAreaHandler {
  readonly type = "list" as const;
  readonly icon = "list";
  readonly labelKey = "savedViews.viewList";
}

class GridAreaHandler extends TaskAreaHandler {
  readonly type = "grid" as const;
  readonly icon = "layout-grid";
  readonly labelKey = "savedViews.viewGrid";
}

class WeekAreaHandler extends DateGridAreaHandler {
  readonly type = "week" as const;
  readonly icon = "calendar-range";
  readonly labelKey = "savedViews.viewWeek";
}

class MonthAreaHandler extends DateGridAreaHandler {
  readonly type = "month" as const;
  readonly icon = "calendar";
  readonly labelKey = "savedViews.viewMonth";
}

// A pure action target (the abandon zone). No tasks, no filter, no editor — its
// only behaviour is its instance `onDrop` (so it accepts drops via the base).
class DropAreaHandler extends AreaHandler {
  readonly type = "drop" as const;
  readonly icon = "trash-2";
  readonly labelKey = "savedViews.areaTypeDrop";
}

// Fallback for a malformed / unsupported `type` (renders raw JSON in the view).
class UnknownAreaHandler extends AreaHandler {
  readonly type = "unknown" as const;
  readonly icon = "help-circle";
  readonly labelKey = "savedViews.viewList";
}

const HANDLERS: Record<AreaType | "unknown", AreaHandler> = {
  list: new ListAreaHandler(),
  grid: new GridAreaHandler(),
  week: new WeekAreaHandler(),
  month: new MonthAreaHandler(),
  drop: new DropAreaHandler(),
  unknown: new UnknownAreaHandler(),
};

/** The behaviour handler for an area type (falls back to the unknown handler). */
export function areaHandler(type: AreaType | "unknown"): AreaHandler {
  return HANDLERS[type] ?? HANDLERS.unknown;
}

/** "Does this area filter?" — backed by the handler, narrowing to configs that
 *  actually carry `when`. The one source of truth used by editor / projection. */
export function areaSupportsWhen(area: AreaConfig): area is FilterableAreaConfig {
  return areaHandler(area.type).filterable();
}

/** The area types a user can pick when adding / changing an area (excludes the
 *  internal `unknown` fallback). Order = the picker order. */
export const SELECTABLE_AREA_TYPES: AreaType[] = ["list", "grid", "week", "month", "drop"];


/** US-109t: per-area calendar settings override the global default. */
export function areaWeekStartsOn(area: WeekAreaConfig | MonthAreaConfig, fallback: 0 | 1): 0 | 1 {
  return area.firstDayOfWeek === "monday" ? 1 : area.firstDayOfWeek === "sunday" ? 0 : fallback;
}

/** Resolve one-day write tokens at drop time, before calling the ISO-only API. */
export function resolveScheduledDropDate(token: string, today: string = todayISO()): string | undefined {
  const value = token.trim();
  if (value === "today") return today;
  if (value === "tomorrow") return addDays(today, 1);
  if (value === "next-week") return addDays(today, 7);
  return isQueryDate(value) ? value : undefined;
}
