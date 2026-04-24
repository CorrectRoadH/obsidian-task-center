// Unit tests for pure writer string-mutation helpers.
// Run with: `node --test test/writer.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Compile writer.ts as a self-contained ESM bundle with obsidian stubbed out.
function compile() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/writer.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outfile=test/.compiled/writer.bundle.js",
      "--external:obsidian",
      "--alias:obsidian=./test/obsidian-stub.mjs",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild failed:\n" + result.stderr);
  }
}

compile();
const {
  setEmojiDate,
  setInlineField,
  setCheckbox,
  addTagIfMissing,
  rebuildTaskLineWithNewTitle,
  indentLen,
  extractTaskBlock,
  findChildrenEnd,
  reindentBlock,
  planSameFileNest,
  planCrossFileNest,
  applyUndoOps,
} = await import("../test/.compiled/writer.bundle.js");

test("setEmojiDate — inject into bare line", () => {
  const r = setEmojiDate("- [ ] task", "⏳", "2026-04-25");
  assert.equal(r, "- [ ] task ⏳ 2026-04-25");
});

test("setEmojiDate — replace existing", () => {
  const r = setEmojiDate("- [ ] task ⏳ 2026-04-20", "⏳", "2026-04-25");
  assert.equal(r, "- [ ] task ⏳ 2026-04-25");
});

test("setEmojiDate — inject before Dataview field", () => {
  const r = setEmojiDate("- [ ] task [estimate:: 30m]", "⏳", "2026-04-25");
  assert.equal(r, "- [ ] task ⏳ 2026-04-25 [estimate:: 30m]");
});

test("setEmojiDate — clear (date=null)", () => {
  const r = setEmojiDate("- [ ] task ⏳ 2026-04-25", "⏳", null);
  assert.equal(r, "- [ ] task");
});

test("setEmojiDate — strip duplicate ⏳ defensively", () => {
  const r = setEmojiDate(
    "- [ ] task ⏳ 2026-04-20 ⏳ 2026-04-22",
    "⏳",
    "2026-04-25",
  );
  assert.equal(r, "- [ ] task ⏳ 2026-04-25");
});

test("setEmojiDate — different emoji preserved", () => {
  const r = setEmojiDate("- [ ] task 📅 2026-05-15 ⏳ 2026-04-20", "⏳", "2026-04-25");
  assert.equal(r, "- [ ] task 📅 2026-05-15 ⏳ 2026-04-25");
});

test("setCheckbox — todo → done", () => {
  assert.equal(setCheckbox("- [ ] foo", "x"), "- [x] foo");
});

test("setCheckbox — done → dropped", () => {
  assert.equal(setCheckbox("- [x] foo", "-"), "- [-] foo");
});

test("setCheckbox — callout prefix preserved", () => {
  assert.equal(setCheckbox("> - [ ] callout task", "x"), "> - [x] callout task");
});

test("setCheckbox — indented", () => {
  assert.equal(setCheckbox("    - [ ] sub", "x"), "    - [x] sub");
});

test("setInlineField — inject estimate", () => {
  const r = setInlineField("- [ ] task", "estimate", "30m");
  assert.equal(r, "- [ ] task [estimate:: 30m]");
});

test("setInlineField — replace existing actual", () => {
  const r = setInlineField("- [ ] task [actual:: 15m]", "actual", "45m");
  assert.equal(r, "- [ ] task [actual:: 45m]");
});

test("setInlineField — clear (value=null)", () => {
  const r = setInlineField("- [ ] task [estimate:: 30m]", "estimate", null);
  assert.equal(r, "- [ ] task");
});

test("addTagIfMissing — adds new tag", () => {
  assert.equal(addTagIfMissing("- [ ] task", "#2象限"), "- [ ] task #2象限");
});

test("addTagIfMissing — no-op if present", () => {
  const l = "- [ ] task #2象限";
  assert.equal(addTagIfMissing(l, "#2象限"), l);
});

test("addTagIfMissing — accepts bare tag", () => {
  assert.equal(addTagIfMissing("- [ ] task", "基建"), "- [ ] task #基建");
});

test("rebuildTaskLineWithNewTitle — plain", () => {
  assert.equal(
    rebuildTaskLineWithNewTitle("- [ ] old title", "new title"),
    "- [ ] new title",
  );
});

