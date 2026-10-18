// Unit tests for VAL-CORE-008: View projection does not own business collections.
// List/week/month project the same filtered task set into per-area models.
// Today/TODO/Unscheduled/Completed/Dropped are QueryPresets, not view types.
//
// The view model is now a SwiftUI-style layout tree (row/col stacks of area
// leaves); each area projects independently via a per-area projector. The old
// single-view `applyViewProjection` is gone.
//
//   - projectListArea(tasks, ListAreaConfig, weekStartsOn)
//   - projectWeekArea(tasks, WeekAreaConfig, weekStartsOn, anchorISO)
//   - projectMonthArea(tasks, MonthAreaConfig, anchorISO)
//
// Trays are no longer embedded in week/month projections; a tray is a separate
// list area in the layout. We model "tray" behavior by projecting a list area
// whose `when` selects unscheduled tasks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/query/projection.ts",
      "--bundle=true",
      "--format=esm",
      "--platform=node",
      "--outdir=test/.compiled",
      "--loader:.ts=ts",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild compile failed:\n" + result.stderr);
  }
}

let compileErr = null;
try {
  compilePure();
} catch (e) {
  compileErr = e;
}

// ── Helpers ──

function effectiveTask(overrides = {}) {
  const base = {
    id: "test.md:L1",
    path: "test.md",
    line: 0,
    indent: "",
    checkbox: " ",
    status: "todo",
    title: "Test task",
    rawTitle: "Test task",
    rawLine: "- [ ] Test task",
    tags: [],
    scheduled: null,
    deadline: null,
    start: null,
    completed: null,
    cancelled: null,
    created: null,
    recurrence: null,
    priority: null,
    calloutDepth: 0,
    inlineFields: {},
    durationFields: {},
    estimate: null,
    actual: null,
    parentLine: null,
    parentIndex: null,
    childrenLines: [],
    hash: "abcdef123456",
    mtime: 1000,
    inheritsTerminal: false,
    inheritedTerminalKind: null,
    effectiveStatus: "todo",
    effectiveScheduled: null,
    effectiveDeadline: null,
    effectiveCreated: null,
    terminalInheritedFrom: null,
    renderParentId: null,
    isTopLevelInQuery: true,
    ...overrides,
  };
  return base;
}

// ── VAL-CORE-008: List projection ──

test("VAL-CORE-008: list area — all tasks in a flat list", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", title: "Task B", effectiveScheduled: null }),
    effectiveTask({ id: "test.md:L3", title: "Task C", effectiveScheduled: "2026-05-05" }),
  ];

  const model = projectListArea(tasks, { type: "list" }, 1);
  assert.equal(model.type, "list");
  assert.ok(Array.isArray(model.tasks), "list model is a flat task array");
  assert.equal(model.tasks.length, 3);
});

test("VAL-CORE-008: list area — tasks sorted by orderBy", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "ZZZ Task", effectiveScheduled: null }),
    effectiveTask({ id: "test.md:L2", title: "AAA Task", effectiveScheduled: null }),
    effectiveTask({ id: "test.md:L3", title: "MMM Task", effectiveScheduled: null }),
  ];

  const model = projectListArea(
    tasks,
    { type: "list", orderBy: ["title_asc"] },
    1,
  );
  assert.equal(model.tasks[0].title, "AAA Task");
  assert.equal(model.tasks[1].title, "MMM Task");
  assert.equal(model.tasks[2].title, "ZZZ Task");
});

test("VAL-CORE-008: list area — limit caps task count", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A" }),
    effectiveTask({ id: "test.md:L2", title: "Task B" }),
    effectiveTask({ id: "test.md:L3", title: "Task C" }),
    effectiveTask({ id: "test.md:L4", title: "Task D" }),
  ];

  const model = projectListArea(tasks, { type: "list", limit: 2 }, 1);
  assert.equal(model.tasks.length, 2, "List limited to 2 tasks");
});

// ── US-153: just-completed exemption threads through area.when ──

test("US-153: projectListArea exempts just-completed ids from area when.status", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Active", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L2", title: "Just done", effectiveStatus: "done" }),
    effectiveTask({ id: "test.md:L3", title: "Old done", effectiveStatus: "done" }),
  ];

  const model = projectListArea(
    tasks,
    { type: "list", when: { status: ["todo"] } },
    1,
    new Set(["test.md:L2"]),
  );
  assert.deepEqual(model.tasks.map((t) => t.id), ["test.md:L1", "test.md:L2"]);
});

// ── List area as "tray": unscheduled filter ──
// Trays are no longer embedded in week/month projections. A tray is just a list
// area whose `when` selects unscheduled tasks. This replaces the old
// `view.tray` assertions.

