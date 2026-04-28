import { addDays, endOfMonth, startOfMonth, startOfWeek, todayISO } from "./dates";
import type { SavedViewTimeField } from "./types";

function isISODate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function taskMatchesTimeToken(
  value: string | null | undefined,
  token: string,
  weekStartsOn: 0 | 1,
  today: string = todayISO(),
): boolean {
  const filter = token.trim();
  if (!filter || filter === "all") return true;
  if (!value) return false;

  if (filter === "overdue") return value < today;
  if (filter === "next-7-days") return value >= today && value <= addDays(today, 7);
  if (filter === "today") return value === today;
  if (filter === "tomorrow") return value === addDays(today, 1);
  if (filter === "week") {
    const start = startOfWeek(today, weekStartsOn);
    const end = addDays(start, 6);
    return value >= start && value <= end;
  }
  if (filter === "next-week") {
    const start = addDays(startOfWeek(today, weekStartsOn), 7);
    const end = addDays(start, 6);
    return value >= start && value <= end;
  }
  if (filter === "month") {
    const start = startOfMonth(today);
    const end = endOfMonth(today);
    return value >= start && value <= end;
  }
  if (filter.includes("..")) {
    const [from, to] = filter.split("..", 2);
    return (!from || value >= from) && (!to || value <= to);
  }
  if (isISODate(filter)) return value === filter;
  return false;
}

export function timeTokenAppliesToField(field: SavedViewTimeField, token: string): boolean {
  const value = token.trim();
  if (!value) return true;
  if ((value === "overdue" || value === "next-7-days") && field !== "deadline") return false;
  return true;
}
