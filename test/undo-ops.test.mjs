// buildLineUndoOps — the pure mapping behind TaskCenterView.recordUndoableWrite
// (US-128 / US-508 移动端可点撤销). Covers single-line writes, cascade results
// (done / drop parent + children), and unchanged filtering.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const r = spawnSync(
    "npx",
    [
      "esbuild",
      "src/view/undo.ts",
      "--bundle=true",
      "--format=esm",
      "--platform=node",
      "--alias:obsidian=./test/obsidian-stub.mjs",
      "--outdir=test/.compiled",
      "--loader:.ts=ts",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error("esbuild compile failed:\n" + r.stderr);
}
compilePure();
const { buildLineUndoOps } = await import("../test/.compiled/undo.js");

const at = (path, line) => ({ path, line });

test("US-508: single-line result maps to one forward op at the fallback location", () => {
  const ops = buildLineUndoOps(at("Tasks/a.md", 3), {
    before: "- [ ] x",
    after: "- [x] x ✅ 2026-07-02",
    unchanged: false,
  });
  assert.deepEqual(ops, [
    { path: "Tasks/a.md", line: 3, before: ["- [ ] x"], after: ["- [x] x ✅ 2026-07-02"] },
  ]);
});

test("US-508: unchanged single-line result produces no ops (nothing to undo)", () => {
  const ops = buildLineUndoOps(at("Tasks/a.md", 3), {
    before: "- [x] x",
    after: "- [x] x",
    unchanged: true,
  });
  assert.deepEqual(ops, []);
});

test("US-145/US-124: cascade `results` map to one op per CHANGED line, forward order", () => {
  const ops = buildLineUndoOps(at("Tasks/a.md", 0), {
    before: "- [ ] parent",
    after: "- [x] parent ✅",
    unchanged: false,
    results: [
      { path: "Tasks/a.md", line: 2, before: "- [ ] child", after: "- [x] child ✅" },
      { path: "Tasks/a.md", line: 1, before: "- [x] done-child", after: "- [x] done-child" },
      { path: "Tasks/a.md", line: 0, before: "- [ ] parent", after: "- [x] parent ✅" },
    ],
  });
  assert.deepEqual(ops.map((o) => o.line), [2, 0], "skips the untouched line, keeps forward order");
  assert.deepEqual(ops[1], {
    path: "Tasks/a.md",
    line: 0,
    before: ["- [ ] parent"],
    after: ["- [x] parent ✅"],
  });
});

test("US-128: undo retains only the latest 20 board writes", async () => {
  const { UndoStack } = await import("../test/.compiled/undo.js");
  const labels = [];
  const stack = new UndoStack({}, { onApplied() {}, notify: label => labels.push(label) });
  for (let i = 0; i < 25; i++) stack.push({ label: String(i), ops: [] });
  assert.equal(stack.size(), 20);
  for (let i = 0; i < 20; i++) await stack.pop();
  assert.equal(labels[0], "undo: 24");
  assert.equal(labels[19], "undo: 5");
  assert.equal(stack.size(), 0);
});
