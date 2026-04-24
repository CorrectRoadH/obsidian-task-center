export function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export function todayISO(): string {
  return toISO(new Date());
}

export function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  return new Date(y, m - 1, d);
}

export function isValidISO(s: string | null | undefined): boolean {
  if (!s) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(fromISO(s).getTime());
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
  const range = w.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (range) return { from: range[1], to: range[2] };
  // Exact ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return { exact: w };
  throw new Error(`invalid when: ${when}`);
}
