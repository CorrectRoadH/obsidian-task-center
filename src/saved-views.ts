import type {
  AreaBase,
  AreaConfig,
  DropEffect,
  GridAreaConfig,
  LayoutNode,
  ListAreaConfig,
  QueryPreset,
  QueryPresetFilters,
  QueryPresetValidationError,
  QueryPresetValidationResult,
  QueryPresetViewConfig,
  QueryTray,
  QueryViewType,
  QueryStatus,
  QueryTimeFilters,
  StackConfig,
  TaskStatus,
} from "./types";
import { BUILTIN_VIEW_DATA } from "./builtin-views/index";
// US-109z2 / REFACTOR.md D5: status schema lives in the query layer so the pure
// query pipeline (filter / projection) never imports up into saved-views.
// Re-exported here for the view layer's existing import sites.
import { KNOWN_STATUS_VALUES, normalizeQueryStatus, resolveTagFilter, tagsToExpr } from "./query/schema";
export { normalizeQueryStatus, resolveTagFilter, tagsToExpr };
const BUILTIN_QUERY_TABS = ["today", "week", "month", "todo", "unscheduled", "completed", "dropped"] as const;
type BuiltinQueryTab = typeof BUILTIN_QUERY_TABS[number];

export const BUILTIN_SAVED_VIEW_IDS: Record<BuiltinQueryTab, string> = {
  today: "preset-today",
  week: "preset-week",
  month: "preset-month",
  todo: "preset-todo",
  unscheduled: "preset-unscheduled",
  completed: "preset-completed",
  dropped: "preset-dropped",
};

const DEFAULT_BUILTIN_LABELS: Record<BuiltinQueryTab, string> = {
  today: "Today",
  week: "Week",
  month: "Month",
  todo: "TODO",
  unscheduled: "Unscheduled",
  completed: "Completed",
  dropped: "Dropped",
};

export interface SavedViewFilters {
  search: string;
  tag: string;
  time: QueryTimeFilters;
  status: QueryStatus;
  view?: QueryPresetViewConfig;
}

export interface AppliedSavedViewFilters extends SavedViewFilters {
  savedViewId: string | null;
}

export function builtinSavedViewId(tab: BuiltinQueryTab): string {
  return BUILTIN_SAVED_VIEW_IDS[tab];
}

export function builtinSavedViewIdForLegacyTab(tab: string | null | undefined): string | null {
  if (!tab || !(tab in BUILTIN_SAVED_VIEW_IDS)) return null;
  return BUILTIN_SAVED_VIEW_IDS[tab as BuiltinQueryTab];
}

export function isBuiltinSavedViewId(id: string): boolean {
  return Object.values(BUILTIN_SAVED_VIEW_IDS).includes(id);
}

export function builtinSavedViewKind(id: string): BuiltinQueryTab | null {
  return BUILTIN_QUERY_TABS.find((tab) => BUILTIN_SAVED_VIEW_IDS[tab] === id) ?? null;
}

export function createSavedViewId(): string {
  return defaultSavedViewId();
}

function normalizeQueryViewType(type: string | null | undefined): QueryViewType {
  return type === "week" || type === "month" ? type : "list";
}

function normalizeTimeFilters(time: unknown): QueryTimeFilters {
  const raw = isRecord(time) ? time : {};
  const out: QueryTimeFilters = {};
  for (const key of ["scheduled", "deadline", "completed", "created"] as const) {
    const value = raw[key];
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) out[key] = trimmed;
  }
  return out;
}


