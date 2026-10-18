// Unit tests for VAL-CORE-007: Query filter execution and date token semantics.
// Filters apply to EffectiveTask[] using QueryPresetFilters.
// Search, tags, status, time fields work independently and correctly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/query/filter.ts",
      "--bundle",
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

// Compile first — the module doesn't exist yet (TDD red phase).
// We catch the compile error so the test framework can report it.
let compileErr = null;
try {
  compilePure();
} catch (e) {
  compileErr = e;
}

// ── Helpers to build EffectiveTask fixtures ──

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

// ── VAL-CORE-007: Search filter ──

test("VAL-CORE-007: search matches task title case-insensitively", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Write docs", rawTitle: "Write docs" }),
    effectiveTask({ id: "test.md:L2", title: "Fix bugs", rawTitle: "Fix bugs" }),
    effectiveTask({ id: "test.md:L3", title: "Review PRs", rawTitle: "Review PRs" }),
  ];

  const result = applyQueryFilters(tasks, { search: "docs" }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

test("VAL-CORE-007: search matches tags too", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A", tags: ["#work", "#urgent"] }),
    effectiveTask({ id: "test.md:L2", title: "Task B", tags: ["#personal"] }),
  ];

  const result = applyQueryFilters(tasks, { search: "work" }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

test("VAL-CORE-007: empty search returns all tasks", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1" }),
    effectiveTask({ id: "test.md:L2" }),
  ];

  const result = applyQueryFilters(tasks, { search: "" }, 1);
  assert.equal(result.length, 2);
});

// ── VAL-CORE-007: Tags filter (AND semantics) ──

test("VAL-CORE-007: tags AND — task must have ALL specified tags", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", tags: ["#work", "#urgent"] }),
    effectiveTask({ id: "test.md:L2", tags: ["#work"] }),
    effectiveTask({ id: "test.md:L3", tags: ["#urgent"] }),
    effectiveTask({ id: "test.md:L4", tags: [] }),
  ];

  const result = applyQueryFilters(tasks, { tags: { expr: "#work and #urgent" } }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

test("tags OR — expr '#a or #b' matches a task carrying ANY of the tags", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", tags: ["#work", "#urgent"] }),
    effectiveTask({ id: "test.md:L2", tags: ["#work"] }),
    effectiveTask({ id: "test.md:L3", tags: ["#urgent"] }),
    effectiveTask({ id: "test.md:L4", tags: ["#other"] }),
  ];

  const result = applyQueryFilters(tasks, { tags: { expr: "#work or #urgent" } }, 1);
  assert.deepEqual(result.map((t) => t.id), ["test.md:L1", "test.md:L2", "test.md:L3"]);
});

test("tags AND — expr '#a and #b' still requires ALL tags", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", tags: ["#work", "#urgent"] }),
    effectiveTask({ id: "test.md:L2", tags: ["#work"] }),
  ];

  const result = applyQueryFilters(tasks, { tags: { expr: "#work and #urgent" } }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

// ── US-109d4: tag exclude / boolean expression ──

test("US-109d4: exclude — 'not #x' filters out tasks carrying #x", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", tags: ["#work"] }),
    effectiveTask({ id: "test.md:L2", tags: ["#work", "#someday"] }),
    effectiveTask({ id: "test.md:L3", tags: ["#someday"] }),
    effectiveTask({ id: "test.md:L4", tags: [] }),
  ];

  // No include, only exclude: keep everything that does NOT carry #someday.
  const result = applyQueryFilters(tasks, { tags: { expr: "not #someday" } }, 1);
  assert.deepEqual(result.map((t) => t.id), ["test.md:L1", "test.md:L4"]);
});

test("US-109d4: include and not — '#a and not #b'", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", tags: ["#work"] }),
    effectiveTask({ id: "test.md:L2", tags: ["#work", "#someday"] }),
    effectiveTask({ id: "test.md:L3", tags: ["#home"] }),
  ];

  // Has #work, but not #someday.
  const result = applyQueryFilters(
    tasks,
    { tags: { expr: "#work and not #someday" } },
    1,
  );
  assert.deepEqual(result.map((t) => t.id), ["test.md:L1"]);
});

test("US-109d4: grouped or with not — '(#a or #b) and not #c'", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", tags: ["#work"] }),
    effectiveTask({ id: "test.md:L2", tags: ["#urgent", "#someday"] }),
    effectiveTask({ id: "test.md:L3", tags: ["#urgent"] }),
    effectiveTask({ id: "test.md:L4", tags: ["#other"] }),
  ];

  // (#work OR #urgent) AND NOT #someday → L1, L3 (L2 has #someday, L4 has neither include).
  const result = applyQueryFilters(
    tasks,
    { tags: { expr: "(#work or #urgent) and not #someday" } },
    1,
  );
  assert.deepEqual(result.map((t) => t.id), ["test.md:L1", "test.md:L3"]);
});

