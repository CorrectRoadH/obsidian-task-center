// Pure calendar grid math for the week / month renderers — no DOM, no view
// state (REFACTOR.md / ARCHITECTURE §7.6: clean first extraction toward the
// CalendarRenderPort split). Unit-testable in isolation.

import { addDays, daysBetween, startOfWeek, startOfMonth, endOfMonth } from "../../dates";
import { formatMinutes } from "../../parser";
import type { ParsedTask } from "../../types";

// US-116: per-column header line "N · XhYm" — task count plus the summed
// `[estimate::]` minutes (omitted when zero).
export function columnStats(tasks: ParsedTask[]): string {
  const sum = tasks.reduce((s, t) => s + (t.estimate ?? 0), 0);
  if (sum === 0) return `${tasks.length}`;
  return `${tasks.length} · ${formatMinutes(sum)}`;
}

// US-115 / US-515: condensed calendars still expose deadline risk even
// though full cards live only in the selected-day outline.
export function deadlineRiskStats<T extends {
  effectiveDeadline: string | null;
  effectiveStatus: string;
}>(tasks: T[], today: string): { overdue: number; nearDeadline: number } {
  let overdue = 0;
  let nearDeadline = 0;
  for (const task of tasks) {
    if (task.effectiveStatus !== "todo" || !task.effectiveDeadline) continue;
    const delta = daysBetween(today, task.effectiveDeadline);
    if (delta < 0) overdue += 1;
    else if (delta <= 3) nearDeadline += 1;
  }
  return { overdue, nearDeadline };
}

// Bucket tasks by their effective `⏳` day in ONE pass. The week / month
// renderers previously ran `tasks.filter(t => t.effectiveScheduled === day)`
// once per rendered day (7× for week, up to 42× for month) — an O(days × N)
// sweep that added up on mobile. Tasks failing `accept` or without a
// scheduled day are skipped; per-day order preserves the input order.
export function bucketByScheduledDay<T extends { effectiveScheduled: string | null }>(
  tasks: T[],
  accept: (t: T) => boolean,
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const t of tasks) {
    if (!t.effectiveScheduled || !accept(t)) continue;
    const bucket = buckets.get(t.effectiveScheduled);
    if (bucket) bucket.push(t);
    else buckets.set(t.effectiveScheduled, [t]);
  }
  return buckets;
}

// The 7 ISO days of the week containing `anchorISO`, aligned to `weekStartsOn`.
export function buildWeekDays(anchorISO: string, weekStartsOn: 0 | 1): string[] {
  const weekStart = startOfWeek(anchorISO, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

// The month grid: week-aligned cells covering `anchorISO`'s month, up to 42 but
// trimmed once the month's last day is covered (≥ 28 cells, full weeks only).
export function buildMonthGrid(
  anchorISO: string,
  weekStartsOn: 0 | 1,
): { first: string; last: string; gridStart: string; gridDays: string[] } {
  const first = startOfMonth(anchorISO);
  const last = endOfMonth(anchorISO);
  const gridStart = startOfWeek(first, weekStartsOn);
  const gridDays: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    gridDays.push(d);
    if (i >= 27 && d > last) break;
  }
  return { first, last, gridStart, gridDays };
}
