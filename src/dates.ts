export function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export function todayISO(): string {
  return toISO(new Date());
}

// US-411: ISO write side — every persisted date emits `YYYY-MM-DD`
// regardless of the user's display locale. Display-side localization
// happens in src/view.ts:weekdayLabel; the file representation must
// stay locale-stable so other Obsidian plugins (Tasks, Dataview) keep
// reading the same byte shape.
// see USER_STORIES.md
export function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  return new Date(y, m - 1, d);
}

export function isValidISO(s: string | null | undefined): boolean {
  if (!s) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && toISO(fromISO(s)) === s;
}

export function addDays(iso: string, days: number): string {
  const d = fromISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

export function shiftMonth(iso: string, months: number): string {
  const d = fromISO(iso);
  const origDay = d.getDate();
  d.setDate(1); // avoid end-of-month rollover (e.g. Jan 31 + 1 month = Mar 3)
  d.setMonth(d.getMonth() + months);
  // Clamp to last day of target month when original day doesn't exist
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(origDay, lastDay));
  return toISO(d);
}

// US-112: weekStart 0 = Sunday-first (US style), 1 = Monday-first (ISO,
// default). Threaded through all week-aware logic (renderWeek column
// order, week dwell, "this week" filter etc.) — settings.weekStartsOn
// is the single source of truth.
// see USER_STORIES.md
export function startOfWeek(iso: string, weekStart: 0 | 1 = 1): string {
  const d = fromISO(iso);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = (day - weekStart + 7) % 7;
  d.setDate(d.getDate() - diff);
  return toISO(d);
}

export function endOfWeek(iso: string, weekStart: 0 | 1 = 1): string {
  return addDays(startOfWeek(iso, weekStart), 6);
}

export function startOfMonth(iso: string): string {
  const d = fromISO(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function endOfMonth(iso: string): string {
  const d = fromISO(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export function daysBetween(a: string, b: string): number {
  const da = fromISO(a).getTime();
  const db = fromISO(b).getTime();
  return Math.round((db - da) / (1000 * 60 * 60 * 24));
}

export function isoWeekNumber(iso: string): number {
  const d = fromISO(iso);
  d.setHours(0, 0, 0, 0);
  // Shift to Thursday of the current ISO week — that Thursday's year is the ISO week-year.
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return (
    1 +
    Math.round(
      ((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7,
    )
  );
}

// US-207: CLI / API natural-language schedule keywords. Range accepts:
//   today / tomorrow / yesterday / week / next-week / month / next-month
//   / YYYY-MM-DD / FROM..TO. "unscheduled" is a schedule state, not a range.
// see USER_STORIES.md
export function resolveWhen(
  when: string,
  today: string = todayISO(),
  weekStart: 0 | 1 = 1,
): { from?: string; to?: string; exact?: string; unscheduled?: boolean } {
  const w = when.toLowerCase().trim();
  if (w === "today") return { exact: today };
  if (w === "tomorrow") return { exact: addDays(today, 1) };
  if (w === "yesterday") return { exact: addDays(today, -1) };
  if (w === "unscheduled") return { unscheduled: true };
  if (w === "week") return { from: startOfWeek(today, weekStart), to: endOfWeek(today, weekStart) };
  if (w === "next-week") {
    const s = addDays(startOfWeek(today, weekStart), 7);
    return { from: s, to: addDays(s, 6) };
  }
  if (w === "month") return { from: startOfMonth(today), to: endOfMonth(today) };
  if (w === "next-month") {
    const d = fromISO(today);
    const ns = toISO(new Date(d.getFullYear(), d.getMonth() + 1, 1));
    return { from: ns, to: endOfMonth(ns) };
  }
  // Range: FROM..TO
  if (w.includes("..")) {
    const parts = w.split("..");
    const from = resolveDateInput(parts[0], today);
    const to = parts.length === 2 ? resolveDateInput(parts[1], today) : undefined;
    if (from && to && from <= to) return { from, to };
  } else {
    const exact = resolveDateInput(w, today);
    if (exact) return { exact };
  }
  throw Object.assign(new Error(`invalid when: ${when}`), { code: "invalid_date" });
}

const ZH_DAYS: Record<string, number> = {
  周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 0, 周天: 0,
  星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6, 星期日: 0, 星期天: 0,
};

/** Returns an ISO string, or null for blank, or undefined for invalid input. */
export function resolveDateInput(raw: string, today: string = todayISO()): string | null | undefined {
  const s = raw.trim();
  if (s === "") return null;
  const lc = s.toLowerCase();
  if (lc === "today" || s === "今天" || s === "今日") return today;
  if (lc === "tomorrow" || s === "明天" || s === "明日") return addDays(today, 1);
  if (lc === "yesterday" || s === "昨天" || s === "昨日") return addDays(today, -1);
  if (s === "后天") return addDays(today, 2);
  if (lc === "next-week" || s === "下周") return addDays(today, 7);
  if (s in ZH_DAYS) {
    const target = ZH_DAYS[s];
    const d = fromISO(today);
    const cur = d.getDay();
    const diff = (target - cur + 7) % 7 || 7;
    return addDays(today, diff);
  }
  if (isValidISO(s)) return s;
  return undefined;
}
