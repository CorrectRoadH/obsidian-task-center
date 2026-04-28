// Unit tests for US-109e: the filter bar's range control means scheduled time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/schedule-filter.ts",
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

compilePure();
const { taskMatchesScheduleToken } = await import("../test/.compiled/schedule-filter.js");

test("US-109e: range filters match the task's own scheduled date", () => {
  assert.equal(taskMatchesScheduleToken("2026-04-23", "2026-04-08..2026-04-23", 1, "2026-04-20"), true);
  assert.equal(taskMatchesScheduleToken("2026-04-24", "2026-04-08..2026-04-23", 1, "2026-04-20"), false);
});

test("US-109e: unscheduled tasks do not match scheduled ranges", () => {
  assert.equal(taskMatchesScheduleToken(null, "week", 1, "2026-04-20"), false);
});

test("US-109e: overdue and unscheduled are not range tokens", () => {
  assert.equal(taskMatchesScheduleToken("2026-04-20", "overdue", 1, "2026-04-20"), false);
  assert.equal(taskMatchesScheduleToken("2026-04-20", "unscheduled", 1, "2026-04-20"), false);
});

test("US-109e: week presets follow the configured week start", () => {
  assert.equal(taskMatchesScheduleToken("2026-04-19", "week", 0, "2026-04-20"), true);
  assert.equal(taskMatchesScheduleToken("2026-04-19", "week", 1, "2026-04-20"), false);
});