test("VAL-CORE-007: tags match is case-insensitive", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", tags: ["#Work"] }),
    effectiveTask({ id: "test.md:L2", tags: ["#work"] }),
  ];

  const result = applyQueryFilters(tasks, { tags: { expr: "#work" } }, 1);
  assert.equal(result.length, 2, "Both #Work and #work should match #work");
});

test("VAL-CORE-007: tags from comma-separated string", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", tags: ["#work", "#urgent"] }),
    effectiveTask({ id: "test.md:L2", tags: ["#work"] }),
  ];

  const result = applyQueryFilters(tasks, { tags: { expr: "#work and #urgent" } }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

test("VAL-CORE-007: no tags filter returns all tasks", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", tags: ["#work"] }),
    effectiveTask({ id: "test.md:L2", tags: [] }),
  ];

  const result = applyQueryFilters(tasks, {}, 1);
  assert.equal(result.length, 2);
});

// ── VAL-CORE-007: Status filter ──

test("VAL-CORE-007: status filter — multi-select", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", status: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L2", status: "done", effectiveStatus: "done" }),
    effectiveTask({ id: "test.md:L3", status: "dropped", effectiveStatus: "dropped" }),
  ];

  const result = applyQueryFilters(tasks, { status: ["todo", "done"] }, 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "test.md:L1");
  assert.equal(result[1].id, "test.md:L2");
});

test("VAL-CORE-007: status filter — single string", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", status: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L2", status: "done", effectiveStatus: "done" }),
  ];

  const result = applyQueryFilters(tasks, { status: "todo" }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

test("VAL-CORE-007: status filter — \"all\" returns all tasks", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", status: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L2", status: "done", effectiveStatus: "done" }),
  ];

  const result = applyQueryFilters(tasks, { status: "all" }, 1);
  assert.equal(result.length, 2);
});

// ── US-153: just-completed status-filter exemption ──

test("US-153: exemptStatusIds keeps a done task in a todo-status filter", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", status: "todo", effectiveStatus: "todo" }),
    // Just completed in this session — would normally be filtered out by status: todo.
    effectiveTask({ id: "test.md:L2", status: "done", effectiveStatus: "done" }),
    effectiveTask({ id: "test.md:L3", status: "done", effectiveStatus: "done" }),
  ];

  const exempt = new Set(["test.md:L2"]);
  const result = applyQueryFilters(tasks, { status: ["todo"] }, 1, undefined, exempt);
  // L1 (todo) stays, L2 (exempt done) stays, L3 (non-exempt done) is filtered out.
  assert.deepEqual(result.map((t) => t.id), ["test.md:L1", "test.md:L2"]);
});

test("US-153: exemptStatusIds only bypasses status, not other filters", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "alpha", status: "done", effectiveStatus: "done" }),
    effectiveTask({ id: "test.md:L2", title: "beta", status: "done", effectiveStatus: "done" }),
  ];

  // Both exempt from status, but a search filter must still apply.
  const exempt = new Set(["test.md:L1", "test.md:L2"]);
  const result = applyQueryFilters(tasks, { status: ["todo"], search: "alpha" }, 1, undefined, exempt);
  assert.deepEqual(result.map((t) => t.id), ["test.md:L1"]);
});

test("US-153: omitting exemptStatusIds preserves original status filtering", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", status: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L2", status: "done", effectiveStatus: "done" }),
  ];

  // No exempt set → done task is filtered out exactly as before.
  const result = applyQueryFilters(tasks, { status: ["todo"] }, 1);
  assert.deepEqual(result.map((t) => t.id), ["test.md:L1"]);
});

// ── VAL-CORE-007: Time filters — scheduled ──

test("VAL-CORE-007: time.scheduled=today filters by effective scheduled date", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-05" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: null }),
  ];

  const result = applyQueryFilters(tasks, { time: { scheduled: "today" } }, 1, "2026-05-04");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

test("VAL-CORE-007: time.scheduled=week matches current week", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  // 2026-05-04 is Monday. Week (Mon-first) is May 4-10.
  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-10" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: "2026-05-11" }),
  ];

  const result = applyQueryFilters(tasks, { time: { scheduled: "week" } }, 1, "2026-05-04");
  assert.equal(result.length, 2);
});

test("VAL-CORE-007: time.scheduled=unscheduled means effective scheduled is empty", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null }),
  ];

  const result = applyQueryFilters(tasks, { time: { scheduled: "unscheduled" } }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L2");
});

// ── VAL-CORE-007: Time filters — deadline (overdue) ──

