// Tests for the pure natural-language parsers used by the GUI quick-add
// and D-key date prompt.
// Run with: `node --test test/quickadd.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// US-31a task #31a — footer/writer SSOT alignment.
// computeWriteTarget must mirror writer.ts addTask's target resolution:
//   - Obsidian's built-in daily-notes plugin enabled → its folder/format
//   - Otherwise → no target; Quick Add / add must fail instead of writing
//     to an inbox fallback.
//
// task #32 (0.3.0 breaking) removed the legacy `settings.dailyFolder`;
// the old "footer lies" scenario it produced is now structurally
// impossible because the field no longer exists.

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
const { parseQuickAdd, computeWriteTarget, quickChips } = await import(
  "../test/.compiled/quickadd.bundle.js"
);
const { resolveDateInput } = await import("../test/.compiled/dateprompt.bundle.js");

test("parseQuickAdd — plain text, no metadata", () => {
  const r = parseQuickAdd("处理示例任务", "2026-04-23");
  assert.equal(r.text, "处理示例任务");
  assert.equal(r.scheduled, undefined);
  assert.equal(r.deadline, undefined);
  assert.equal(r.estimate, undefined);
});

test("parseQuickAdd — extracts tags", () => {
  const r = parseQuickAdd("task #2象限 #基建", "2026-04-23");
  assert.equal(r.text, "task");
  assert.deepEqual(r.tag.sort(), ["#2象限", "#基建"]);
});

test("US-108/US-301: quick chips use saved/current markdown tags, not a groupingTags setting", () => {
  const chips = quickChips(["#now", "#next", "#now"]);
  assert.deepEqual(
    chips.map((c) => c.token),
    ["⏳ today", "⏳ tomorrow", "⏳ 周六", "#now", "#next"],
  );
  assert.deepEqual(
    chips.map((c) => c.label),
    ["Today", "Tomorrow", "周六", "now", "next"],
  );
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

// US-31a task #31a — footer/writer SSOT alignment.
test("computeWriteTarget — daily-notes plugin enabled → uses its folder/format", () => {
  const app = {
    internalPlugins: {
      plugins: {
        "daily-notes": {
          instance: { options: { folder: "Journal", format: "YYYY-MM-DD" } },
        },
      },
    },
  };
  const settings = { inboxPath: "Tasks/Inbox.md" };
  const r = computeWriteTarget(app, settings);
  assert.match(r, /^Journal\/\d{4}-\d{2}-\d{2}\.md$/);
});

test("computeWriteTarget — daily-notes plugin DISABLED → null target (Quick Add must not write inbox fallback)", () => {
  // No internalPlugins.plugins["daily-notes"] → daily-notes is disabled.
  const app = { internalPlugins: { plugins: {} } };
  const r = computeWriteTarget(app);
  assert.equal(r, null);
});

test("computeWriteTarget — daily-notes enabled but no folder → null target", () => {
  const app = {
    internalPlugins: {
      plugins: {
        "daily-notes": {
          instance: { options: { folder: "", format: "YYYY-MM-DD" } },
        },
      },
    },
  };
  const r = computeWriteTarget(app);
  assert.equal(r, null);
});

test("computeWriteTarget — daily-notes disabled + no settings → null target", () => {
  const app = { internalPlugins: { plugins: {} } };
  const r = computeWriteTarget(app, undefined);
  assert.equal(r, null);
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
