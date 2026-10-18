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

test("US-303: area totals exclude missing values and ratio uses paired durations", async () => {
  const { summarizeAreaTasks } = await mod();
  assert.deepEqual(summarizeAreaTasks([
    { estimate: 60, actual: 90, effectiveStatus: "done" },
    { estimate: 30, actual: null, effectiveStatus: "todo" },
    { estimate: null, actual: 45, effectiveStatus: "done" },
    { estimate: 20, actual: null, effectiveStatus: "done" },
  ]), { count: 4, estimate: 110, actual: 135, hasDone: true, percent: 150 });
  assert.deepEqual(summarizeAreaTasks([{ estimate: 60, actual: 30, effectiveStatus: "todo" }]), { count: 1, estimate: 60, actual: 30, hasDone: false, percent: 50 });
  assert.equal(summarizeAreaTasks([{ estimate: 0, actual: 5, effectiveStatus: "done" }]).percent, null);
});
