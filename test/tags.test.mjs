// Unit tests for pure tag display helpers. No Obsidian dependency.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/tags.ts",
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
const { taskDisplayTags } = await import("../test/.compiled/tags.js");

test("US-151: taskDisplayTags preserves markdown tag text and order", () => {
  assert.deepEqual(taskDisplayTags(["#work", "#1象限", "#ai"]), ["#work", "#1象限", "#ai"]);
});

test("US-151: taskDisplayTags deduplicates repeated tags", () => {
  assert.deepEqual(taskDisplayTags(["#work", "#work", "life", ""]), ["#work", "#life"]);
});
