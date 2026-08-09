// US-305: `[-] ❌` is "abandoned" and is its own checkbox-status semantic
// (`dropped`), separate from `done`. Keeping abandonment distinct lets
// users see what they walked away from — not lumped into "completed"
// counts and not pretending it never existed (vs. file deletion).
// see USER_STORIES.md
export type TaskStatus = "todo" | "done" | "dropped" | "in_progress" | "cancelled" | "custom";

export interface ParsedTask {
  id: string;
  path: string;
  line: number;
  indent: string;
  checkbox: string;
  status: TaskStatus;
  title: string;
  rawTitle: string;
  rawLine: string;
  tags: string[];
  scheduled: string | null;
  deadline: string | null;
  start: string | null;
  completed: string | null;
  cancelled: string | null;
  created: string | null;
  // US-142a: recurrence text from 🔁 token (e.g. "every week"). Consumed
  // greedily up to the next metadata boundary in parser.ts META_STRIP_RE.
  recurrence: string | null;
  // US-142a: priority emoji (🔺⏫🔼🔽⏬). Parsed from the raw title line.
  priority: string | null;
  // US-125: callout nesting depth — number of `> ` prefixes so the
  // writer can reconstruct the exact callout indent when writing back.
  calloutDepth: number;
  inlineFields: Record<string, string[]>;
  durationFields: Record<string, number>;
  // Backward-compatible aliases for the default summary preset. New UI and
  // aggregation paths should prefer durationFields so field names stay user data.
  estimate: number | null;
  actual: number | null;
  parentLine: number | null;
  parentIndex: number | null;
  childrenLines: number[];
  hash: string;
  mtime: number;
  // US-144: child inherits parent's terminal status (and via parent-side
  // emoji-date inspection in the renderer, parent's ⏳ / 📅 too) — so
  // children don't have to redundantly carry their parent's metadata.
  // Concretely this flag is "any ancestor list item (task OR bullet) is
  // `[x]` done, `[-]` dropped, or tagged `#dropped`". A terminated
  // ancestor suppresses its descendants from todo / unscheduled views
  // (finishing or abandoning a section implicitly finishes everything
  // below it — the cascade complement of US-145).
  // see USER_STORIES.md
  inheritsTerminal: boolean;
  // US-144a: the actual terminal kind propagated from the nearest terminal
  // ancestor (task or non-task bullet). When set, EffectiveTask derivation
  // uses this instead of mapping the task's own status or the ancestor's
  // status. This preserves the correct semantics when the terminal source
  // is a non-task bullet (e.g. `- #dropped`), a `[-]` dropped parent, or
  // a `[x]` done section header.
  // see USER_STORIES.md
  inheritedTerminalKind: TaskStatus | null;
}

export interface TaskCenterSettings {
  // Legacy settings may still exist in old data.json; loadSettings ignores
  // unknown keys, and these optional fields are only read by migration-safe
  // compatibility paths.
  inboxPath?: string;
  groupingTags?: string[];
  // US-724 / VAL-CORE-005: user-saved query presets. These are the
  // canonical QueryPreset DSL model shared by GUI, CLI, and storage.
  // Legacy SavedTaskView entries in data.json are detected and rejected
  // during loadSettings — no migration path exists.
  queryPresets: QueryPreset[];
  // US-109l: builtin (preset) tabs the user permanently deleted. `ensureBuiltin
  // QueryPresets` skips re-seeding these on load so a deleted preset stays gone
  // across restarts. Cleared per-id by 行内「恢复预设」 and wholesale by
  // 「恢复预设 Tabs」; an entry is removed when the delete is undone.
  deletedBuiltinIds: string[];
  defaultSavedViewId: string | null;
  defaultView: "today" | "week" | "month" | "completed" | "unscheduled";
  openOnStartup: boolean;
  weekStartsOn: 0 | 1;
  stampCreated: boolean;
  // US-111: read supports both Tasks emoji metadata and Dataview inline
  // fields. This preference controls which flavor Task Center writes.
  taskFormatFlavor: TaskFormatFlavor;
  // US-405: last tab the user was on when they closed the board. Persists
  // across Obsidian restarts so morning-open lands where evening-close
  // left off. Read in `TaskCenterView.constructor`'s ViewState init,
  // written in `setTab`.
  // see USER_STORIES.md
  lastTab: "today" | "week" | "month" | "completed" | "unscheduled" | "list" | null;
  lastSavedViewId: string | null;
  // US-510: platform-conditional UI strings — shortcut hints / mouse
  // descriptions are branched per platform (desktop hint vs mobile hint),
  // not localized; these tunables also live mobile-only. Safe defaults so
  // desktop users see no change.
  // see USER_STORIES.md
  mobileLongPressMs: number; // 200..1000, default 500
  mobileSwipeEnabled: boolean; // default true (left=done, right=drop)
  // US-502: real mobile layout with a force-mobile escape hatch
  // hatch for iPad / split-screen / large foldables that want column
  // layout regardless of width. UX-mobile §7.
  // see USER_STORIES.md
  mobileForceLayout: boolean; // default false (auto = follow platform modality)
}

