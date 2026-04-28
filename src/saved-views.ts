import type { SavedTaskView, SavedViewStatus } from "./types";

export interface SavedViewFilters {
  search: string;
  tag: string;
  date: string;
  status: SavedViewStatus;
}

export interface AppliedSavedViewFilters extends SavedViewFilters {
  savedViewId: string | null;
  grouping: string;
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
    date: filters.date.trim(),
    status: filters.status,
    grouping: "",
  };
}

export function upsertSavedView(views: readonly SavedTaskView[], view: SavedTaskView): SavedTaskView[] {
  return [
    ...views.filter((existing) => existing.name !== view.name),
    view,
  ];
}

export function applySavedViewFilters(view: SavedTaskView): AppliedSavedViewFilters {
  return {
    savedViewId: view.id,
    search: view.search,
    tag: mergeLegacyGroupingTag(view.tag, view.grouping),
    date: view.date,
    status: view.status,
    grouping: "",
  };
}

export function clearSavedViewFilters(): AppliedSavedViewFilters {
  return {
    savedViewId: null,
    search: "",
    tag: "",
    date: "",
    status: "all",
    grouping: "",
  };
}

export function hasSavedViewFilters(filters: SavedViewFilters): boolean {
  return !!(
    filters.search.trim()
    || filters.tag.trim()
    || filters.date.trim()
    || filters.status !== "all"
  );
}

export function suggestSavedViewName(filters: Pick<SavedViewFilters, "tag" | "status">, fallback: string): string {
  if (filters.tag.trim()) return filters.tag.trim().replace(/^#/, "");
  if (filters.status !== "all") return filters.status;
  return fallback;
}

function mergeLegacyGroupingTag(tag: string, grouping: string): string {
  const parts = [tag, grouping].map((part) => part.trim()).filter(Boolean);
  return parts.join(",");
}

function defaultSavedViewId(): string {
  return `sv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