test("rebuildTaskLineWithNewTitle — preserves tags + ⏳ + [estimate::]", () => {
  const raw = "- [ ] old title #2象限 ⏳ 2026-04-25 [estimate:: 30m]";
  const r = rebuildTaskLineWithNewTitle(raw, "renamed");
  assert.equal(r, "- [ ] renamed #2象限 ⏳ 2026-04-25 [estimate:: 30m]");
});

test("rebuildTaskLineWithNewTitle — preserves 📅 ✅ ❌ ➕ 🛫", () => {
  const raw =
    "- [x] x #tag 📅 2026-05-15 🛫 2026-04-20 ⏳ 2026-04-22 ➕ 2026-04-18 ✅ 2026-04-23";
  const r = rebuildTaskLineWithNewTitle(raw, "y");
  assert.equal(
    r,
    "- [x] y #tag 📅 2026-05-15 🛫 2026-04-20 ⏳ 2026-04-22 ➕ 2026-04-18 ✅ 2026-04-23",
  );
});

test("rebuildTaskLineWithNewTitle — preserves recurrence", () => {
  const raw = "- [ ] old 🔁 every week ⏳ 2026-04-24";
  const r = rebuildTaskLineWithNewTitle(raw, "new");
  // 🔁 greedy capture swallows trailing space but metadata survives.
  assert.match(r, /🔁\s*every week\s*⏳\s*2026-04-24/);
  assert.match(r, /\[\s\] new/);
});

test("rebuildTaskLineWithNewTitle — preserves priority glyphs", () => {
  assert.equal(
    rebuildTaskLineWithNewTitle("- [ ] old 🔺", "new"),
    "- [ ] new 🔺",
  );
  assert.equal(
    rebuildTaskLineWithNewTitle("- [ ] old ⏬ #x", "new"),
    "- [ ] new ⏬ #x",
  );
});

test("rebuildTaskLineWithNewTitle — preserves block anchor", () => {
  assert.equal(
    rebuildTaskLineWithNewTitle("- [ ] old ^abc123", "new"),
    "- [ ] new ^abc123",
  );
});

test("rebuildTaskLineWithNewTitle — callout prefix preserved", () => {
  assert.equal(
    rebuildTaskLineWithNewTitle("> - [ ] old #tag", "new"),
    "> - [ ] new #tag",
  );
});

test("rebuildTaskLineWithNewTitle — non-task returns null", () => {
  assert.equal(rebuildTaskLineWithNewTitle("# heading", "x"), null);
  assert.equal(rebuildTaskLineWithNewTitle("- plain bullet", "x"), null);
});

// ---------- nest helpers ----------

test("indentLen — counts whitespace + callout prefix", () => {
  assert.equal(indentLen("- [ ] foo"), 0);
  assert.equal(indentLen("    - [ ] sub"), 4);
  assert.equal(indentLen("> - [ ] callout"), 2);
  assert.equal(indentLen("> > - [ ] nested callout"), 4);
  assert.equal(indentLen(">     - [ ] indented in callout"), 6);
});

test("extractTaskBlock — bare task, no descendants", () => {
  const lines = [
    "- [ ] A",
    "- [ ] B",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 0), ["- [ ] A"]);
});

test("extractTaskBlock — task with one subtask", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "- [ ] B",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 0), [
    "- [ ] A",
    "    - [ ] A.1",
  ]);
});

test("extractTaskBlock — task with grandchildren and a sibling", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "        - [ ] A.1.1",
    "    - [ ] A.2",
    "- [ ] B",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 0), [
    "- [ ] A",
    "    - [ ] A.1",
    "        - [ ] A.1.1",
    "    - [ ] A.2",
  ]);
});

test("extractTaskBlock — trims trailing blank lines", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "",
    "",
    "- [ ] B",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 0), [
    "- [ ] A",
    "    - [ ] A.1",
  ]);
});

test("extractTaskBlock — block at end of file (no terminator)", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 0), [
    "- [ ] A",
    "    - [ ] A.1",
  ]);
});

test("extractTaskBlock — callout-prefixed task", () => {
  const lines = [
    "> - [ ] in callout",
    ">     - [ ] sub in callout",
    "- [ ] outside",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 2), [
    "> - [ ] in callout",
    ">     - [ ] sub in callout",
  ]);
});