test("M2: list area — unscheduled when filter selects only unscheduled tasks (tray semantics)", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04", title: "Scheduled" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, title: "Unscheduled" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: null, title: "Also unscheduled" }),
  ];

  // The tray area: list with when:{time:{scheduled:"unscheduled"}}
  const tray = projectListArea(
    tasks,
    {
      type: "list",
      title: "未排期",
      when: { time: { scheduled: "unscheduled" } },
    },
    1,
  );

  assert.equal(tray.type, "list");
  assert.equal(tray.tasks.length, 2, "Tray has the 2 unscheduled tasks");
  const trayIds = tray.tasks.map((t) => t.id).sort();
  assert.deepEqual(trayIds, ["test.md:L2", "test.md:L3"]);
});

test("M2: list area — tray with extra filter (unscheduled + tag)", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04", title: "Scheduled" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, tags: ["#work"], title: "Unscheduled work" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: null, tags: ["#personal"], title: "Unscheduled personal" }),
  ];

  const tray = projectListArea(
    tasks,
    {
      type: "list",
      title: "未排期工作",
      when: { time: { scheduled: "unscheduled" }, tags: { expr: "#work" } },
    },
    1,
  );

  assert.equal(tray.tasks.length, 1, "Only 1 task matches tray filter");
  assert.equal(tray.tasks[0].id, "test.md:L2");
});

// ── VAL-CORE-008: Week projection ──

test("VAL-CORE-008: week area — 7 day columns with tasks grouped by effectiveScheduled", async () => {
  if (compileErr) throw compileErr;

  const { projectWeekArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }), // Monday
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-04" }), // Monday
    effectiveTask({ id: "test.md:L3", effectiveScheduled: "2026-05-06" }), // Wednesday
    effectiveTask({ id: "test.md:L4", effectiveScheduled: "2026-05-10" }), // Sunday
    effectiveTask({ id: "test.md:L5", effectiveScheduled: null }),          // unscheduled — not in any column
  ];

  const model = projectWeekArea(
    tasks,
    { type: "week" },
    1,
    "2026-05-04",
  );

  assert.equal(model.type, "week");
  assert.ok(Array.isArray(model.days));
  assert.equal(model.days.length, 7);

  // Monday (2026-05-04) should have 2 tasks
  const monday = model.days[0];
  assert.equal(monday.date, "2026-05-04");
  assert.equal(monday.tasks.length, 2);

  // Wednesday (2026-05-06) should have 1 task
  const wednesday = model.days[2];
  assert.equal(wednesday.date, "2026-05-06");
  assert.equal(wednesday.tasks.length, 1);

  // Total tasks in columns = 4 (null-scheduled task excluded; week area has no tray)
  const totalInColumns = model.days.reduce((sum, d) => sum + d.tasks.length, 0);
  assert.equal(totalInColumns, 4);
});

test("VAL-CORE-008: week area — respects weekStartsOn=0 (Sunday)", async () => {
  if (compileErr) throw compileErr;

  const { projectWeekArea } = await import("../test/.compiled/projection.js");

  // 2026-05-04 is Monday. With weekStartsOn=0 (Sunday), the week starts on May 3.
  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-03" }), // Sunday
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-04" }), // Monday
  ];

  const model = projectWeekArea(tasks, { type: "week" }, 0, "2026-05-04");

  assert.equal(model.days[0].date, "2026-05-03");
  assert.equal(model.days[0].tasks.length, 1);
  assert.equal(model.days[1].date, "2026-05-04");
  assert.equal(model.days[1].tasks.length, 1);
});

test("VAL-CORE-008: week area — does not embed unscheduled tasks (no tray)", async () => {
  if (compileErr) throw compileErr;

  const { projectWeekArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null }),
  ];

  const model = projectWeekArea(tasks, { type: "week" }, 1, "2026-05-04");

  // Week area only renders day columns; unscheduled tasks live in a separate
  // list area, not inside the week model.
  assert.equal(model.days[0].tasks.length, 1, "Scheduled task in Monday column");
  assert.equal("tray" in model, false, "Week area produces no tray");
  const totalInColumns = model.days.reduce((sum, d) => sum + d.tasks.length, 0);
  assert.equal(totalInColumns, 1, "Unscheduled task is not in any day column");
});

// ── VAL-CORE-008: Month projection ──

