import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", [
  "esbuild", "src/view/presentation.ts", "--bundle=true", "--format=esm",
  "--platform=node", "--outdir=test/.compiled", "--loader:.ts=ts",
], { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" });
if (result.status !== 0) throw new Error(`esbuild compile failed:\n${result.stderr}`);

const mod = () => import("../test/.compiled/presentation.js");

test("US-514: pane width maps to narrow, compact, and wide without input-modality assumptions", async () => {
  const { classifyPaneLayout } = await mod();
  assert.equal(classifyPaneLayout(520), "narrow");
  assert.equal(classifyPaneLayout(760), "compact");
  assert.equal(classifyPaneLayout(1200), "wide");
});
