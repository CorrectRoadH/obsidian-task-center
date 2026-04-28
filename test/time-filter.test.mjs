// Unit tests for US-109e/i: time range filters keep each field semantic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/time-filter.ts",
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
const { taskMatchesTimeToken, timeTokenAppliesToField } = await import("../test/.compiled/time-filter.js");

test("US-109e: range filters match the provided time field value", () => {
  assert.equal(taskMatchesTimeToken("2026-04-23", "2026-04-08..2026-04-23", 1, "2026-04-20"), true);
  assert.equal(taskMatchesTimeToken("2026-04-24", "2026-04-08..2026-04-23", 1, "2026-04-20"), false);
});

test("US-109e: missing field values do not match concrete ranges", () => {
  assert.equal(taskMatchesTimeToken(null, "week", 1, "2026-04-20"), false);
});

test("US-109i: deadline-specific risk tokens are explicit time tokens", () => {
  assert.equal(taskMatchesTimeToken("2026-04-19", "overdue", 1, "2026-04-20"), true);
  assert.equal(taskMatchesTimeToken("2026-04-20", "overdue", 1, "2026-04-20"), false);
  assert.equal(taskMatchesTimeToken("2026-04-27", "next-7-days", 1, "2026-04-20"), true);
  assert.equal(taskMatchesTimeToken("2026-04-28", "next-7-days", 1, "2026-04-20"), false);
});

test("US-109i: deadline risk tokens do not apply to other time fields", () => {
  assert.equal(timeTokenAppliesToField("deadline", "overdue"), true);
  assert.equal(timeTokenAppliesToField("scheduled", "overdue"), false);
  assert.equal(timeTokenAppliesToField("completed", "next-7-days"), false);
});

test("US-109e: unscheduled is not a range token", () => {
  assert.equal(taskMatchesTimeToken("2026-04-20", "unscheduled", 1, "2026-04-20"), false);
});

test("US-109e: week presets follow the configured week start", () => {
  assert.equal(taskMatchesTimeToken("2026-04-19", "week", 0, "2026-04-20"), true);
  assert.equal(taskMatchesTimeToken("2026-04-19", "week", 1, "2026-04-20"), false);
});