test("VAL-CORE-008: month area — calendar grid with tasks per date", async () => {
  if (compileErr) throw compileErr;

  const { projectMonthArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-01" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-15" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: "2026-05-31" }),
  ];

  const model = projectMonthArea(
    tasks,
    { type: "month" },
    "2026-05-04",
  );

  assert.equal(model.type, "month");
  assert.ok(Array.isArray(model.cells));

  // Find cells with tasks
  const populatedCells = model.cells.filter((c) => c.tasks.length > 0);
  assert.equal(populatedCells.length, 3);
});

test("VAL-CORE-008: month area — empty cells still have date", async () => {
  if (compileErr) throw compileErr;

  const { projectMonthArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-01" }),
  ];

  const model = projectMonthArea(tasks, { type: "month" }, "2026-05-04");

  // May 2026 has 31 days. Cells should cover the full month.
  assert.ok(model.cells.length >= 28, "At least 28 cells for a month");
  // Each cell has a date property
  for (const cell of model.cells) {
    assert.ok(cell.date, "Each cell has a date");
  }
});

test("VAL-CORE-008: month area — does not embed unscheduled tasks (no tray)", async () => {
  if (compileErr) throw compileErr;

  const { projectMonthArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-01", title: "In month" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, title: "Unscheduled" }),
  ];

  const model = projectMonthArea(tasks, { type: "month" }, "2026-05-04");

  // Month area only renders date cells; unscheduled tasks live in a separate
  // list area, not inside the month model.
  assert.equal("tray" in model, false, "Month area produces no tray");
  const totalInCells = model.cells.reduce((sum, c) => sum + c.tasks.length, 0);
  assert.equal(totalInCells, 1, "Only the scheduled task is placed in a cell");
});

// ── VAL-CORE-008: Same tasks projected to different areas ──

test("VAL-CORE-008: same filtered tasks projected to list, week, month produce different models", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea, projectWeekArea, projectMonthArea } =
    await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-05" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: null }),
  ];

  const listModel = projectListArea(tasks, { type: "list" }, 1);
  const weekModel = projectWeekArea(tasks, { type: "week" }, 1, "2026-05-04");
  const monthModel = projectMonthArea(tasks, { type: "month" }, "2026-05-04");
  // The "tray" is a separate list area selecting unscheduled tasks.
  const trayModel = projectListArea(
    tasks,
    { type: "list", when: { time: { scheduled: "unscheduled" } } },
    1,
  );

  assert.equal(listModel.type, "list");
  assert.equal(weekModel.type, "week");
  assert.equal(monthModel.type, "month");

  // List contains all 3 tasks in its flat task list
  const listTaskIds = listModel.tasks.map((t) => t.id).sort();
  assert.deepEqual(listTaskIds, ["test.md:L1", "test.md:L2", "test.md:L3"]);

  // Week contains 2 scheduled in day columns; the tray area carries the 1 unscheduled
  const weekTaskIds = weekModel.days
    .flatMap((d) => d.tasks)
    .concat(trayModel.tasks)
    .map((t) => t.id)
    .sort();
  assert.deepEqual(weekTaskIds, ["test.md:L1", "test.md:L2", "test.md:L3"]);

  // Month contains 2 scheduled in cells; the tray area carries the 1 unscheduled
  const monthTaskIds = monthModel.cells
    .flatMap((c) => c.tasks)
    .concat(trayModel.tasks)
    .map((t) => t.id)
    .sort();
  assert.deepEqual(monthTaskIds, ["test.md:L1", "test.md:L2", "test.md:L3"]);
});

test("M2: tray list area and week area partition tasks without overlap", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea, projectWeekArea } =
    await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04", title: "In week" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, title: "Unscheduled" }),
  ];

  const week = projectWeekArea(tasks, { type: "week" }, 1, "2026-05-04");
  const tray = projectListArea(
    tasks,
    { type: "list", title: "未排期", when: { time: { scheduled: "unscheduled" } } },
    1,
  );

  // Week area has the scheduled task in Monday
  assert.equal(week.days[0].tasks.length, 1);
  assert.equal(week.days[0].tasks[0].id, "test.md:L1");

  // Tray (unscheduled list) has only the unscheduled task; no overlap with week
  const trayIds = tray.tasks.map((t) => t.id);
  assert.ok(!trayIds.includes("test.md:L1"), "Tray excludes scheduled task");
  assert.ok(trayIds.includes("test.md:L2"), "Tray includes unscheduled task");
});

// ── Negative / edge cases ──

test("list area — when matching no tasks produces an empty list", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A", tags: [] }),
  ];

  const model = projectListArea(
    tasks,
    { type: "list", when: { tags: { expr: "#nonexistent" } } },
    1,
  );

  assert.equal(model.tasks.length, 0, "List is empty when no tasks match the area filter");
});

