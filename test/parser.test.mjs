// Unit tests for pure parser helpers. No Obsidian dependency — Node's
// built-in test runner. Run with: `node --test test/parser.test.mjs`
//
// We import from a tiny hand-rolled ESM shim that re-exports only the pure
// functions under test — the real module is CommonJS after esbuild.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Compile the parser + dates to a small ESM bundle for the test run.
function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/parser.ts",
      "src/dates.ts",
      "--bundle=false",
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

compilePure();
const {
  parseDurationToMinutes,
  formatMinutes,
  cleanTitle,
  parseTaskLine,
  statusFromCheckbox,
  shortHash,
} = await import("../test/.compiled/parser.js");
const { addDays, startOfWeek, endOfMonth, shiftMonth, resolveWhen, isValidISO } =
  await import("../test/.compiled/dates.js");

test("parseDurationToMinutes", () => {
  assert.equal(parseDurationToMinutes("90m"), 90);
  assert.equal(parseDurationToMinutes("1h"), 60);
  assert.equal(parseDurationToMinutes("1h30m"), 90);
  assert.equal(parseDurationToMinutes("1.5h"), 90);
  assert.equal(parseDurationToMinutes("45"), 45);
  assert.equal(parseDurationToMinutes("45min"), 45);
  assert.equal(parseDurationToMinutes("bogus"), null);
  assert.equal(parseDurationToMinutes(""), null);
  assert.equal(parseDurationToMinutes(null), null);
});

test("formatMinutes", () => {
  assert.equal(formatMinutes(30), "30m");
  assert.equal(formatMinutes(60), "1h");
  assert.equal(formatMinutes(90), "1h30m");
  assert.equal(formatMinutes(125), "2h5m");
});

test("statusFromCheckbox", () => {
  assert.equal(statusFromCheckbox(" "), "todo");
  assert.equal(statusFromCheckbox("x"), "done");
  assert.equal(statusFromCheckbox("X"), "done");
  assert.equal(statusFromCheckbox("-"), "dropped");
  assert.equal(statusFromCheckbox("/"), "in_progress");
  assert.equal(statusFromCheckbox(">"), "cancelled");
  assert.equal(statusFromCheckbox("!"), "custom");
});

test("parseTaskLine — plain", () => {
  const r = parseTaskLine("- [ ] hello");
  assert.deepEqual(r, { indent: "", marker: "-", checkbox: " ", content: "hello" });
});

test("parseTaskLine — indented", () => {
  const r = parseTaskLine("    - [x] done");
  assert.deepEqual(r, { indent: "    ", marker: "-", checkbox: "x", content: "done" });
});

test("parseTaskLine — callout (single >)", () => {
  const r = parseTaskLine("> - [ ] callout");
  assert.equal(r?.indent, "> ");
  assert.equal(r?.checkbox, " ");
  assert.equal(r?.content, "callout");
});

test("parseTaskLine — nested callout", () => {
  const r = parseTaskLine(">  >  - [-] nested");
  assert.equal(r?.checkbox, "-");
  assert.equal(r?.content, "nested");
});

// US-125 task #33 — CRLF root cause. Lines pasted from external sources
// often carry trailing `\r` on each line (CRLF instead of LF).
// CHECKBOX_RE's `(.*)$` trailing capture greedily eats the `\r`, putting
// it into `content`. Downstream metadata parsers don't strip it, the
// task's hash is computed from a `\r`-tainted title, and the line
// quietly diverges from its sibling tasks — visually "missing" from the
// parent's card render.
test("parseTaskLine — strips trailing CR (CRLF)", () => {
  const r = parseTaskLine("    - [ ] 买廉价的AI会员(GPT Plus\\Kimi) ➕ 2026-04-26 ⏳ 2026-04-26\r");
  assert.equal(r?.checkbox, " ");
  // Critical: content must NOT carry trailing `\r`.
  assert.equal(
    r?.content,
    "买廉价的AI会员(GPT Plus\\Kimi) ➕ 2026-04-26 ⏳ 2026-04-26",
  );
});

test("parseTaskLine — non-task returns null", () => {
  assert.equal(parseTaskLine("- plain bullet"), null);
  assert.equal(parseTaskLine("# heading"), null);
});

test("cleanTitle — strips emoji dates + tags + inline fields + block anchors", () => {
  const t = cleanTitle(
    "real title #tag1 📅 2026-05-15 ⏳ 2026-04-24 ➕ 2026-04-23 ✅ 2026-04-23 [estimate:: 30m] [actual:: 25m] ^abc123",
  );
  assert.equal(t, "real title");
});

test("cleanTitle — preserves wikilinks", () => {
  const t = cleanTitle("task with [[wikilink]] reference ⏳ 2026-04-24");
  assert.equal(t, "task with [[wikilink]] reference");
});

test("cleanTitle — recurrence swallow", () => {
  const t = cleanTitle("recurring task 🔁 every week ⏳ 2026-04-24");
  assert.equal(t, "recurring task");
});

test("shortHash — deterministic + stable length", () => {
  const h1 = shortHash("foo");
  const h2 = shortHash("foo");
  const h3 = shortHash("bar");
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 12);
});

test("addDays", () => {
  assert.equal(addDays("2026-04-23", 1), "2026-04-24");
  assert.equal(addDays("2026-04-23", -1), "2026-04-22");
  assert.equal(addDays("2026-04-30", 1), "2026-05-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("startOfWeek — Monday", () => {
  assert.equal(startOfWeek("2026-04-23", 1), "2026-04-20"); // Thu → Mon
  assert.equal(startOfWeek("2026-04-20", 1), "2026-04-20"); // already Mon
  assert.equal(startOfWeek("2026-04-19", 1), "2026-04-13"); // Sun → prior Mon
});

test("startOfWeek — Sunday", () => {
  assert.equal(startOfWeek("2026-04-23", 0), "2026-04-19"); // Thu → prior Sun
});

test("shiftMonth — end-of-month clamp", () => {
  assert.equal(shiftMonth("2026-01-31", 1), "2026-02-28"); // Feb has no 31
  assert.equal(shiftMonth("2026-03-31", -1), "2026-02-28");
  assert.equal(shiftMonth("2026-02-15", 1), "2026-03-15");
});

test("endOfMonth", () => {
  assert.equal(endOfMonth("2026-02-10"), "2026-02-28");
  assert.equal(endOfMonth("2024-02-10"), "2024-02-29"); // leap
});

test("resolveWhen", () => {
  assert.equal(resolveWhen("today", "2026-04-23").exact, "2026-04-23");
  assert.equal(resolveWhen("tomorrow", "2026-04-23").exact, "2026-04-24");
  assert.ok(resolveWhen("unscheduled").unscheduled);
  const wk = resolveWhen("week", "2026-04-23", 1);
  assert.equal(wk.from, "2026-04-20");
  assert.equal(wk.to, "2026-04-26");
  const range = resolveWhen("2026-04-01..2026-04-30");
  assert.equal(range.from, "2026-04-01");
  assert.equal(range.to, "2026-04-30");
});

test("isValidISO", () => {
  assert.ok(isValidISO("2026-04-23"));
  assert.ok(!isValidISO("2026-4-23"));
  assert.ok(!isValidISO("hello"));
  assert.ok(!isValidISO(null));
});