test("VAL-CORE-007: time.deadline=overdue belongs to deadline field only", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveDeadline: "2026-05-01" }), // overdue
    effectiveTask({ id: "test.md:L2", effectiveDeadline: "2026-05-10" }), // not overdue
    effectiveTask({ id: "test.md:L3", effectiveDeadline: null }),
  ];

  const result = applyQueryFilters(tasks, { time: { deadline: "overdue" } }, 1, "2026-05-04");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

test("VAL-CORE-007: overdue token does NOT apply to scheduled", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveDeadline: "2026-05-01", effectiveScheduled: "2026-05-10" }),
  ];

  // overdue on scheduled should not match anything (not applicable)
  const result = applyQueryFilters(tasks, { time: { scheduled: "overdue" } }, 1, "2026-05-04");
  assert.equal(result.length, 0);
});

// ── VAL-CORE-007: Time filters — combined ──

test("VAL-CORE-007: multiple time filters are AND-ed", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({
      id: "test.md:L1",
      effectiveScheduled: "2026-05-04",
      effectiveDeadline: "2026-05-10",
    }),
    effectiveTask({
      id: "test.md:L2",
      effectiveScheduled: "2026-05-04",
      effectiveDeadline: "2026-05-01", // overdue
    }),
    effectiveTask({
      id: "test.md:L3",
      effectiveScheduled: "2026-05-05",
      effectiveDeadline: "2026-05-01",
    }),
  ];

  const result = applyQueryFilters(
    tasks,
    { time: { scheduled: "today", deadline: "overdue" } },
    1,
    "2026-05-04",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L2");
});

// ── VAL-CORE-007: Time filters — date ranges ──

test("VAL-CORE-007: time.scheduled=FROM..TO matches range", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-04-30" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: "2026-05-10" }),
    effectiveTask({ id: "test.md:L4", effectiveScheduled: "2026-05-11" }),
  ];

  const result = applyQueryFilters(tasks, { time: { scheduled: "2026-05-01..2026-05-10" } }, 1);
  assert.equal(result.length, 2);
});

test("VAL-CORE-007: time.scheduled=ISO exact date match", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-05" }),
  ];

  const result = applyQueryFilters(tasks, { time: { scheduled: "2026-05-04" } }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

// ── VAL-CORE-007: Time filters — completed, created, dropped ──

test("VAL-CORE-007: time.completed filters by completed date", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", completed: "2026-05-01", effectiveStatus: "done" }),
    effectiveTask({ id: "test.md:L2", completed: "2026-05-04", effectiveStatus: "done" }),
    effectiveTask({ id: "test.md:L3", completed: null, effectiveStatus: "todo" }),
  ];

  const result = applyQueryFilters(tasks, { time: { completed: "week" } }, 1, "2026-05-04");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L2");
});

test("VAL-CORE-007: time.created filters by created date", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", created: "2026-05-04", effectiveCreated: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", created: "2026-04-30", effectiveCreated: "2026-04-30" }),
  ];

  const result = applyQueryFilters(tasks, { time: { created: "today" } }, 1, "2026-05-04");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

test("VAL-CORE-007: time.dropped filters by cancelled date", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", status: "dropped", effectiveStatus: "dropped", cancelled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", status: "dropped", effectiveStatus: "dropped", cancelled: "2026-04-30" }),
    effectiveTask({ id: "test.md:L3", status: "todo", effectiveStatus: "todo", cancelled: null }),
  ];

  const result = applyQueryFilters(tasks, { time: { dropped: "today" } }, 1, "2026-05-04");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

// ── VAL-CORE-007: Combined filters ──

test("VAL-CORE-007: search + tags + status + time are AND-ed", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({
      id: "test.md:L1",
      title: "Write docs about API",
      tags: ["#work", "#docs"],
      status: "todo",
      effectiveStatus: "todo",
      effectiveScheduled: "2026-05-04",
    }),
    effectiveTask({
      id: "test.md:L2",
      title: "Write docs about UI",
      tags: ["#work"],
      status: "todo",
      effectiveStatus: "todo",
      effectiveScheduled: "2026-05-04",
    }),
    effectiveTask({
      id: "test.md:L3",
      title: "Fix bugs",
      tags: ["#work", "#docs"],
      status: "done",
      effectiveStatus: "done",
      effectiveScheduled: "2026-05-04",
    }),
    effectiveTask({
      id: "test.md:L4",
      title: "Write docs about API",
      tags: ["#work", "#docs"],
      status: "todo",
      effectiveStatus: "todo",
      effectiveScheduled: "2026-05-05",
    }),
  ];

  const result = applyQueryFilters(
    tasks,
    {
      search: "docs",
      tags: { expr: "#work and #docs" },
      status: ["todo"],
      time: { scheduled: "today" },
    },
    1,
    "2026-05-04",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

// ── VAL-CORE-007: Empty filters return all tasks ──

test("VAL-CORE-007: no filters returns all tasks", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1" }),
    effectiveTask({ id: "test.md:L2" }),
  ];

  const result = applyQueryFilters(tasks, {}, 1);
  assert.equal(result.length, 2);
});