function defaultSavedViewId(): string {
  return `sv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function seededBuiltinQueryPreset(tab: BuiltinQueryTab, name: string): QueryPreset {
  const data = BUILTIN_VIEW_DATA[tab] ?? BUILTIN_VIEW_DATA.unscheduled;
  // JSON imports infer wide literal types; normalizeQueryPreset validates the
  // shape at runtime, so cast through unknown.
  return normalizeQueryPreset({ ...data, name } as unknown as QueryPreset);
}

function parseDslRoot(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`DSL 当前只支持 JSON，解析失败：${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("DSL 根节点必须是对象。");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function booleanOrFallback(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const LEGACY_QUERY_DSL_ERROR =
  "无效 Query DSL：检测到 Task Center 1.0 前的旧 DSL。1.0 已移除 tab 级 filters / summary / view.type；请更新 skill：npx skills add CorrectRoadH/obsidian-task-center，并改用 view.layout + 每个 area 自己的 when。";

// ── QueryPreset DSL — canonical model (VAL-CORE-005, VAL-CORE-006, VAL-CROSS-002) ──

/**
 * Normalize a QueryPreset: ensure required fields, trim strings,
 * normalize status/tags/time, coerce view type.
 */
export function normalizeQueryPreset(raw: QueryPreset): QueryPreset {
  const view = normalizeQueryPresetView(raw.view);
  return {
    id: (typeof raw.id === "string" ? raw.id.trim() : "") || defaultSavedViewId(),
    name: (typeof raw.name === "string" ? raw.name.trim() : "") || "Query",
    builtin: !!raw.builtin,
    hidden: !!raw.hidden,
    view,
  };
}

function normalizeQueryPresetFilters(raw: unknown): QueryPresetFilters {
  const filters = isRecord(raw) ? raw : {};
  const search = typeof filters.search === "string" ? filters.search.trim() : "";
  // US-109d4: tags 统一迁移成单一 { expr } 形态——任何旧形态（裸数组 / 逗号串 /
  // 三态 { values, mode, exclude }）在归一化时一次性转成等价表达式字符串，求值层
  // 只认 { expr }。这是旧 data.json 的迁移点：加载即升级，落库即 canonical。
  const tagExpr = tagsToExpr(filters.tags).trim();
  const status = normalizeQueryStatus(filters.status);
  const time = normalizeTimeFilters(filters.time);
  const out: QueryPresetFilters = {};
  if (search) out.search = search;
  if (tagExpr) out.tags = { expr: tagExpr };
  out.status = status;
  if (Object.keys(time).length > 0) out.time = time;
  return out;
}

function queryFiltersHaveActiveConditions(filters: QueryPresetFilters): boolean {
  return !!(
    filters.search
    // US-109d4: tag 活跃 = 迁移后的表达式非空（裸数组 / 三态 / { expr } 都覆盖）。
    || tagsToExpr(filters.tags).trim()
    || (filters.status !== undefined && filters.status !== "all")
    || (filters.time && Object.keys(filters.time).length > 0)
  );
}

function mergeQueryFilters(base: QueryPresetFilters, local: QueryPresetFilters | undefined): QueryPresetFilters {
  const normalizedBase = normalizeQueryPresetFilters(base);
  const normalizedLocal = normalizeQueryPresetFilters(local);
  if (!queryFiltersHaveActiveConditions(normalizedBase)) return normalizedLocal;
  if (!queryFiltersHaveActiveConditions(normalizedLocal)) return normalizedBase;

  const out: QueryPresetFilters = { ...normalizedLocal };
  if (normalizedBase.search && !normalizedLocal.search) out.search = normalizedBase.search;

  // US-109d4: 合并 base + local 的标签过滤——各自转表达式，用 AND 连接（都非空时
  // 各加括号保优先级），收敛进同一个 { expr }。
  const baseExpr = tagsToExpr(normalizedBase.tags).trim();
  const localExpr = tagsToExpr(normalizedLocal.tags).trim();
  if (baseExpr && localExpr) {
    out.tags = { expr: `(${baseExpr}) and (${localExpr})` };
  } else if (baseExpr || localExpr) {
    out.tags = { expr: baseExpr || localExpr };
  }

  if (normalizedBase.status !== "all" && normalizedLocal.status === "all") {
    out.status = normalizedBase.status;
  }
  if (normalizedBase.time || normalizedLocal.time) {
    out.time = { ...(normalizedBase.time ?? {}), ...(normalizedLocal.time ?? {}) };
  }
  return normalizeQueryPresetFilters(out);
}

function applyBaseFiltersToLayout(layout: LayoutNode, filters: QueryPresetFilters): LayoutNode {
  if (!queryFiltersHaveActiveConditions(filters)) return layout;
  if (isStackLayout(layout)) {  // fix-forward：本地类型守卫（原提交误用了未导入的 isStackNode）
    const out: StackConfig = {
      ...layout,
      children: layout.children.map((child) => applyBaseFiltersToLayout(child, filters)),
    };
    return out;
  }
  switch (layout.type) {
    case "list":
    case "grid":
    case "week":
    case "month":
      return { ...layout, when: mergeQueryFilters(filters, layout.when) };
    case "drop":
    case "unknown":
      return layout;
  }
}

// View 现在是一棵 area 布局树。normalize 同时接受新形状（{layout}）和
// 旧形状（{type, preset, sections, tray, matrix, orderBy}），旧形状一次性
// 迁移成 { layout }。preset 字段被丢弃。
function normalizeQueryPresetView(raw: unknown): QueryPresetViewConfig {
  const cfg = isRecord(raw) ? raw : {};
  if ("layout" in cfg) {
    return { layout: normalizeLayoutNode(cfg.layout) };
  }
  return { layout: migrateLegacyViewToLayout(cfg) };
}

function normalizeLayoutNode(raw: unknown): LayoutNode {
  if (isRecord(raw) && typeof raw.dir === "string" && Array.isArray(raw.children)) {
    const dir = raw.dir === "row" ? "row" : "col";
    const children = raw.children
      .map((c) => normalizeLayoutNode(c))
      .filter((c): c is LayoutNode => c !== null);
    const out: StackConfig = { dir, children: children.length > 0 ? children : [{ type: "list" }] };
    const weight = typeof raw.weight === "number" && raw.weight > 0 ? raw.weight : undefined;
    if (weight !== undefined) out.weight = weight;
    return out;
  }
  return normalizeArea(raw);
}

function normalizeDropEffect(raw: unknown): DropEffect | undefined {
  if (!isRecord(raw)) return undefined;
  const out: DropEffect = {};
  if (raw.setStatus === "dropped") out.setStatus = "dropped";
  if (typeof raw.setScheduled === "string" && raw.setScheduled.trim()) out.setScheduled = raw.setScheduled.trim();
  if (raw.clearScheduled === true) out.clearScheduled = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeArea(raw: unknown): AreaConfig {
  const cfg = isRecord(raw) ? raw : {};
  const type = typeof cfg.type === "string" ? cfg.type : "list";
  const id = typeof cfg.id === "string" && cfg.id.trim() ? cfg.id.trim() : undefined;
  const title = typeof cfg.title === "string" && cfg.title.trim() ? cfg.title.trim() : undefined;
  const weight = typeof cfg.weight === "number" && cfg.weight > 0 ? cfg.weight : undefined;
  const onDrop = normalizeDropEffect(cfg.onDrop);
  const base: AreaBase = {};
  if (id) base.id = id;
  if (title) base.title = title;
  if (weight !== undefined) base.weight = weight;
  if (onDrop) base.onDrop = onDrop;

  const orderBy = Array.isArray(cfg.orderBy)
    ? cfg.orderBy.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
    : undefined;

  // US-109z2: date areas carry their own `when` too (no tab-level filter).
  const dateWhen = isRecord(cfg.when) ? normalizeQueryPresetFilters(cfg.when) : undefined;
  switch (type) {
    case "week":
      return {
        ...base,
        type: "week",
        ...(dateWhen && Object.keys(dateWhen).length > 0 ? { when: dateWhen } : {}),
        ...(cfg.firstDayOfWeek === "monday" || cfg.firstDayOfWeek === "sunday" ? { firstDayOfWeek: cfg.firstDayOfWeek } : {}),
      };
    case "month":
      return {
        ...base,
        type: "month",
        ...(dateWhen && Object.keys(dateWhen).length > 0 ? { when: dateWhen } : {}),
        ...(cfg.firstDayOfWeek === "monday" || cfg.firstDayOfWeek === "sunday" ? { firstDayOfWeek: cfg.firstDayOfWeek } : {}),
        ...(cfg.density === "compact" || cfg.density === "cards" ? { density: cfg.density } : {}),
      };
    case "drop":
      return { ...base, type: "drop", onDrop: onDrop ?? { setStatus: "dropped" } };
    case "grid":
    case "list": {
      const when = isRecord(cfg.when) ? normalizeQueryPresetFilters(cfg.when) : undefined;
      const limit = typeof cfg.limit === "number" && cfg.limit > 0 ? cfg.limit : undefined;
      const emptyText = typeof cfg.emptyText === "string" && cfg.emptyText.trim() ? cfg.emptyText.trim() : undefined;
      const out: ListAreaConfig | GridAreaConfig = { ...base, type: type === "grid" ? "grid" : "list" };
      if (when && Object.keys(when).length > 0) out.when = when;
      if (orderBy && orderBy.length > 0) out.orderBy = orderBy;
      if (limit !== undefined) out.limit = limit;
      if (emptyText) out.emptyText = emptyText;
      return out;
    }
    default:
      // 不认识的 area.type（含已删除的 matrix）→ unknown area，保留原始 JSON
      // 供视图层渲染「未知类型 + JSON」，而不是静默退化成 list。
      return { ...base, type: "unknown", rawType: type, raw };
  }
}

// 旧形状 {type, preset, sections, tray, matrix, orderBy} → 布局树。
function migrateLegacyViewToLayout(cfg: Record<string, unknown>): LayoutNode {
  const type = normalizeQueryViewType(typeof cfg.type === "string" ? cfg.type : undefined);
  const orderBy = Array.isArray(cfg.orderBy)
    ? cfg.orderBy.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
    : undefined;
  const tray = isRecord(cfg.tray) ? normalizeQueryTray(cfg.tray) : undefined;

  let base: AreaConfig;
  if (type === "week") base = { type: "week" };
  else if (type === "month") base = { type: "month" };
  else {
    // Legacy `sections` are intentionally dropped: list no longer groups
    // internally. Legacy builtin layouts are seeded once by
    // migrateLegacyQueryPreset; modern saved layouts remain user-owned.
    const list: ListAreaConfig = { type: "list" };
    if (orderBy && orderBy.length > 0) list.orderBy = orderBy;
    base = list;
  }

  if (tray) {
    const trayArea: ListAreaConfig = {
      type: "list",
      id: "unscheduled-tray",
      title: tray.title,
      when: tray.filters,
      onDrop: { clearScheduled: true },
    };
    if (tray.orderBy && tray.orderBy.length > 0) trayArea.orderBy = tray.orderBy;
    return { dir: "col", children: [base, trayArea] };
  }
  return base;
}

function normalizeQueryTray(raw: unknown): QueryTray | undefined {
  const cfg = isRecord(raw) ? raw : {};
  const enabled = typeof cfg.enabled === "boolean" ? cfg.enabled : false;
  if (!enabled) return undefined;
  const title = typeof cfg.title === "string" ? cfg.title.trim() : "Tray";
  const filters: QueryPresetFilters = isRecord(cfg.filters) ? normalizeQueryPresetFilters(cfg.filters) : {};
  const orderBy: string[] | undefined = Array.isArray(cfg.orderBy)
    ? cfg.orderBy.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
    : undefined;
  const out: QueryTray = { enabled, title, filters };
  if (orderBy && orderBy.length > 0) out.orderBy = orderBy;
  return out;
}

// ── 布局树校验与遍历 ──
// 受支持的 area 类型：list / grid / week / month / drop。其它字符串 type 不
// 报错，归一化成 unknown area 后由视图层渲染「未知类型 + JSON」。

function validateLayoutNode(raw: unknown, errors: QueryPresetValidationError[], path: string): void {
  if (!isRecord(raw)) {
    errors.push({ section: "view", code: "invalid_layout", message: `${path} 必须是对象。` });
    return;
  }
  if ("dir" in raw || Array.isArray(raw.children)) {
    if (raw.dir !== "row" && raw.dir !== "col") {
      errors.push({ section: "view", code: "invalid_stack_dir", message: `${path}.dir 必须是 "row" 或 "col"。` });
    }
    if (!Array.isArray(raw.children) || raw.children.length === 0) {
      errors.push({ section: "view", code: "invalid_stack_children", message: `${path}.children 必须是非空数组。` });
    } else {
      raw.children.forEach((c, i) => validateLayoutNode(c, errors, `${path}.children[${i}]`));
    }
    return;
  }
  // area 叶子。type 缺失时归一化成 list；type 是字符串但不被支持时不报错——
  // 归一化会把它变成 unknown area，视图层渲染「未知类型 + JSON」。
  const type = raw.type;
  if (type !== undefined && typeof type !== "string") {
    errors.push({
      section: "view",
      code: "invalid_area_type",
      message: `${path}.type 必须是字符串。`,
    });
    return;
  }
  if (type === "drop" && !isRecord(raw.onDrop)) {
    errors.push({ section: "view", code: "drop_requires_on_drop", message: `${path} 的 drop area 必须有 onDrop。` });
  }
}

/** 深度优先收集布局树里所有 area 叶子（顺序 = 渲染顺序）。 */
export function collectAreas(layout: LayoutNode): AreaConfig[] {
  if (isStackLayout(layout)) {
    return layout.children.flatMap((c) => collectAreas(c));
  }
  return [layout];
}

function isStackLayout(node: LayoutNode): node is StackConfig {
  return (node as StackConfig).dir !== undefined && Array.isArray((node as StackConfig).children);
}

/** 布局里第一个匹配类型的 area，找不到返回 null。 */
export function findAreaByType<T extends AreaConfig["type"]>(
  layout: LayoutNode,
  type: T,
): Extract<AreaConfig, { type: T }> | null {
  for (const area of collectAreas(layout)) {
    if (area.type === type) return area as Extract<AreaConfig, { type: T }>;
  }
  return null;
}

/**
 * Validate a QueryPreset and return section-specific errors.
 * VAL-CORE-006: Errors point to `filters` or `view`.
 */
export function validateQueryPreset(raw: unknown): QueryPresetValidationResult {
  const errors: QueryPresetValidationError[] = [];

  if (!isRecord(raw)) {
    errors.push({ section: "filters", code: "not_object", message: "QueryPreset 根节点必须是对象。" });
    return { valid: false, errors };
  }

  // Name
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    errors.push({ section: "filters", code: "missing_name", message: "QueryPreset 缺少 name。" });
  }

  // Filters section
  const filters = raw.filters;
  if (filters !== undefined && !isRecord(filters)) {
    errors.push({ section: "filters", code: "invalid_filters", message: "filters 必须是对象。" });
  } else if (isRecord(filters)) {
    // Validate status
    if (filters.status !== undefined) {
      const rawStatus = filters.status;
      if (rawStatus !== "all" && !Array.isArray(rawStatus) && typeof rawStatus !== "string") {
        errors.push({
          section: "filters",
          code: "invalid_status",
          message: "status 值无效。允许: \"all\", \"todo\", \"done\", \"dropped\", 或其数组。",
        });
      } else if (typeof rawStatus === "string" && rawStatus !== "all") {
        // Single string status — validate it's a known value
        if (!KNOWN_STATUS_VALUES.includes(rawStatus as TaskStatus)) {
          errors.push({
            section: "filters",
            code: "invalid_status",
            message: `status 值 "${rawStatus}" 无效。允许: todo, done, dropped。`,
          });
        }
      } else if (Array.isArray(rawStatus)) {
        for (const s of rawStatus) {
          if (typeof s !== "string" || !KNOWN_STATUS_VALUES.includes(s as TaskStatus)) {
            errors.push({
              section: "filters",
              code: "invalid_status",
              message: `status 数组中包含无效值 "${String(s)}"。允许: todo, done, dropped。`,
            });
            break;
          }
        }
      }
    }
    // Validate tags
    if (filters.tags !== undefined) {
      if (!Array.isArray(filters.tags) && typeof filters.tags !== "string") {
        errors.push({
          section: "filters",
          code: "invalid_tags",
          message: "tags 必须是字符串或字符串数组。",
        });
      }
    }
    // Validate time
    if (filters.time !== undefined && !isRecord(filters.time)) {
      errors.push({
        section: "filters",
        code: "invalid_time",
        message: "time 必须是对象。",
      });
    }
    // Validate search
    if (filters.search !== undefined && typeof filters.search !== "string") {
      errors.push({
        section: "filters",
        code: "invalid_search",
        message: "search 必须是字符串。",
      });
    }
  }

  // View section — 新形状是一棵 area 布局树（view.layout）；旧形状
  // （view.type 等）仍可被接受并迁移，校验只对显式提供的字段把关。
  const view = raw.view;
  if (view !== undefined && !isRecord(view)) {
    errors.push({ section: "view", code: "invalid_view", message: "view 必须是对象。" });
  } else if (isRecord(view)) {
    if ("layout" in view) {
      validateLayoutNode(view.layout, errors, "view.layout");
    } else {
      // 旧形状兜底：仍校验 type 合法，以便给出清晰错误。
      const viewType = view.type;
      if (typeof viewType === "string" && !["list", "week", "month"].includes(viewType)) {
        errors.push({
          section: "view",
          code: "unknown_view_type",
          message: `未知 view.type "${viewType}"，允许: list, week, month。`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Detect whether an object is a legacy SavedTaskView (flat shape with top-level
 * `search` / `tag` / `time` / `status` rather than nested `filters`).
 * VAL-CORE-005 / VAL-CROSS-002: these are rejected during settings load.
 */
export function isLegacySavedTaskView(obj: unknown): boolean {
  if (!isRecord(obj)) return false;
  // A QueryPreset has `filters` as a nested object. Legacy SavedTaskView
  // has flat `search` / `tag` / `time` / `status` at top level.
  if (isRecord(obj.filters)) return false; // has nested filters → QueryPreset
  const hasFlatLegacyField =
    "search" in obj
    || "tag" in obj
    || "time" in obj
    || "status" in obj;
  // It might also have `id` and `name` (both models share these).
  return hasFlatLegacyField;
}

/**
 * US-414: detect whether a stored view object is in ANY legacy shape that
 * needs migrating to the current model. Two cases:
 *   1. legacy flat SavedTaskView (top-level search/tag/time/status), and
 *   2. an otherwise-modern QueryPreset (nested `filters`) whose `view` still
 *      uses the OLD DSL — `{type, preset, sections, tray, matrix}` instead of
 *      the current `{ layout }` tree.
 * Used to gate the full-view upgrade screen (US-415). The data transform is
 * idempotent: re-running detection on a normalized preset returns false.
 */
export function isLegacyQueryPresetShape(obj: unknown): boolean {
  if (!isRecord(obj)) return false;
  if (isLegacySavedTaskView(obj)) return true;
  // 只有「带实际条件」的 tab 级 filters 才需要迁移（下推进各 area 的 when）。
  // 空 filters（{} / {status:"all"}）不算 legacy，避免对新结构数据误弹迁移闸门。
  if (isRecord(obj.filters) && queryFiltersHaveActiveConditions(normalizeQueryPresetFilters(obj.filters))) return true;
  const view = obj.view;
  if (isRecord(view) && !("layout" in view)) {
    // Old view DSL hallmark keys. An empty `{}` view is not flagged — it
    // normalizes to a default layout without being "legacy".
    return (
      "type" in view
      || "preset" in view
      || "sections" in view
      || "tray" in view
      || "matrix" in view
    );
  }
  return false;
}

function isLegacyQueryDslInput(obj: unknown): boolean {
  if (!isRecord(obj)) return false;
  if (isLegacySavedTaskView(obj)) return true;
  if ("filters" in obj || "summary" in obj) return true;
  const view = obj.view;
  if (isRecord(view) && !("layout" in view)) {
    return (
      "type" in view
      || "preset" in view
      || "sections" in view
      || "tray" in view
      || "matrix" in view
    );
  }
  return false;
}

/**
 * US-414: migrate a legacy SavedTaskView (flat `search`/`tag`/`time`/`status`
 * + legacy `view: {type, preset, sections, tray, matrix}`) into a normalized
 * QueryPreset. Pure function — never throws on bad fields; everything degrades
 * to defaults via `normalizeQueryPreset`. Legacy tab-level filters are pushed
 * down into each task-rendering area's `when`; the legacy `view` shape is
 * handed to `normalizeQueryPresetView`, whose `migrateLegacyViewToLayout`
 * already turns `{type, preset, sections, tray, matrix}` into a `layout` tree.
 */
export function migrateLegacySavedTaskView(raw: unknown): QueryPreset {
  return migrateLegacyQueryPreset(raw);
}

export function migrateLegacyQueryPreset(raw: unknown): QueryPreset {
  const obj = isRecord(raw) ? raw : {};
  const filters: Record<string, unknown> = {};
  if (isRecord(obj.filters)) {
    Object.assign(filters, obj.filters);
  } else {
    if (typeof obj.search === "string") filters.search = obj.search;
    // Legacy `tag` is a comma-separated string; normalizeDslTags accepts it.
    if (typeof obj.tag === "string" || Array.isArray(obj.tag)) filters.tags = obj.tag;
    if ("status" in obj) filters.status = obj.status;
    if (isRecord(obj.time)) filters.time = obj.time;
  }
  const baseFilters = normalizeQueryPresetFilters(filters);
  const builtinKind = typeof obj.id === "string" ? builtinSavedViewKind(obj.id) : null;
  const legacyBuiltinView = builtinKind && !(isRecord(obj.view) && "layout" in obj.view)
    ? seededBuiltinQueryPreset(builtinKind, DEFAULT_BUILTIN_LABELS[builtinKind]).view
    : null;
  const normalized = normalizeQueryPreset({
    id: typeof obj.id === "string" ? obj.id : defaultSavedViewId(),
    name: typeof obj.name === "string" ? obj.name : "",
    builtin: !!obj.builtin,
    hidden: !!obj.hidden,
    // Old `view` is the legacy {type, preset, sections, tray, matrix} shape;
    // normalizeQueryPresetView migrates it to a layout tree.
    view: legacyBuiltinView ?? (isRecord(obj.view) ? obj.view : {}),
  } as unknown as QueryPreset);
  return normalizeQueryPreset({
    ...normalized,
    view: { layout: applyBaseFiltersToLayout(normalized.view.layout, baseFilters) },
  });
}

/**
 * Serialize a QueryPreset to JSON DSL string.
 */
export function stringifyQueryPreset(preset: QueryPreset): string {
  return JSON.stringify(normalizeQueryPreset(preset), null, 2);
}

/**
 * Parse a JSON DSL string into a normalized QueryPreset.
 */
export function parseQueryDsl(
  text: string,
  existing: Partial<Pick<QueryPreset, "id" | "name" | "builtin" | "hidden">> = {},
): QueryPreset {
  const raw = parseDslRoot(text);
  const base = "query" in raw && isRecord(raw.query) ? raw.query : raw;

  // US-217a: CLI / GUI DSL input must not accept pre-1.0 DSL emitted by old
  // agent skills. Stored data.json still migrates elsewhere; direct input is
  // rejected so old `filters` / `summary` / `view.type` fields are not silently
  // dropped into an accidental full-vault query.
  if (isLegacyQueryDslInput(base)) {
    throw new Error(LEGACY_QUERY_DSL_ERROR);
  }

  const name = stringOrFallback(base.name, existing.name ?? "");
  if (!name.trim()) {
    throw new Error("DSL 缺少 name。");
  }

  // VAL-CORE-006: validate raw input BEFORE normalization so invalid
  // values (e.g. unknown view type, bad tags, bad summary) are caught
  // rather than silently coerced to defaults.
  const validation = validateQueryPreset(base);
  if (!validation.valid) {
    const details = validation.errors
      .map((e) => `[${e.section}] ${e.code}: ${e.message}`)
      .join("；");
    throw new Error(`Query DSL 校验失败：${details}`);
  }

  return normalizeQueryPreset({
    id: stringOrFallback(base.id, existing.id ?? defaultSavedViewId()),
    name,
    builtin: booleanOrFallback(base.builtin, existing.builtin ?? false),
    hidden: booleanOrFallback(base.hidden, existing.hidden ?? false),
    view: isRecord(base.view) ? base.view : { layout: { type: "list" } },
  } as unknown as QueryPreset);
}

/**
 * Builtin QueryPreset factory — produces the 7 default presets
 * matching VAL-GUI-003: 今日, 本周, 本月, TODO, 未排期, 已完成, 已放弃.
 */
export function createBuiltinQueryPresets(
  labels: Partial<Record<BuiltinQueryTab, string>> = {},
): QueryPreset[] {
  return BUILTIN_QUERY_TABS.map((tab) =>
    seededBuiltinQueryPreset(tab, labels[tab] ?? DEFAULT_BUILTIN_LABELS[tab])
  );
}

// ── QueryPreset-native runtime helpers (VAL-CORE-005: no fromQueryPreset bridge) ──

/**
 * Ensure the 7 builtin QueryPreset tabs are present, preserving user
 * modifications and saved order. Only missing defaults are appended.
 * This is the QueryPreset-native replacement for `ensureBuiltinSavedViews`
 * — it does NOT call `fromQueryPreset`.
 */
export function ensureBuiltinQueryPresets(
  presets: readonly QueryPreset[],
  labels: Partial<Record<BuiltinQueryTab, string>> = {},
  deletedBuiltinIds: readonly string[] = [],
): QueryPreset[] {
  const tombstoned = new Set(deletedBuiltinIds);
  const existingIds = new Set(presets.map((p) => p.id));
  const out = presets.map((preset) => {
    const current = isLegacyQueryPresetShape(preset) ? migrateLegacyQueryPreset(preset) : preset;
    return normalizeQueryPreset({
      ...current,
      builtin: isBuiltinSavedViewId(current.id) || current.builtin,
    });
  });
  for (const tab of BUILTIN_QUERY_TABS) {
    const seeded = seededBuiltinQueryPreset(tab, labels[tab] ?? DEFAULT_BUILTIN_LABELS[tab]);
    if (!existingIds.has(seeded.id) && !tombstoned.has(seeded.id)) {
      out.push(seeded);
    }
  }
  return out;
}

export function restoreBuiltinQueryPresetById(
  presets: readonly QueryPreset[],
  id: string,
  labels: Partial<Record<BuiltinQueryTab, string>> = {},
  deletedBuiltinIds: readonly string[] = [],
): QueryPreset[] {
  const kind = builtinSavedViewKind(id);
  if (!kind) return [...presets];
  const seeded = seededBuiltinQueryPreset(kind, labels[kind] ?? DEFAULT_BUILTIN_LABELS[kind]);
  const index = presets.findIndex((p) => p.id === id);
  if (index === -1) {
    // US-109l: re-seed only this preset — keep any OTHER deleted presets gone by
    // passing the tombstone minus the id being restored.
    const remaining = deletedBuiltinIds.filter((x) => x !== id);
    return ensureBuiltinQueryPresets([...presets, seeded], labels, remaining);
  }
  return presets.map((p, i) => (i === index ? seeded : normalizeQueryPreset(p)));
}

export function restoreBuiltinQueryPresets(
  presets: readonly QueryPreset[],
  labels: Partial<Record<BuiltinQueryTab, string>> = {},
): QueryPreset[] {
  const customPresets = presets.filter((p) => !isBuiltinSavedViewId(p.id));
  return [...createBuiltinQueryPresets(labels), ...customPresets.map(normalizeQueryPreset)];
}

// US-109z2: a preset is identity + view only (no tab-level filters). Filter
// fields in `opts` are accepted for back-compat but ignored — filtering lives on
// each area's `when`.
export function createQueryPreset(
  name: string,
  opts: {
    search?: string;
    tags?: string[];
    time?: QueryTimeFilters;
    status?: QueryStatus;
    view?: QueryPresetViewConfig;
  },
  makeId: () => string = defaultSavedViewId,
): QueryPreset {
  return normalizeQueryPreset({
    id: makeId(),
    name: name.trim(),
    builtin: false,
    hidden: false,
    view: opts.view ?? { layout: { type: "list" } },
  });
}

export function upsertQueryPreset(presets: readonly QueryPreset[], preset: QueryPreset): QueryPreset[] {
  const normalized = normalizeQueryPreset(preset);
  const existingIndex = presets.findIndex((p) => p.id === normalized.id);
  if (existingIndex === -1) return [...presets, normalized];
  return presets.map((p) => (p.id === normalized.id ? normalized : p));
}

export function updateQueryPresetById(presets: readonly QueryPreset[], preset: QueryPreset): QueryPreset[] {
  const normalized = normalizeQueryPreset(preset);
  return presets.map((p) => (p.id === normalized.id ? normalized : p));
}

// US-109z2: presets have no tab-level filter, so the global filter state is
// always empty. This returns just the preset identity + view; the global filter
// fields stay empty (filtering is per-area `when`).
export function applyQueryPresetFilters(preset: QueryPreset): AppliedSavedViewFilters {
  const normalized = normalizeQueryPreset(preset);
  return {
    savedViewId: normalized.id,
    search: "",
    tag: "",
    time: {},
    status: "all",
    view: normalized.view,
  };
}

export function clearQueryPresetFilters(): AppliedSavedViewFilters {
  return {
    savedViewId: null,
    search: "",
    tag: "",
    time: {},
    status: "all",
    view: { layout: { type: "list" } },
  };
}

// US-109z2: presets never carry a tab-level filter anymore.
export function hasQueryPresetFilters(_preset: QueryPreset): boolean {
  return false;
}

export function suggestQueryPresetName(
  filters: { tags?: string[] | string; status?: QueryStatus },
  fallback: string,
): string {
  if (Array.isArray(filters.tags) && filters.tags.length > 0) {
    return filters.tags[0].replace(/^#/, "");
  }
  if (typeof filters.tags === "string" && filters.tags.trim()) {
    return filters.tags.trim().replace(/^#/, "");
  }
  const status = normalizeQueryStatus(filters.status);
  if (status !== "all") return status.join(",");
  return fallback;
}

export function visibleQueryPresets(presets: readonly QueryPreset[]): QueryPreset[] {
  return presets.map((p) => normalizeQueryPreset(p)).filter((p) => !p.hidden);
}

export function renameQueryPresetById(
  presets: readonly QueryPreset[],
  id: string,
  name: string,
): QueryPreset[] {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Query Tab 名称不能为空。");
  return presets.map((p) => (p.id === id ? normalizeQueryPreset({ ...p, name: trimmed }) : p));
}

export function deleteQueryPresetById(presets: readonly QueryPreset[], id: string): QueryPreset[] {
  return presets.filter((p) => p.id !== id);
}

export function setQueryPresetHiddenById(
  presets: readonly QueryPreset[],
  id: string,
  hidden: boolean,
): QueryPreset[] {
  return presets.map((p) => (p.id === id ? normalizeQueryPreset({ ...p, hidden }) : p));
}

export function duplicateQueryPreset(
  presets: readonly QueryPreset[],
  sourceId: string,
  name: string,
  makeId: () => string = defaultSavedViewId,
): QueryPreset {
  const source = presets.find((p) => p.id === sourceId);
  if (!source) throw new Error(`Query Tab 不存在：${sourceId}`);
  const normalized = normalizeQueryPreset(source);
  return normalizeQueryPreset({
    ...normalized,
    id: makeId(),
    name: name.trim(),
    builtin: false,
    hidden: false,
  });
}

export function moveQueryPresetById(
  presets: readonly QueryPreset[],
  id: string,
  direction: -1 | 1,
): QueryPreset[] {
  const index = presets.findIndex((p) => p.id === id);
  if (index === -1) return [...presets];
  const target = index + direction;
  if (target < 0 || target >= presets.length) return [...presets];
  const out = [...presets];
  const [item] = out.splice(index, 1);
  out.splice(target, 0, item);
  return out;
}

/**
 * 将指定 id 的 QueryPreset 移动到目标索引位置。
 * 拖动排序时需要将 tab 移到任意目标位置，而非仅 ±1 步。
 */
export function reorderQueryPresetById(
  presets: readonly QueryPreset[],
  id: string,
  targetIndex: number,
): QueryPreset[] {
  const index = presets.findIndex((p) => p.id === id);
  if (index === -1) return [...presets];
  if (index === targetIndex) return [...presets];
  const out = [...presets];
  const [item] = out.splice(index, 1);
  // targetIndex is the desired position in the original array;
  // after splice, indices shift so we clamp to valid range.
  const insertAt = Math.max(0, Math.min(targetIndex, out.length));
  out.splice(insertAt, 0, item);
  return out;
}

export function sameQueryPresetContent(a: QueryPreset, b: QueryPreset): boolean {
  const left = normalizeQueryPreset(a);
  const right = normalizeQueryPreset(b);
  return JSON.stringify({
    builtin: left.builtin,
    hidden: left.hidden,
    view: left.view,
  }) === JSON.stringify({
    builtin: right.builtin,
    hidden: right.hidden,
    view: right.view,
  });
}

// US-109z2: presets carry no tab-level tags anymore (filtering is per-area
// `when`). Kept as no-op stubs so call sites that seeded tag suggestions from
// the tab don't break; per-area tag candidates come from the visible tasks.
export function queryPresetTagString(_preset: QueryPreset): string {
  return "";
}

export function queryPresetTagsArray(_preset: QueryPreset): string[] {
  return [];
}

// ── VAL-GUI-004: delete undo plan / execute ──

/**
 * Snapshot-and-index plan used by deleteSavedViewWithConfirm (GUI) and
 * unit-testable without DOM.  `view` is normally a normalized copy from
 * visibleQueryTabs().
 */
export interface QueryPresetDeleteUndoPlan {
  snapshot: QueryPreset;
  originalIndex: number;
}

export function computeQueryPresetDeleteUndoPlan(
  presets: readonly QueryPreset[],
  view: QueryPreset,
): QueryPresetDeleteUndoPlan {
  return {
    snapshot: normalizeQueryPreset(view),
    originalIndex: presets.findIndex((p) => p.id === view.id),
  };
}

/**
 * Re-inserts the snapshot at `plan.originalIndex` (clamped to the current
 * array length) so undo restores the tab to its original position even when
 * other tabs were added/removed between delete and undo.
 */
export function executeQueryPresetDeleteUndo(
  presets: readonly QueryPreset[],
  plan: QueryPresetDeleteUndoPlan,
): QueryPreset[] {
  const result = [...presets];
  const insertIdx = Math.min(plan.originalIndex, result.length);
  result.splice(insertIdx, 0, plan.snapshot);
  return result;
}

// ── VAL-GUI-004: production-path delete-with-confirm-and-undo ──

/**
 * Injected callbacks for the delete-confirm-undo flow.
 *
 * Production (view.ts): `confirm` opens a Modal; `createUndoNotice` creates
 * a clickable Notice whose undo handler the caller wires to restore state.
 * Tests: inject stub spies to verify confirmation, deletion, and undo
 * without DOM dependencies.
 */
export interface QueryPresetDeleteFlowCallbacks {
  /** Show confirmation prompt. Return `true` to proceed with deletion. */
  confirm: (viewName: string) => Promise<boolean>;
  /**
   * Show undo toast with clickable undo action.
   * Returns a controller so the caller can wire state restoration.
   */
  createUndoNotice: (viewName: string, undoLabel: string) => QueryPresetDeleteUndoNotice;
  /** Show a success notice after undo completes. */
  showRestoredNotice: (viewName: string) => void;
}

/** Controller returned by `createUndoNotice` — caller wires the handler. */
export interface QueryPresetDeleteUndoNotice {
  /** Register the undo handler (called when user clicks undo). */
  onUndoClick: (handler: () => Promise<void>) => void;
  /** Hide the notice (e.g. after undo executes). */
  close: () => void;
}

export interface QueryPresetDeleteFlowResult {
  /** Whether the user confirmed the deletion */
  confirmed: boolean;
  /** The undo plan, or null if not confirmed */
  undoPlan: QueryPresetDeleteUndoPlan | null;
  /** Whether the deleted tab was the default */
  wasDefault: boolean;
  /** Whether the deleted tab was the active tab */
  wasActive: boolean;
  /** The presets array after deletion (same as before if cancelled) */
  presetsAfter: QueryPreset[];
  /** The undo notice controller, or null if not confirmed.
   *  Caller MUST wire `onUndoClick` to restore state. */
  undoNotice: QueryPresetDeleteUndoNotice | null;
}

/**
 * Execute the confirm-delete-notice production flow for a QueryPreset.
 *
 * This is the testable pure-logic counterpart of
 * `TaskCenterView.deleteSavedViewWithConfirm`.  The production view method
 * delegates here and wires the injected callbacks to Modal / Notice.
 *
 * The returned `undoNotice` controller MUST be wired by the caller:
 *
 * ```ts
 * result.undoNotice?.onUndoClick(async () => {
 *   // restore presets, default, active state
 *   result.undoNotice.close();
 * });
 * ```
 *
 * Tests can exercise the exact same confirm / delete / undo–restore logic
 * by passing stub callbacks.
 *
 * @param presets    Current QueryPreset array (settings.queryPresets).
 * @param view       The view to delete (normally a normalized copy from
 *                   visibleQueryTabs()).
 * @param defaultId  Current `defaultSavedViewId` setting.
 * @param activeId   Current active tab id (`state.savedViewId`).
 * @param callbacks  Injected Modal / Notice factories.
 */
export async function executeDeleteQueryPresetFlow(
  presets: QueryPreset[],
  view: QueryPreset,
  defaultId: string | null,
  activeId: string | null,
  callbacks: QueryPresetDeleteFlowCallbacks,
): Promise<QueryPresetDeleteFlowResult> {
  // Step 1 — confirmation (Modal in production)
  const confirmed = await callbacks.confirm(view.name);
  if (!confirmed) {
    return {
      confirmed: false,
      undoPlan: null,
      wasDefault: false,
      wasActive: false,
      presetsAfter: presets,
      undoNotice: null,
    };
  }

  // Step 2 — snapshot state before deletion
  const wasDefault = defaultId === view.id;
  const wasActive = activeId === view.id;
  const undoPlan = computeQueryPresetDeleteUndoPlan(presets, view);

  // Step 3 — delete (pure, no DOM)
  const presetsAfter = deleteQueryPresetById(presets, view.id);

  // Step 4 — show clickable undo notice (Notice in production)
  // The caller MUST wire `undoNotice.onUndoClick` to restore state.
  const undoNotice = callbacks.createUndoNotice(undoPlan.snapshot.name, "撤销");

  return {
    confirmed: true,
    undoPlan,
    wasDefault,
    wasActive,
    presetsAfter,
    undoNotice,
  };
}

// ── Production-path: delete + undo view state computation ──

/**
 * Post-delete state computed from a confirmed deletion flow result.
 * Pure — no DOM, no settings mutation.  The caller (view.ts) applies
 * these values to plugin settings and triggers save/render.
 */
export interface DeleteQueryPresetViewState {
  /** Presets array after deletion (same as result.presetsAfter). */
  presetsAfter: QueryPreset[];
  /** New defaultSavedViewId when the deleted tab was the default. */
  newDefaultId: string | null;
  /** Whether active tab should be switched. */
  shouldSwitchActive: boolean;
  /** The next visible tab to activate, or null. */
  nextActiveView: QueryPreset | null;
}

/**
 * Compute the state that should be applied to plugin settings immediately
 * after a confirmed deletion.  Pure — callers wire side effects.
 *
 * Used by `TaskCenterView.deleteSavedViewWithConfirm` to derive the
 * settings mutation from the flow result + visible tabs.
 */
export function computeDeleteQueryPresetState(params: {
  result: QueryPresetDeleteFlowResult;
  /** Visible (non-hidden) tabs BEFORE deletion. */
  visibleTabs: QueryPreset[];
  /** The view being deleted. */
  view: QueryPreset;
}): DeleteQueryPresetViewState {
  const presetsAfter = params.result.presetsAfter;
  let newDefaultId: string | null = null;
  let shouldSwitchActive = false;
  let nextActiveView: QueryPreset | null = null;

  if (params.result.wasDefault) {
    newDefaultId = params.visibleTabs.find((t) => t.id !== params.view.id)?.id ?? null;
  }
  if (params.result.wasActive) {
    shouldSwitchActive = true;
    nextActiveView = params.visibleTabs.find((t) => t.id !== params.view.id) ?? null;
  }

  return { presetsAfter, newDefaultId, shouldSwitchActive, nextActiveView };
}

/**
 * Post-undo state computed from the undo plan and current presets.
 * Pure — no DOM, no settings mutation.
 */
export interface UndoQueryPresetViewState {
  /** Presets array after re-inserting the snapshot. */
  presetsRestored: QueryPreset[];
  /** Restored defaultSavedViewId, or null. */
  restoredDefaultId: string | null;
  /** Whether the active tab should be restored. */
  shouldRestoreActive: boolean;
  /** The restored QueryPreset to activate, or null. */
  restoredView: QueryPreset | null;
}

/**
 * Compute the state that should be applied to plugin settings when the
 * user clicks the undo button.  Pure — callers wire side effects.
 *
 * Used by the undo handler inside `TaskCenterView.deleteSavedViewWithConfirm`.
 */
export function computeUndoQueryPresetState(params: {
  presets: readonly QueryPreset[];
  undoPlan: QueryPresetDeleteUndoPlan;
  wasDefault: boolean;
  wasActive: boolean;
}): UndoQueryPresetViewState {
  const presetsRestored = executeQueryPresetDeleteUndo(params.presets, params.undoPlan);

  let restoredDefaultId: string | null = null;
  let shouldRestoreActive = false;
  let restoredView: QueryPreset | null = null;

  if (params.wasDefault) {
    restoredDefaultId = params.undoPlan.snapshot.id;
  }
  if (params.wasActive) {
    restoredView = presetsRestored.find((p) => p.id === params.undoPlan.snapshot.id) ?? null;
    shouldRestoreActive = restoredView !== null;
  }

  return { presetsRestored, restoredDefaultId, shouldRestoreActive, restoredView };
}

// ── Query Editor production-path helpers ──

/**
 * Parameters for computing a QueryPreset snapshot that merges tabDrafts
 * into the saved preset identity.
 */
export interface ComputeQueryPresetSnapshotParams {
  /** The saved/existing preset (may be null for new drafts). */
  existing?: QueryPreset | null;
  /** The tabDrafts map (real Map<string, QueryPreset>). */
  tabDrafts: ReadonlyMap<string, QueryPreset>;
  /** Current search filter text. */
  filterSearch: string;
  /** Current tag filter string (comma-separated). */
  filterTags: string;
  /** Current time filters. */
  filterTime: QueryTimeFilters;
  /** Current status filter. */
  filterStatus: QueryStatus;
  /** Fallback view config when neither draft nor saved provides one. */
  fallbackView: () => QueryPresetViewConfig;
  /** Optional override for the snapshot name. */
  name?: string;
}

/**
 * Pure computation of a QueryPreset snapshot that merges tabDrafts
 * view into the saved preset identity.  This is the testable
 * counterpart of `TaskCenterView.currentQuerySnapshot`.
 *
 * Draft view wins over saved view.  All other fields come from the
 * explicit state parameters plus the saved preset identity
 * (id, name, builtin, hidden).
 */
export function computeQueryPresetSnapshot(params: ComputeQueryPresetSnapshotParams): QueryPreset {
  const { existing, tabDrafts, fallbackView, name } = params;
  // US-109z2: a preset is identity + view only; the filter* params are accepted
  // for back-compat but no longer contribute (filtering is per-area `when`).
  const tabDraft = existing ? tabDrafts.get(existing.id) : undefined;

  return normalizeQueryPreset({
    id: existing?.id ?? `draft-list`,
    name: (name ?? existing?.name ?? "").trim(),
    builtin: existing?.builtin ?? false,
    hidden: existing?.hidden ?? false,
    view: tabDraft?.view ?? existing?.view ?? fallbackView(),
  });
}

/**
 * Production-path helper: computes a save-as result from a snapshot +
 * draft state.  This is the testable counterpart of TaskCenterView's
 * `saveCurrentView` method.
 *
 * Returns the snapshot (what currentQuerySnapshot produced) and the
 * normalized preset that would be saved via upsertQueryPreset.
 */
export function computeSaveAsFromSnapshot(params: {
  getSnapshot: (existing: QueryPreset | null) => QueryPreset;
  savedPreset: QueryPreset | null;
  newId: string;
  name: string;
}): { snapshot: QueryPreset; saved: QueryPreset } {
  const { getSnapshot, savedPreset, newId, name } = params;
  const snapshot = getSnapshot(savedPreset);
  const saved = normalizeQueryPreset({
    ...snapshot,
    id: newId,
    name,
    builtin: false,
    hidden: false,
  });
  return { snapshot, saved };
}

/**
 * Production-path helper: computes an update result from a snapshot +
 * draft state.  This is the testable counterpart of TaskCenterView's
 * `updateCurrentSavedView` method.
 *
 * Reads view from the draft (via currentQueryPresetViewConfig equivalent)
 * and returns the normalized preset that would be saved via
 * updateQueryPresetById.
 */
export function computeUpdateFromDraftComponents(params: {
  /** The saved preset being updated in-place. */
  existing: QueryPreset;
  /** Draft view config (from currentQueryPresetViewConfig). */
  draftView: QueryPresetViewConfig;
}): QueryPreset {
  const { existing, draftView } = params;
  return normalizeQueryPreset({
    ...existing,
    view: draftView,
  });
}
