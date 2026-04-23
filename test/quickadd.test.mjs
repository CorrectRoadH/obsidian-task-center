// Tests for the pure natural-language parsers used by the GUI quick-add
// and D-key date prompt.
// Run with: `node --test test/quickadd.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compile() {
  for (const entry of ["src/quickadd.ts", "src/dateprompt.ts"]) {
    const out = `test/.compiled/${entry.split("/")[1].replace(".ts", ".bundle.js")}`;
    const r = spawnSync(
      "npx",
      [
        "esbuild",
        entry,
        "--bundle",
        "--format=esm",
        "--platform=node",
        `--outfile=${out}`,
        "--alias:obsidian=./test/obsidian-stub.mjs",
      ],
      { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error("esbuild failed:\n" + r.stderr);
  }
}

compile();
const { parseQuickAdd } = await import("../test/.compiled/quickadd.bundle.js");
const { resolveDateInput } = await import("../test/.compiled/dateprompt.bundle.js");

test("parseQuickAdd — plain text, no metadata", () => {
  const r = parseQuickAdd("去营业厅问携号转网", "2026-04-23");
  assert.equal(r.text, "去营业厅问携号转网");
  assert.equal(r.scheduled, undefined);
  assert.equal(r.deadline, undefined);
  assert.equal(r.estimate, undefined);
});

test("parseQuickAdd — extracts tags", () => {
  const r = parseQuickAdd("task #2象限 #基建", "2026-04-23");
  assert.equal(r.text, "task");
  assert.deepEqual(r.tag.sort(), ["#2象限", "#基建"]);
});

test("parseQuickAdd — ⏳ with ISO date", () => {
  const r = parseQuickAdd("task ⏳ 2026-05-01", "2026-04-23");
  assert.equal(r.scheduled, "2026-05-01");
  assert.equal(r.text, "task");
});

test("parseQuickAdd — ⏳ with Chinese weekday (周六)", () => {
  const r = parseQuickAdd("task ⏳ 周六", "2026-04-23"); // 周四
  // Saturday after 2026-04-23 (Thu) is 2026-04-25
  assert.equal(r.scheduled, "2026-04-25");
});

test("parseQuickAdd — ⏳ with 'tomorrow' / '明天'", () => {
  const r1 = parseQuickAdd("task ⏳ tomorrow", "2026-04-23");
  const r2 = parseQuickAdd("task ⏳ 明天", "2026-04-23");
  assert.equal(r1.scheduled, "2026-04-24");
  assert.equal(r2.scheduled, "2026-04-24");
});

test("parseQuickAdd — trailing bare relative date (no ⏳)", () => {
  const r = parseQuickAdd("task 明天", "2026-04-23");
  assert.equal(r.scheduled, "2026-04-24");
  assert.equal(r.text, "task");
});

test("parseQuickAdd — 📅 deadline", () => {
  const r = parseQuickAdd("task 📅 2026-05-15", "2026-04-23");
  assert.equal(r.deadline, "2026-05-15");
  assert.equal(r.text, "task");
});

test("parseQuickAdd — [estimate:: ...]", () => {
  const r = parseQuickAdd("task [estimate:: 90m]", "2026-04-23");
  assert.equal(r.estimate, 90);
});

test("parseQuickAdd — full combo", () => {
  const r = parseQuickAdd(
    "写测试 #2象限 📅 2026-05-15 ⏳ 周六 [estimate:: 25m]",
    "2026-04-23",
  );
  assert.equal(r.text, "写测试");
  assert.deepEqual(r.tag, ["#2象限"]);
  assert.equal(r.deadline, "2026-05-15");
  assert.equal(r.scheduled, "2026-04-25");
  assert.equal(r.estimate, 25);
});

test("resolveDateInput — blank clears", () => {
  assert.equal(resolveDateInput(""), null);
  assert.equal(resolveDateInput("   "), null);
});

test("resolveDateInput — ISO passthrough", () => {
  assert.equal(resolveDateInput("2026-04-25"), "2026-04-25");
});

test("resolveDateInput — invalid → undefined (caller rejects)", () => {
  assert.equal(resolveDateInput("bogus"), undefined);
  assert.equal(resolveDateInput("2026/04/25"), undefined);
});

test("resolveDateInput — natural language", () => {
  // Relies on real clock — we only sanity-check shape, not exact value.
  const today = resolveDateInput("today");
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  const tomorrow = resolveDateInput("tomorrow");
  assert.match(tomorrow, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(today, tomorrow);
});