test("findChildrenEnd — empty parent (no children)", () => {
  const lines = [
    "- [ ] A",
    "- [ ] B",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 1);
});

test("findChildrenEnd — parent with one subtask", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "- [ ] B",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 2);
});

test("findChildrenEnd — parent at end of file", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 2);
});

test("findChildrenEnd — skips blank lines inside subtree", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "",
    "    - [ ] A.2",
    "- [ ] B",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 4);
});

test("findChildrenEnd — does NOT skip trailing blanks before next sibling", () => {
  // Critical: inserting after a blank line detaches the new item from the
  // parent's list. Must stop right after the last descendant.
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "",
    "",
    "- [ ] B",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 2);
});

test("findChildrenEnd — empty parent followed by blank then sibling", () => {
  const lines = [
    "- [ ] A",
    "",
    "- [ ] B",
  ];
  // No descendants → insertion point is right after the parent line.
  assert.equal(findChildrenEnd(lines, 0, 0), 1);
});

test("findChildrenEnd — no descendants, blanks then EOF", () => {
  const lines = [
    "- [ ] A",
    "",
    "",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 1);
});

test("reindentBlock — root + subtree, plain → indented", () => {
  const block = [
    "- [ ] A",
    "    - [ ] A.1",
    "        - [ ] A.1.1",
  ];
  assert.deepEqual(reindentBlock(block, 0, "    "), [
    "    - [ ] A",
    "        - [ ] A.1",
    "            - [ ] A.1.1",
  ]);
});

test("reindentBlock — moving deeper subtree to top level", () => {
  const block = [
    "    - [ ] A",
    "        - [ ] A.1",
  ];
  assert.deepEqual(reindentBlock(block, 4, ""), [
    "- [ ] A",
    "    - [ ] A.1",
  ]);
});

test("reindentBlock — strips callout prefix when target is plain", () => {
  const block = [
    "> - [ ] in callout",
    ">     - [ ] sub",
  ];
  assert.deepEqual(reindentBlock(block, 2, "    "), [
    "    - [ ] in callout",
    "        - [ ] sub",
  ]);
});

// ---------- applyUndoOps ----------

test("applyUndoOps — single-line replace (schedule undo)", () => {
  const lines = ["- [ ] task ⏳ 2026-04-25"];
  const ops = [
    {
      path: "a.md",
      line: 0,
      before: ["- [ ] task"],
      after: ["- [ ] task ⏳ 2026-04-25"],
    },
  ];
  const files = { "a.md": lines };
  const out = applyUndoOps(files, ops);
  assert.deepEqual(out["a.md"], ["- [ ] task"]);
});

test("applyUndoOps — reverse deletion (before=block, after=[])", () => {
  const files = { "a.md": ["- [ ] sibling"] };
  const ops = [{ path: "a.md", line: 0, before: ["- [ ] removed"], after: [] }];
  const out = applyUndoOps(files, ops);
  assert.deepEqual(out["a.md"], ["- [ ] removed", "- [ ] sibling"]);
});

test("applyUndoOps — reverse insertion (before=[], after=block)", () => {
  const files = { "a.md": ["- [ ] kept", "- [ ] inserted"] };
  const ops = [{ path: "a.md", line: 1, before: [], after: ["- [ ] inserted"] }];
  const out = applyUndoOps(files, ops);
  assert.deepEqual(out["a.md"], ["- [ ] kept"]);
});

test("applyUndoOps — multi-op applied in reverse order (delete-then-insert move)", () => {
  // Forward op modeled as: delete "A" at line 0, insert "A" at line 2 of the "without" array.
  // Final state ends up as [B, C, A]; undoing should restore [A, B, C].
  const files = { "a.md": ["- [ ] B", "- [ ] C", "- [ ] A"] };
  const ops = [
    { path: "a.md", line: 0, before: ["- [ ] A"], after: [] },
    { path: "a.md", line: 2, before: [], after: ["- [ ] A"] },
  ];
  const out = applyUndoOps(files, ops);
  assert.deepEqual(out["a.md"], ["- [ ] A", "- [ ] B", "- [ ] C"]);
});

