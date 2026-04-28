import { addDays, endOfMonth, startOfMonth, startOfWeek, todayISO } from "./dates";

function isISODate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function taskMatchesScheduleToken(
  scheduled: string | null | undefined,
  token: string,
  weekStartsOn: 0 | 1,
  today: string = todayISO(),
): boolean {
  const value = token.trim();
  if (!value || value === "all") return true;
  if (!scheduled) return false;

  if (value === "today") return scheduled === today;
  if (value === "tomorrow") return scheduled === addDays(today, 1);
  if (value === "week") {
    const start = startOfWeek(today, weekStartsOn);
    const end = addDays(start, 6);
    return scheduled >= start && scheduled <= end;
  }
  if (value === "next-week") {
    const start = addDays(startOfWeek(today, weekStartsOn), 7);
    const end = addDays(start, 6);
    return scheduled >= start && scheduled <= end;
  }
  if (value === "month") {
    const start = startOfMonth(today);
    const end = endOfMonth(today);
    return scheduled >= start && scheduled <= end;
  }
  if (value.includes("..")) {
    const [from, to] = value.split("..", 2);
    return (!from || scheduled >= from) && (!to || scheduled <= to);
  }
  if (isISODate(value)) return scheduled === value;
  return false;
}
