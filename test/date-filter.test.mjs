// Unit tests for US-109e: schedule range button labels stay compact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/date-filter.ts",
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
const { formatDateFilterLabel } = await import("../test/.compiled/date-filter.js");

test("US-109e: range label is compact enough for the toolbar", () => {
  const label = formatDateFilterLabel("2026-04-08..2026-04-23", {
    emptyLabel: "排期",
    openStartLabel: "开始",
    openEndLabel: "结束",
    presets: new Map(),
  });

  assert.equal(label, "04-08 - 04-23");
});

test("US-109e: open range labels still explain the missing side", () => {
  const label = formatDateFilterLabel("..2026-04-23", {
    emptyLabel: "排期",
    openStartLabel: "开始",
    openEndLabel: "结束",
    presets: new Map(),
  });

  assert.equal(label, "开始 - 04-23");
});
