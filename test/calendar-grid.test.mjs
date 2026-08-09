// Unit tests for src/view/render/calendar-grid.ts — pure calendar math extracted
// from the TaskCenterView god class (ARCHITECTURE §7.6 first clean extraction).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const r = spawnSync(
    "npx",
    [
      "esbuild",
      "src/view/render/calendar-grid.ts",
      "--bundle=true",
      "--format=esm",
      "--platform=node",
      "--outdir=test/.compiled",
      "--loader:.ts=ts",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error("esbuild compile failed:\n" + r.stderr);
}
compilePure();
const mod = () => import("../test/.compiled/calendar-grid.js");

test("US-116: columnStats — plain count when no card carries an estimate", async () => {
  const { columnStats } = await mod();
  assert.equal(columnStats([{ estimate: null }, { estimate: null }]), "2");
  assert.equal(columnStats([]), "0");
});

test("US-116: columnStats — `count · duration` when estimates sum > 0", async () => {
  const { columnStats } = await mod();
  const s = columnStats([{ estimate: 30 }, { estimate: 60 }]);
  assert.match(s, /^2 · /, "leads with the task count and a separator");
});

test("US-115/US-515: deadlineRiskStats reports active overdue and near-deadline tasks", async () => {
  const { deadlineRiskStats } = await mod();
  const stats = deadlineRiskStats([
    { effectiveStatus: "todo", effectiveDeadline: "2026-06-23" },
    { effectiveStatus: "todo", effectiveDeadline: "2026-06-24" },
    { effectiveStatus: "todo", effectiveDeadline: "2026-06-27" },
    { effectiveStatus: "todo", effectiveDeadline: "2026-06-28" },
    { effectiveStatus: "done", effectiveDeadline: "2026-06-20" },
    { effectiveStatus: "dropped", effectiveDeadline: "2026-06-25" },
    { effectiveStatus: "todo", effectiveDeadline: null },
  ], "2026-06-24");
  assert.deepEqual(stats, { overdue: 1, nearDeadline: 2 });
});

test("buildWeekDays — 7 consecutive ISO days aligned to weekStartsOn", async () => {
  const { buildWeekDays } = await mod();
  const days = buildWeekDays("2026-06-24", 1); // Wed; Monday-start week
  assert.equal(days.length, 7);
  assert.equal(days[0], "2026-06-22"); // Monday
  assert.equal(days[6], "2026-06-28"); // Sunday
});

// 移动端性能:周/月渲染改为一次分桶(bucketByScheduledDay),替代每天/每格
// 对全量任务的重复 filter(UX-mobile §13 性能预算)。桶内保序、跳过未排期与
// 未通过 accept 的任务——语义必须与旧的 per-day filter 完全一致。
test("bucketByScheduledDay — groups by effectiveScheduled, preserves order, honours accept", async () => {
  const { bucketByScheduledDay } = await mod();
  const tasks = [
    { id: "a", effectiveScheduled: "2026-07-01" },
    { id: "b", effectiveScheduled: "2026-07-02" },
    { id: "c", effectiveScheduled: "2026-07-01" },
    { id: "d", effectiveScheduled: null },
    { id: "e", effectiveScheduled: "2026-07-01" },
  ];
  const buckets = bucketByScheduledDay(tasks, (t) => t.id !== "c");
  assert.deepEqual(buckets.get("2026-07-01").map((t) => t.id), ["a", "e"], "filtered + in input order");
  assert.deepEqual(buckets.get("2026-07-02").map((t) => t.id), ["b"]);
  assert.equal(buckets.has("2026-07-03"), false, "days with no tasks have no bucket");
  assert.equal([...buckets.values()].flat().some((t) => t.id === "d"), false, "unscheduled tasks never bucket");
});

test("buildMonthGrid — week-aligned cells covering the whole month", async () => {
  const { buildMonthGrid } = await mod();
  const { first, last, gridStart, gridDays } = buildMonthGrid("2026-06-15", 1);
  assert.equal(first, "2026-06-01");
  assert.equal(last, "2026-06-30");
  assert.equal(gridDays[0], gridStart, "grid starts at the week-aligned start");
  assert.ok(gridDays.length >= 28 && gridDays.length <= 42, "full-week grid, trimmed");
  assert.ok(gridDays.includes("2026-06-15"), "covers the anchor day");
  assert.ok(gridDays.includes(last), "covers the month's last day");
});