// ── US-109x: AREA-LEVEL `when` (the thing the area editor edits) ──
// Regression repro for the e2e failure: editing an area's own `when` (not a
// section's) must filter the area's cards. The existing tests only covered
// section-level `when`; the area-level `when.tags` path was uncovered.
test("US-109x: area-level when {tags} filters the area's own cards", async () => {
  const { projectListArea } = await import("../test/.compiled/projection.js");
  const tasks = [
    effectiveTask({ id: "Inbox.md:L1", title: "alpha", tags: ["#alpha"] }),
    effectiveTask({ id: "Inbox.md:L2", title: "beta", tags: ["#beta"] }),
  ];
  const model = projectListArea(tasks, { type: "list", when: { tags: { expr: "#alpha" } } }, 1);
  const ids = model.tasks.map((t) => t.id);
  assert.deepEqual(ids, ["Inbox.md:L1"], "area.when {tags:#alpha} keeps L1, drops L2(#beta)");
});

test("US-109h: area-level when {status} filters the area's own cards", async () => {
  const { projectListArea } = await import("../test/.compiled/projection.js");
  const tasks = [
    effectiveTask({ id: "Inbox.md:L1", title: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "Inbox.md:L2", title: "done", effectiveStatus: "done" }),
  ];
  const todoOnly = projectListArea(tasks, { type: "list", when: { status: ["todo"] } }, 1);
  assert.deepEqual(
    todoOnly.tasks.map((t) => t.id),
    ["Inbox.md:L1"],
    "area.when {status:[todo]} drops the done card",
  );
  const both = projectListArea(tasks, { type: "list", when: { status: ["todo", "done"] } }, 1);
  assert.equal(
    both.tasks.length,
    2,
    "area.when {status:[todo,done]} keeps both",
  );
});

// US-720d2: 全空布局不再折叠成一个 view 级居中空状态（areasAllEmpty 已删除）——
// 每个 area 各自渲染各自的空状态。对应的视图层行为由 today-view.e2e.ts /
// four-quadrant 的 e2e 守。

test("US-720b: limit counts top-level cards and retains the filtered total", async () => {
  const { projectListArea } = await import("./.compiled/projection.js");
  const tasks = [effectiveTask({ id: "parent" }), effectiveTask({ id: "child", isTopLevelInQuery: false, renderParentId: "parent" }), effectiveTask({ id: "other" })];
  const model = projectListArea(tasks, { type: "list", limit: 1 }, 1);
  assert.equal(model.total, 2);
  assert.deepEqual(model.tasks.map(t => t.id), ["parent", "child"]);
  assert.deepEqual(model.tasks.filter(t => t.isTopLevelInQuery).map(t => t.id), ["parent"]);
  const all = projectListArea(tasks, { type: "list" }, 1);
  assert.equal(all.total, 2);
  assert.equal(all.tasks.length, 3);
});

test("US-720b: an area promotes a matching child when its parent is filtered out", async () => {
  const { projectListArea } = await import("./.compiled/projection.js");
  const model = projectListArea([
    effectiveTask({ id: "parent", title: "excluded" }),
    effectiveTask({ id: "child", title: "match", isTopLevelInQuery: false, renderParentId: "parent" }),
  ], { type: "list", when: { search: "match" }, limit: 1 }, 1);
  assert.equal(model.total, 1);
  assert.equal(model.tasks[0].isTopLevelInQuery, true);
});


test("US-720b: factory recommendation includes future deadlines, excludes overdue and sorts deadline then created", async () => {
  const { readFile } = await import("node:fs/promises");
  const preset = JSON.parse(await readFile(new URL("../src/builtin-views/today.json", import.meta.url), "utf8"));
  const area = preset.view.layout.children.find(a => a.id === "unscheduled-rec");
  const { projectListArea } = await import("./.compiled/projection.js");
  const model = projectListArea([
    effectiveTask({ id: "none" }),
    effectiveTask({ id: "future-old", effectiveDeadline: "2099-01-01", effectiveCreated: "2020-01-01" }),
    effectiveTask({ id: "future-new", effectiveDeadline: "2099-01-01", effectiveCreated: "2026-01-01" }),
    effectiveTask({ id: "overdue", effectiveDeadline: "2000-01-01" }),
    effectiveTask({ id: "scheduled", effectiveScheduled: "2099-01-01" }),
    effectiveTask({ id: "done", effectiveStatus: "done" }),
  ], { ...area, limit: undefined }, 1);
  assert.deepEqual(model.tasks.map(t => t.id), ["future-new", "future-old", "none"]);
});