// ── VAL-CORE-007: unscheduled with other time fields ──

test("VAL-CORE-007: unscheduled AND deadline=overdue", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({
      id: "test.md:L1",
      effectiveScheduled: null,
      effectiveDeadline: "2026-05-01",
    }),
    effectiveTask({
      id: "test.md:L2",
      effectiveScheduled: "2026-05-04",
      effectiveDeadline: "2026-05-01",
    }),
    effectiveTask({
      id: "test.md:L3",
      effectiveScheduled: null,
      effectiveDeadline: "2026-05-10",
    }),
  ];

  const result = applyQueryFilters(
    tasks,
    { time: { scheduled: "unscheduled", deadline: "overdue" } },
    1,
    "2026-05-04",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "test.md:L1");
});

// ── VAL-CORE-007: Filter uses effectiveStatus from EffectiveTask ──

test("VAL-CORE-007: status filter uses effectiveStatus (terminal inheritance)", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  // Task that is terminal-inherited to "done" should match status=["done"]
  // even though its own checkbox status is "todo"
  const tasks = [
    effectiveTask({
      id: "test.md:L1",
      status: "todo",
      effectiveStatus: "done",
      terminalInheritedFrom: "parent-id",
    }),
    effectiveTask({
      id: "test.md:L2",
      status: "done",
      effectiveStatus: "done",
    }),
  ];

  const result = applyQueryFilters(tasks, { status: ["done"] }, 1);
  assert.equal(result.length, 2);
});

// ── VAL-CORE-007: Filter uses effectiveScheduled/Deadline/Created ──

test("VAL-CORE-007: time filter uses effectiveScheduled (inherited from ancestor)", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  // Task with inherited scheduled date
  const tasks = [
    effectiveTask({
      id: "test.md:L1",
      scheduled: null,
      effectiveScheduled: "2026-05-04",
    }),
    effectiveTask({
      id: "test.md:L2",
      scheduled: "2026-05-04",
      effectiveScheduled: "2026-05-04",
    }),
  ];

  const result = applyQueryFilters(tasks, { time: { scheduled: "today" } }, 1, "2026-05-04");
  assert.equal(result.length, 2);
});

// ── VAL-CORE-007: Edge cases ──

test("VAL-CORE-007: null value does not match any concrete date token", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: null }),
  ];

  // "today" should not match null
  const result = applyQueryFilters(tasks, { time: { scheduled: "today" } }, 1, "2026-05-04");
  assert.equal(result.length, 0);
});

test("VAL-CORE-007: task with no time field still passes when no time filter", async () => {
  if (compileErr) throw compileErr;

  const { applyQueryFilters } = await import("../test/.compiled/filter.js");

  const tasks = [
    effectiveTask({
      id: "test.md:L1",
      title: "XYZ Unfindable",
      scheduled: null,
      deadline: null,
      completed: null,
      created: null,
      cancelled: null,
      effectiveScheduled: null,
      effectiveDeadline: null,
      effectiveCreated: null,
    }),
  ];

  // No time filter — tasks with null effective dates should still pass
  const result = applyQueryFilters(tasks, { status: ["todo"] }, 1);
  assert.equal(result.length, 1, "Task should pass status filter without time filters");
});

test('US-109d/d3/d4: evaluator accepts unnormalized arrays and legacy include/exclude shapes', async () => {
  const { applyQueryFilters } = await import('../test/.compiled/filter.js');
  const tasks = [effectiveTask({ id: 'a', tags: ['#a'] }), effectiveTask({ id: 'ab', tags: ['#a', '#b'] })];
  assert.deepEqual(applyQueryFilters(tasks, { tags: ['#a', '#b'] }, 1).map(t => t.id), ['ab']);
  assert.deepEqual(applyQueryFilters(tasks, { tags: { values: ['#a'], exclude: ['#b'] } }, 1).map(t => t.id), ['a']);
});
test('US-720b: not-overdue includes missing deadlines and today, excludes past deadlines', async () => {
  const { applyQueryFilters } = await import('../test/.compiled/filter.js');
  const tasks = [null, '2026-10-17', '2026-10-18', '2026-10-19'].map((date, i) => effectiveTask({ id: String(i), effectiveDeadline: date }));
  assert.deepEqual(applyQueryFilters(tasks, { time: { deadline: 'not-overdue' } }, 1, '2026-10-18').map(t => t.id), ['0', '2', '3']);
});
