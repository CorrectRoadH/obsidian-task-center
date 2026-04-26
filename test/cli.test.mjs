// Unit tests for pure CLI filters, stats, and formatters.
// Run with: `node --test test/cli.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compile() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/cli.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outfile=test/.compiled/cli.bundle.js",
      "--alias:obsidian=./test/obsidian-stub.mjs",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild failed:\n" + result.stderr);
  }
}

compile();
const {
  filterTasks,
  computeStats,
  buildAgentBrief,
  buildReviewSummary,
  formatList,
  formatStats,
  formatAgentBrief,
  formatReviewSummary,
  formatError,
} =
  await import("../test/.compiled/cli.bundle.js");

// Use production `todayISO()` (local-time based) instead of `toISOString().slice(0,10)`
// (UTC-based). Production filterTasks/computeStats internally call todayISO();
// fixtures must match the same calendar to avoid timezone-mismatch windows
// (UTC vs local) where tests fail across the ~16h overlap each day.
function todayLocal() {
  const d = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function mkTask(over = {}) {
  return {
    id: "f.md:L1",
    path: "f.md",
    line: 0,
    indent: "",
    checkbox: " ",
    status: "todo",
    title: "t",
    rawTitle: "t",
    rawLine: "- [ ] t",
    tags: [],
    scheduled: null,
    deadline: null,
    start: null,
    completed: null,
    cancelled: null,
    created: null,
    estimate: null,
    actual: null,
    parentLine: null,
    parentIndex: null,
    childrenLines: [],
    hash: "abc123",
    mtime: 0,
    inheritsTerminal: false,
    ...over,
  };
}

test("filterTasks — scheduled=today", () => {
  const today = todayLocal();
  const all = [
    mkTask({ id: "a", scheduled: today }),
    mkTask({ id: "b", scheduled: null }),
    mkTask({ id: "c", scheduled: "2026-01-01" }),
  ];
  const r = filterTasks(all, { scheduled: "today" });
  assert.deepEqual(r.map((t) => t.id), ["a"]);
});

test("filterTasks — unscheduled hides inherits-terminal by default", () => {
  const all = [
    mkTask({ id: "a" }),
    mkTask({ id: "b", inheritsTerminal: true }),
  ];
  const r = filterTasks(all, { scheduled: "unscheduled" });
  assert.deepEqual(r.map((t) => t.id), ["a"]);
});

test("filterTasks — status=done skips inherits-terminal filter", () => {
  const all = [
    mkTask({ id: "a", status: "done", inheritsTerminal: true }),
    mkTask({ id: "b", status: "done" }),
  ];
  const r = filterTasks(all, { status: "done" });
  assert.deepEqual(r.map((t) => t.id).sort(), ["a", "b"]);
});

test("filterTasks — tag filter accepts wildcard", () => {
  const all = [
    mkTask({ id: "a", tags: ["#2象限"] }),
    mkTask({ id: "b", tags: ["#3象限"] }),
    mkTask({ id: "c", tags: ["#基建"] }),
  ];
  const r = filterTasks(all, { tag: ["#*象限"] });
  assert.deepEqual(r.map((t) => t.id).sort(), ["a", "b"]);
});

test("filterTasks — overdue only matches past-deadline todos", () => {
  const all = [
    mkTask({ id: "a", deadline: "2020-01-01" }),
    mkTask({ id: "b", deadline: "2099-01-01" }),
    mkTask({ id: "c" }),
    mkTask({ id: "d", status: "done", deadline: "2020-01-01" }),
  ];
  const r = filterTasks(all, { overdue: true });
  assert.deepEqual(r.map((t) => t.id), ["a"]);
});

test("filterTasks — search matches substring, case-insensitive", () => {
  const all = [
    mkTask({ id: "a", title: "go to Grocery store" }),
    mkTask({ id: "b", title: "GROCERY list" }),
    mkTask({ id: "c", title: "meeting" }),
  ];
  const r = filterTasks(all, { search: "grocery" });
  assert.deepEqual(r.map((t) => t.id).sort(), ["a", "b"]);
});

test("filterTasks — limit truncates", () => {
  const all = [mkTask({ id: "a" }), mkTask({ id: "b" }), mkTask({ id: "c" })];
  const r = filterTasks(all, { limit: 2 });
  assert.equal(r.length, 2);
});

test("computeStats — zero done tasks", () => {
  const s = computeStats([], { days: 7 });
  assert.equal(s.doneCount, 0);
  assert.equal(s.sumActual, 0);
  assert.equal(s.ratio, null);
});

test("computeStats — ratio + per-task mean", () => {
  const today = todayLocal();
  const all = [
    mkTask({ id: "a", status: "done", completed: today, estimate: 60, actual: 90 }),
    mkTask({ id: "b", status: "done", completed: today, estimate: 30, actual: 30 }),
  ];
  const s = computeStats(all, { days: 1 });
  assert.equal(s.doneCount, 2);
  assert.equal(s.sumActual, 120);
  assert.equal(s.sumEstimate, 90);
  // ratio = 120 / 90 = 1.333
  assert.ok(Math.abs(s.ratio - 120 / 90) < 1e-9);
  // per-task ratios: 90/60=1.5, 30/30=1.0 → mean=1.25
  assert.ok(Math.abs(s.perTaskMean - 1.25) < 1e-9);
});

test("computeStats — byTag aggregates minutes", () => {
  const today = todayLocal();
  const all = [
    mkTask({ id: "a", status: "done", completed: today, actual: 60, tags: ["#2象限"] }),
    mkTask({ id: "b", status: "done", completed: today, actual: 30, tags: ["#2象限", "#基建"] }),
  ];
  const s = computeStats(all, { days: 1 });
  const q2 = s.byTag.find((x) => x.tag === "#2象限");
  assert.equal(q2.minutes, 90);
  const jijian = s.byTag.find((x) => x.tag === "#基建");
  assert.equal(jijian.minutes, 30);
});

test("computeStats — group prefix produces byGroup", () => {
  const today = todayLocal();
  const all = [
    mkTask({ id: "a", status: "done", completed: today, actual: 60, tags: ["#2象限"] }),
    mkTask({ id: "b", status: "done", completed: today, actual: 30, tags: ["#3象限"] }),
    mkTask({ id: "c", status: "done", completed: today, actual: 10, tags: ["#基建"] }),
  ];
  const s = computeStats(all, { days: 1, group: "象限" });
  assert.ok(s.byGroup);
  assert.equal(s.byGroup.prefix, "象限");
  assert.equal(s.byGroup.entries.length, 2);
});

test("formatList — header + rows with ids", () => {
  const all = [mkTask({ id: "f.md:L1", title: "a" })];
  const out = formatList(all, "1 tasks · test");
  assert.match(out, /1 tasks · test/);
  assert.match(out, /f\.md:L1/);
  assert.match(out, /\[ \]/);
});

test("US-301: formatList uses custom grouping tags for the group column", () => {
  const all = [mkTask({ id: "f.md:L1", title: "a", tags: ["#next"] })];
  const out = formatList(all, "1 tasks · test", { groupingTags: ["#now", "#next"] });
  assert.match(out, /f\.md:L1\s+\[ \]\s+#2\s+a/);
});

test("formatStats — shows ratio + 'within band'", () => {
  const s = {
    periodFrom: "2026-04-17",
    periodTo: "2026-04-23",
    days: 7,
    doneCount: 2,
    sumActual: 120,
    sumEstimate: 90,
    ratio: 120 / 90,
    perTaskMean: 1.25,
    perTaskStd: 0.25,
    withinBand: { count: 1, total: 2, pct: 50 },
    byTag: [],
  };
  const out = formatStats(s);
  assert.match(out, /Tasks done: 2/);
  assert.match(out, /sum actual\s+120m/);
  assert.match(out, /within band\s+1\/2/);
});

test("US-723: buildAgentBrief partitions overdue/today/unscheduled and emits writeback commands", () => {
  const all = [
    mkTask({
      id: "Daily/2026-04-26.md:L5",
      path: "Daily/2026-04-26.md",
      title: "overdue blocker",
      deadline: "2026-04-25",
      tags: ["#now"],
      estimate: 30,
    }),
    mkTask({
      id: "Daily/2026-04-26.md:L9",
      path: "Daily/2026-04-26.md",
      title: "today task",
      scheduled: "2026-04-26",
    }),
    mkTask({
      id: "Tasks/Inbox.md:L2",
      path: "Tasks/Inbox.md",
      title: "candidate",
      scheduled: null,
    }),
    mkTask({
      id: "Tasks/Archive.md:L1",
      path: "Tasks/Archive.md",
      title: "hidden completed child",
      inheritsTerminal: true,
    }),
  ];
  const brief = buildAgentBrief(all, { today: "2026-04-26", limit: 3 });
  assert.deepEqual(brief.counts, { overdue: 1, today: 1, unscheduled: 1 });
  assert.deepEqual(brief.sections.overdue.map((t) => t.id), ["Daily/2026-04-26.md:L5"]);
  assert.deepEqual(brief.sections.today.map((t) => t.id), ["Daily/2026-04-26.md:L9"]);
  assert.deepEqual(brief.sections.unscheduled.map((t) => t.id), ["Tasks/Inbox.md:L2"]);
  assert.match(
    brief.sections.overdue[0].actions.find((a) => a.label === "done").command,
    /^obsidian task-center:done ref='Daily\/2026-04-26\.md:L5'$/,
  );
  assert.match(
    brief.sections.unscheduled[0].actions.find((a) => a.label === "schedule_today").command,
    /task-center:schedule ref='Tasks\/Inbox\.md:L2' date=2026-04-26/,
  );
  assert.match(
    brief.sections.unscheduled[0].actions.find((a) => a.label === "schedule_tomorrow").command,
    /task-center:schedule ref='Tasks\/Inbox\.md:L2' date=2026-04-27/,
  );
});

test("US-723: formatAgentBrief is grep-friendly and starts from stable task ids", () => {
  const brief = buildAgentBrief(
    [
      mkTask({
        id: "Tasks/Inbox.md:L42",
        path: "Tasks/Inbox.md",
        title: "pick next task",
        scheduled: "2026-04-26",
        estimate: 45,
      }),
    ],
    { today: "2026-04-26" },
  );
  const out = formatAgentBrief(brief);
  assert.match(out, /^Agent brief · 2026-04-26/);
  assert.match(out, /counts overdue=0 today=1 unscheduled=0/);
  assert.match(out, /1\. Tasks\/Inbox\.md:L42  pick next task/);
  assert.match(out, /done: obsidian task-center:done ref='Tasks\/Inbox\.md:L42'/);
  assert.match(out, /Sections\n    overdue: —\n    today: Tasks\/Inbox\.md:L42/);
});

test("US-722: buildReviewSummary covers today/week done, dropped, delayed, estimate, and grouping", () => {
  const all = [
    mkTask({
      id: "Daily/2026-04-26.md:L1",
      path: "Daily/2026-04-26.md",
      status: "done",
      checkbox: "x",
      title: "ship feature",
      completed: "2026-04-26",
      estimate: 60,
      actual: 90,
      tags: ["#1象限"],
    }),
    mkTask({
      id: "Daily/2026-04-26.md:L2",
      path: "Daily/2026-04-26.md",
      status: "dropped",
      checkbox: "-",
      title: "abandon low value",
      rawLine: "- [-] abandon low value #2象限 ❌ 2026-04-26 [estimate:: 30m]",
      estimate: 30,
      tags: ["#2象限"],
    }),
    mkTask({
      id: "Daily/2026-04-20.md:L3",
      path: "Daily/2026-04-20.md",
      status: "done",
      checkbox: "x",
      title: "earlier win",
      completed: "2026-04-20",
      estimate: 30,
      actual: 20,
      tags: ["#1象限"],
    }),
    mkTask({
      id: "Tasks/Inbox.md:L4",
      path: "Tasks/Inbox.md",
      title: "late blocker",
      deadline: "2026-04-25",
      tags: ["#1象限"],
    }),
    mkTask({
      id: "Tasks/Inbox.md:L5",
      path: "Tasks/Inbox.md",
      title: "old scheduled",
      scheduled: "2026-04-19",
      tags: ["#2象限"],
    }),
    mkTask({
      id: "Tasks/Hidden.md:L6",
      path: "Tasks/Hidden.md",
      title: "terminal child",
      deadline: "2026-04-25",
      inheritsTerminal: true,
      tags: ["#1象限"],
    }),
  ];
  const review = buildReviewSummary(all, {
    today: "2026-04-26",
    days: 7,
    groupingTags: ["#1象限", "#2象限"],
  });

  assert.equal(review.today.done, 1);
  assert.equal(review.today.dropped, 1);
  assert.equal(review.today.delayedOpen, 2);
  assert.equal(review.today.estimate.actual, 90);
  assert.equal(review.today.estimate.estimate, 60);
  assert.equal(review.today.estimate.delta, 30);
  assert.equal(review.week.done, 2);
  assert.equal(review.week.estimate.actual, 110);
  assert.equal(review.week.estimate.estimate, 90);
  const q1 = review.week.byGroup.find((row) => row.group === "#1象限");
  assert.equal(q1.done, 2);
  assert.equal(q1.delayedOpen, 1);
  const q2 = review.today.byGroup.find((row) => row.group === "#2象限");
  assert.equal(q2.dropped, 1);
  assert.equal(q2.delayedOpen, 1);
});

test("US-722: formatReviewSummary is readable and grep-friendly", () => {
  const review = buildReviewSummary(
    [
      mkTask({
        id: "Tasks/Done.md:L9",
        path: "Tasks/Done.md",
        status: "done",
        checkbox: "x",
        title: "finish report",
        completed: "2026-04-26",
        estimate: 45,
        actual: 30,
        tags: ["#work"],
      }),
      mkTask({
        id: "Tasks/Drop.md:L10",
        path: "Tasks/Drop.md",
        status: "dropped",
        checkbox: "-",
        title: "skip optional",
        rawLine: "- [-] skip optional #life ❌ 2026-04-26",
        tags: ["#life"],
      }),
      mkTask({
        id: "Tasks/Late.md:L11",
        path: "Tasks/Late.md",
        title: "overdue call",
        deadline: "2026-04-25",
        tags: ["#work"],
      }),
    ],
    { today: "2026-04-26", groupingTags: ["#work", "#life"] },
  );
  const out = formatReviewSummary(review);
  assert.match(out, /^Review · 2026-04-26/);
  assert.match(out, /Today · 2026-04-26/);
  assert.match(out, /Week · 2026-04-20 → 2026-04-26/);
  assert.match(out, /done=1 dropped=1 delayed_open=1/);
  assert.match(out, /estimate actual=30m estimate=45m delta=-15m/);
  assert.match(out, /#work\s+done=1 dropped=0 delayed_open=1/);
  assert.match(out, /dropped: Tasks\/Drop\.md:L10 skip optional #life/);
});

test("formatError — greppable code + message shape", () => {
  const out = formatError("task_not_found", "no match");
  assert.match(out, /^error\s+task_not_found/);
  assert.match(out, /no match/);
});