export type TaskFormatFlavor = "tasks" | "dataview";

export type QueryStatus = "all" | TaskStatus | TaskStatus[];
export type QueryTimeField = "scheduled" | "deadline" | "completed" | "created" | "dropped";
export type QueryTimeFilters = Partial<Record<QueryTimeField, string>>;
export type QueryViewType = "list" | "week" | "month";

export interface SavedViewConfig {
  type: QueryViewType;
  // Optional preset semantic. Examples: "today", "completed", "unscheduled".
  // This is not a new view type; it is metadata that lets the runtime restore
  // which query preset semantics the user saved.
  preset?: string;
  orderBy?: string[];
  // ARCHITECTURE.md §1.3: QueryTray — separate query area for week/month views.
  tray?: QueryTray;
}

export interface SavedTaskView {
  id: string;
  name: string;
  builtin?: boolean;
  hidden?: boolean;
  search: string;
  tag: string;
  time: QueryTimeFilters;
  status: QueryStatus;
  view?: SavedViewConfig;
}

// ── QueryPreset DSL — the canonical query model (ARCHITECTURE.md §1.3) ──
// Legacy SavedTaskView is the flat predecessor; QueryPreset nests
// filters/view into a single DSL object shared by GUI, CLI,
// and settings storage. No migration path exists for old SavedTaskView
// data.json entries (VAL-CORE-005 / VAL-CROSS-002).

// 标签过滤的匹配模式。裸 `string[]` / 逗号串（向后兼容）= AND；对象形态
// `{ values, mode }` 让预设表达 OR（「含任一标签」），四象限等用得上。归一化
// 输出：AND 收敛回裸数组，只有 OR 才用对象形态。
export interface TagSelector {
  values: string[];
  mode: "and" | "or";
  // US-109d3: 排除组——任务只要带其中任一标签就被过滤掉。与 values（包含组）互斥。
  exclude?: string[];
}

// US-109d4: 自由布尔表达式形态的标签过滤（`#a and (#b or #c) not #d`）。与三态
// （TagSelector / 裸数组）互斥，是同一份 when.tags 的另一种形态。
export interface TagExprFilter {
  expr: string;
}

export interface QueryPresetFilters {
  search?: string;
  tags?: string[] | string | TagSelector | TagExprFilter;
  status?: QueryStatus;
  time?: QueryTimeFilters;
}

// ARCHITECTURE.md §1.3: QueryTray — a separate query area for week/month
// views (e.g. unscheduled tray). The tray's data source is an independent
// filter applied to the effective task set; it does not alter the main
// date area collection.
export interface QueryTray {
  enabled: boolean;
  title: string;
  filters: QueryPresetFilters;
  orderBy?: string[];
}

// ── View = SwiftUI 式布局树（ARCHITECTURE.md §1.3）──
// 没有单一 view 类型，也没有 preset。一个 view 是一棵布局树：row / col
// 容器（≈ HStack / VStack）嵌套 area 叶子组件。旧的 {type, preset,
// sections, tray} 形状由 normalize 迁移成 { layout }。

// 受支持的 area 类型。`type` 是其它字符串的 area 会被归一化成 unknown area
// 并在视图里渲染成「未知类型 + JSON」。四象限等二维布局用 row / col 嵌套
// 多个带标题（title）的 grid area 表达，不需要专门的 area 类型。
export type AreaType = "list" | "grid" | "week" | "month" | "drop";

// 卡片被拖入某个 area 时的写操作；三种语义互斥。
export interface DropEffect {
  setStatus?: "dropped";    // 放弃区
  setScheduled?: string;    // 写排期 DateToken（week / month 日格隐式用当日）
  clearScheduled?: true;    // tray：清空被拖任务自己行的 ⏳
}

