import type { SavedTaskView, SavedViewStatus, SavedViewTimeFilters } from "./types";

export interface SavedViewFilters {
  search: string;
  tag: string;
  time: SavedViewTimeFilters;
  status: SavedViewStatus;
}

export interface AppliedSavedViewFilters extends SavedViewFilters {
  savedViewId: string | null;
}

export function createSavedView(
  name: string,
  filters: SavedViewFilters,
  makeId: () => string = defaultSavedViewId,
): SavedTaskView {
  return {
    id: makeId(),
    name: name.trim(),
    search: filters.search.trim(),
    tag: filters.tag.trim(),
    time: normalizeTimeFilters(filters.time),
    status: filters.status,
  };
}

export function upsertSavedView(views: readonly SavedTaskView[], view: SavedTaskView): SavedTaskView[] {
  return [
    ...views.filter((existing) => existing.name !== view.name),
    view,
  ];
}

export function updateSavedViewById(views: readonly SavedTaskView[], view: SavedTaskView): SavedTaskView[] {
  return views.map((existing) => existing.id === view.id ? view : existing);
}

export function applySavedViewFilters(view: SavedTaskView): AppliedSavedViewFilters {
  return {
    savedViewId: view.id,
    search: view.search,
    tag: view.tag,
    time: normalizeTimeFilters(view.time),
    status: view.status,
  };
}

export function clearSavedViewFilters(): AppliedSavedViewFilters {
  return {
    savedViewId: null,
    search: "",
    tag: "",
    time: {},
    status: "all",
  };
}

export function hasSavedViewFilters(filters: SavedViewFilters): boolean {
  return !!(
    filters.search.trim()
    || filters.tag.trim()
    || Object.values(normalizeTimeFilters(filters.time)).some(Boolean)
    || filters.status !== "all"
  );
}

export function suggestSavedViewName(filters: Pick<SavedViewFilters, "tag" | "status">, fallback: string): string {
  if (filters.tag.trim()) return filters.tag.trim().replace(/^#/, "");
  if (filters.status !== "all") return filters.status;
  return fallback;
}

function normalizeTimeFilters(time: SavedViewTimeFilters): SavedViewTimeFilters {
  const out: SavedViewTimeFilters = {};
  for (const [key, value] of Object.entries(time) as Array<[keyof SavedViewTimeFilters, string | undefined]>) {
    const trimmed = value?.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

function defaultSavedViewId(): string {
  return `sv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