test("applyUndoOps — mismatch on 'after' throws (drift guard)", () => {
  const files = { "a.md": ["- [ ] modified by user"] };
  const ops = [
    {
      path: "a.md",
      line: 0,
      before: ["- [ ] original"],
      after: ["- [ ] expected"],
    },
  ];
  assert.throws(() => applyUndoOps(files, ops), /diverged|drift|mismatch/i);
});

// ---------- planSameFileNest ----------

test("planSameFileNest — nest sibling under preceding task", () => {
  const lines = ["- [ ] Parent", "- [ ] Child"];
  const plan = planSameFileNest(lines, /*childLine*/ 1, /*childIndentLen*/ 0, /*parent*/ { line: 0, indentLen: 0 });
  assert.deepEqual(plan.newLines, ["- [ ] Parent", "    - [ ] Child"]);
  // Undo restores.
  const files = { "f.md": plan.newLines };
  const restored = applyUndoOps(files, plan.undoOps.map((o) => ({ ...o, path: "f.md" })));
  assert.deepEqual(restored["f.md"], lines);
});

test("planSameFileNest — nest preceding task under later one", () => {
  const lines = ["- [ ] Child", "- [ ] Parent"];
  const plan = planSameFileNest(lines, 0, 0, { line: 1, indentLen: 0 });
  assert.deepEqual(plan.newLines, ["- [ ] Parent", "    - [ ] Child"]);
  const files = { "f.md": plan.newLines };
  const restored = applyUndoOps(files, plan.undoOps.map((o) => ({ ...o, path: "f.md" })));
  assert.deepEqual(restored["f.md"], lines);
});

test("planSameFileNest — preserves grandchildren when moving", () => {
  const lines = [
    "- [ ] A",
    "- [ ] B",
    "    - [ ] B.1",
    "        - [ ] B.1.1",
  ];
  const plan = planSameFileNest(lines, 1, 0, { line: 0, indentLen: 0 });
  assert.deepEqual(plan.newLines, [
    "- [ ] A",
    "    - [ ] B",
    "        - [ ] B.1",
    "            - [ ] B.1.1",
  ]);
  const files = { "f.md": plan.newLines };
  const restored = applyUndoOps(files, plan.undoOps.map((o) => ({ ...o, path: "f.md" })));
  assert.deepEqual(restored["f.md"], lines);
});

// ---------- planCrossFileNest ----------

test("planCrossFileNest — undo restores both files", () => {
  const childFileLines = [
    "- [ ] moved task",
    "    - [ ] subtask",
    "- [ ] sibling",
  ];
  const parentFileLines = ["- [ ] target parent"];
  const plan = planCrossFileNest(
    childFileLines,
    /*childLine*/ 0,
    /*childIndentLen*/ 0,
    parentFileLines,
    /*parent*/ { line: 0, indentLen: 0 },
  );
  assert.deepEqual(plan.newChildLines, ["- [ ] sibling"]);
  assert.deepEqual(plan.newParentLines, [
    "- [ ] target parent",
    "    - [ ] moved task",
    "        - [ ] subtask",
  ]);
  // Apply undo across both files.
  const files = {
    "child.md": plan.newChildLines,
    "parent.md": plan.newParentLines,
  };
  const withPaths = plan.undoOps.map((o) => ({
    ...o,
    path: o.which === "child" ? "child.md" : "parent.md",
  }));
  const restored = applyUndoOps(files, withPaths);
  assert.deepEqual(restored["child.md"], childFileLines);
  assert.deepEqual(restored["parent.md"], parentFileLines);
});

test("planCrossFileNest — destination insertion appears right after parent's last descendant", () => {
  const childFileLines = ["- [ ] moved", "- [ ] stays"];
  const parentFileLines = [
    "- [ ] parent",
    "    - [ ] existing-child",
    "- [ ] next-sibling",
  ];
  const plan = planCrossFileNest(
    childFileLines,
    0,
    0,
    parentFileLines,
    { line: 0, indentLen: 0 },
  );
  // Inserted block should sit *after* existing-child (last descendant), before next-sibling.
  assert.deepEqual(plan.newParentLines, [
    "- [ ] parent",
    "    - [ ] existing-child",
    "    - [ ] moved",
    "- [ ] next-sibling",
  ]);
  assert.deepEqual(plan.newChildLines, ["- [ ] stays"]);
});