export interface AreaBase {
  // Stable id for builtin areas, used to localize the title at render time
  // (builtin defaults are localized; user-set titles are shown verbatim).
  id?: string;
  title?: string;
  weight?: number;
  onDrop?: DropEffect;
}

// list / grid 共享字段：when 收窄、排序、限制。list 没有内部分组——多段（如
// 今日）用 col 容器叠多个各自带 when 的 list area 表达，不是一个 list 内部分组。
export interface ListLikeFields {
  when?: QueryPresetFilters;
  orderBy?: string[];
  limit?: number;
  emptyText?: string;
}

// list：渲染一列任务卡。今日 = col 叠 3 个 list area（逾期 / 今日 / 未排期），
// 每个 area 自带 when、各自 filter 自己；与 TODO 同组件、看起来一样。
export interface ListAreaConfig extends AreaBase, ListLikeFields {
  type: "list";
}

// grid：与 list 同配置、同投影，但卡片以响应式多列网格排列（未排期 tray 用）。
export interface GridAreaConfig extends AreaBase, ListLikeFields {
  type: "grid";
}

export interface WeekAreaConfig extends AreaBase {
  type: "week";
  // US-109z2: date areas carry their own `when` too, so filtering is always
  // per-area (there is no tab-level base filter anymore). e.g. a week view that
  // only shows todo tasks sets `when: { status: ["todo"] }`.
  when?: QueryPresetFilters;
  firstDayOfWeek?: "monday" | "sunday";
}

export interface MonthAreaConfig extends AreaBase {
  type: "month";
  when?: QueryPresetFilters;
  firstDayOfWeek?: "monday" | "sunday";
  density?: "compact" | "cards";
}

// drop：纯动作落区，无 query；onDrop 必填。放弃区就是 drop area。
export interface DropAreaConfig extends AreaBase {
  type: "drop";
  onDrop: DropEffect;
}

// unknown：归一化时遇到不认识的 area.type 时的兜底。保留原始类型字符串与
// 原始 JSON，视图层渲染成「未知类型 + JSON」，而不是静默退化或丢弃。
export interface UnknownAreaConfig extends AreaBase {
  type: "unknown";
  rawType: string;
  raw: unknown;
}

export type AreaConfig =
  | ListAreaConfig
  | GridAreaConfig
  | WeekAreaConfig
  | MonthAreaConfig
  | DropAreaConfig
  | UnknownAreaConfig;

// US-109z2: area *behaviour* / capabilities (rendersTasks / filterable /
// editable / acceptsDrop / icon / label) live in the AreaHandler class
// hierarchy in `areas.ts`, keyed by type. types.ts stays pure data so the DSL
// serializes cleanly. See `areas.ts` for `areaHandler()` / `areaSupportsWhen()`.

export interface StackConfig {
  dir: "row" | "col"; // row ≈ HStack，col ≈ VStack
  weight?: number;
  children: LayoutNode[];
}

export type LayoutNode = StackConfig | AreaConfig;

export function isStackNode(node: LayoutNode): node is StackConfig {
  return (node as StackConfig).dir !== undefined && Array.isArray((node as StackConfig).children);
}

export interface QueryPresetViewConfig {
  layout: LayoutNode; // 根节点：可以是 Stack，也可以直接是单个 area
}

// US-109z2: a tab has NO tab-level filter. All filtering lives on each area's
// `when` (list / grid / week / month). `QueryPresetFilters` survives only as the
// shape of an area's `when`.
export interface QueryPreset {
  id: string;
  name: string;
  builtin: boolean;
  hidden: boolean;
  view: QueryPresetViewConfig;
}

export type QueryPresetSection = "filters" | "view";

export interface QueryPresetValidationError {
  section: QueryPresetSection;
  code: string;
  message: string;
}

export interface QueryPresetValidationResult {
  valid: boolean;
  errors: QueryPresetValidationError[];
}

export const DEFAULT_SETTINGS: TaskCenterSettings = {
  queryPresets: [],
  deletedBuiltinIds: [],
  defaultSavedViewId: null,
  defaultView: "week",
  openOnStartup: false,
  weekStartsOn: 1,
  stampCreated: true,
  taskFormatFlavor: "tasks",
  lastTab: null,
  lastSavedViewId: null,
  mobileLongPressMs: 500,
  mobileSwipeEnabled: true,
  mobileForceLayout: false,
};

export const VIEW_TYPE_TASK_CENTER = "task-center-board";
