// Query schema primitives shared by the pure query pipeline (filter / projection)
// and the upper QueryPreset store. Status normalization lives HERE — not in
// saved-views — so the query layer never has to import up into the persistence
// layer: the dependency points saved-views → query/schema, never the reverse.
// (ARCHITECTURE.md §2.1 依赖规则; REFACTOR.md D5)

import type { TaskStatus } from "../types";
import { parseTagExpr, tagSelectionToExpr } from "./tag-expr";

export const KNOWN_STATUS_VALUES: TaskStatus[] = [
  "todo",
  "done",
  "dropped",
  "in_progress",
  "cancelled",
  "custom",
];

export function isKnownTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (KNOWN_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * Extract a tag filter's parts from any accepted DSL shape. US-109d4 unifies tag
 * filtering on a boolean expression; the legacy three-state shapes are still
 * accepted as input and surfaced here so callers can convert them to one:
 *   - `string[]`                  → include AND, no exclude (back-compat)
 *   - comma-separated `string`    → include AND, no exclude (back-compat)
 *   - `{ values, mode, exclude }` → US-109d3 three-state; `expr` stays null
 *   - `{ expr }`                  → US-109d4 expression; values/exclude empty
 * Values are returned verbatim; empty / malformed input degrades to the AND-empty
 * default with `expr: null`.
 */
export function resolveTagFilter(
  tags: unknown,
): { values: string[]; mode: "and" | "or"; exclude: string[]; expr: string | null } {
  if (!tags) return { values: [], mode: "and", exclude: [], expr: null };
  if (Array.isArray(tags)) {
    return { values: tags.filter((t): t is string => typeof t === "string"), mode: "and", exclude: [], expr: null };
  }
  if (typeof tags === "string") {
    return { values: tags.split(",").map((t) => t.trim()).filter(Boolean), mode: "and", exclude: [], expr: null };
  }
  if (typeof tags === "object") {
    const obj = tags as { values?: unknown; mode?: unknown; exclude?: unknown; expr?: unknown };
    if (typeof obj.expr === "string" && obj.expr.trim()) {
      return { values: [], mode: "and", exclude: [], expr: obj.expr };
    }
    const values = Array.isArray(obj.values)
      ? obj.values.filter((t): t is string => typeof t === "string")
      : [];
    const exclude = Array.isArray(obj.exclude)
      ? obj.exclude.filter((t): t is string => typeof t === "string")
      : [];
    return { values, mode: obj.mode === "or" ? "or" : "and", exclude, expr: null };
  }
  return { values: [], mode: "and", exclude: [], expr: null };
}

/**
 * US-109d4: the single canonical view of a tag filter — a boolean expression
 * string. `{ expr }` is returned verbatim; any legacy three-state / array shape
 * is converted to the equivalent expression. Empty filter → "".
 */
export function tagsToExpr(tags: unknown): string {
  const r = resolveTagFilter(tags);
  if (r.expr !== null) return r.expr;
  return tagSelectionToExpr(r.values, r.mode, r.exclude);
}

/**
 * Normalize a raw `status` filter into the canonical form: "all" or a deduped
 * list of known TaskStatus values (an empty / all-unknown list → "all").
 */
export function normalizeQueryStatus(status: unknown): "all" | TaskStatus[] {
  if (!status || status === "all") return "all";
  const raw: unknown[] = Array.isArray(status) ? status : [status];
  const seen = new Set<TaskStatus>();
  const out: TaskStatus[] = [];
  for (const value of raw) {
    if (!isKnownTaskStatus(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.length > 0 ? out : "all";
}


/** US-219: strict input validation, separate from forgiving stored-data normalization. */
export interface QueryFieldIssue { field: string; rule: string; position?: number }

export function isQueryDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validTimeToken(field: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const token = value.trim();
  if (["", "all", "unscheduled", "today", "tomorrow", "week", "next-week", "month"].includes(token)) return true;
  if (["overdue", "not-overdue", "next-7-days"].includes(token)) return field === "deadline";
  if (isQueryDate(token)) return true;
  const range = token.split("..");
  return range.length === 2 && Boolean(range[0] || range[1])
    && range.every(v => !v || isQueryDate(v))
    && (!range[0] || !range[1] || range[0] <= range[1]);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateAreaWhen(raw: unknown): QueryFieldIssue[] {
  if (!record(raw)) return [{ field: "", rule: "object" }];
  const issues: QueryFieldIssue[] = [];
  const issue = (field: string, rule: string) => { issues.push({ field, rule }); };
  for (const key of Object.keys(raw)) {
    if (!["search", "tags", "status", "time"].includes(key)) issue(key, "unsupported");
  }
  if (raw.search !== undefined && typeof raw.search !== "string") issue("search", "string");
  if (raw.status !== undefined && raw.status !== "all") {
    const values = Array.isArray(raw.status) ? raw.status : [raw.status];
    if (!values.every(isKnownTaskStatus)) issue("status", "status");
  }
  if (raw.time !== undefined) {
    if (!record(raw.time)) issue("time", "object");
    else for (const [field, token] of Object.entries(raw.time)) {
      if (!["scheduled", "deadline", "completed", "created", "dropped"].includes(field)) issue(`time.${field}`, "unsupported");
      else if (!validTimeToken(field, token)) issue(`time.${field}`, "date");
    }
  }
  if (raw.tags !== undefined) {
    const tags = raw.tags;
    const tagList = (value: unknown): boolean => Array.isArray(value)
      && value.every(t => typeof t === "string" && /^#?[^\s()#]+$/.test(t.trim()));
    if (Array.isArray(tags)) {
      if (!tagList(tags)) issue("tags", "tags");
    } else if (typeof tags === "string") {
      if (tags.trim() && !tagList(tags.split(",").map(t => t.trim()))) issue("tags", "tags");
    } else if (record(tags)) {
      if ("expr" in tags) {
        if (Object.keys(tags).some(k => k !== "expr")) issue("tags", "tags");
        if (typeof tags.expr !== "string") issue("tags.expr", "string");
        else if (tags.expr.trim()) {
          const parsed = parseTagExpr(tags.expr);
          if (parsed.error) issues.push({ field: "tags.expr", rule: "expression", position: parsed.position });
        }
      } else {
        if (Object.keys(tags).some(k => !["values", "mode", "exclude"].includes(k))) issue("tags", "tags");
        if (tags.values !== undefined && !tagList(tags.values)) issue("tags.values", "tags");
        if (tags.exclude !== undefined && !tagList(tags.exclude)) issue("tags.exclude", "tags");
        if (tags.mode !== undefined && tags.mode !== "and" && tags.mode !== "or") issue("tags.mode", "tagMode");
      }
    } else issue("tags", "tags");
  }
  return issues;
}

export function validateAreaDrop(type: string, raw: unknown): QueryFieldIssue[] {
  if (!record(raw) || Object.keys(raw).length !== 1) return [{ field: "onDrop", rule: "dropAction" }];
  if (type === "drop") {
    return raw.setStatus === "dropped" ? [] : [{ field: "onDrop", rule: "abandonOnly" }];
  }
  if (type !== "list" && type !== "grid") return [{ field: "onDrop", rule: "unsupported" }];
  if ("setStatus" in raw && (raw.setStatus === "done" || raw.setStatus === "dropped")) return [];
  if (raw.clearScheduled === true) return [];
  if (typeof raw.setScheduled === "string") {
    const token = raw.setScheduled.trim();
    if (["today", "tomorrow", "next-week"].includes(token) || isQueryDate(token)) return [];
  }
  return [{ field: `onDrop.${Object.keys(raw)[0]}`, rule: "dropAction" }];
}
