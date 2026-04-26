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

// task #57 (P1 regression): ctrdh's actual repro — drag a task from
// `Daily/2026-04-26.md` into `AI-Native的人生` in `Daily/2026-04-19.md`.
// The destination parent uses TAB-indented children; current
// `planCrossFileNest` hard-codes `parentIndent + "    "` (4 spaces) for
// the new child, which Obsidian's markdown list parser then nests under
// the LAST tab-indented sibling instead of the parent. Fix: derive the
// new-child indent from the parent's existing first-child indent style
// when present, else fall back to "    ".
//
// This test reproduces the exact mixed-indent shape from
// /Users/ctrdh/LifeSystem/Daily/2026-04-19.md:69-75 (one 4-space-indented
// outlier among otherwise tab-indented children, plus a deeper
// grandchild). The dragged subtree mirrors
// /Users/ctrdh/LifeSystem/Daily/2026-04-26.md:5-6 (a task with one
// 4-space-indented subchild).
test("planCrossFileNest — task #57: parent has TAB-indented children → new child must use TAB to stay parent's direct child, not Obsidian's 'last tab-indented sibling''s child", () => {
  // Mirrors `给Slock添加更多的AI CLI` + `让omar有管理这些cli skill的能力`.
  const childFileLines = [
    "- [ ] C_top ➕ 2026-04-26",
    "    - [ ] C_subchild",
  ];

  // Mirrors `AI-Native的人生` subtree at /…/2026-04-19.md:69-75 verbatim
  // for indent shape:
  //   L0: A_parent           — indent="" (root)
  //   L1: A_child_1          — indent="\t"
  //   L2:   A_grandchild     — indent="\t    "
  //   L3: A_child_2          — indent="\t"
  //   L4: A_child_3_done     — indent="\t"
  //   L5: A_child_4_4space   — indent="    "  (the one outlier user really has)
  //   L6: A_child_5          — indent="\t"
  const parentFileLines = [
    "- [ ] A_parent ⏳ 2026-04-26",
    "\t- [ ] A_child_1",
    "\t    - [ ] A_grandchild",
    "\t- [ ] A_child_2",
    "\t- [x] A_child_3_done ✅ 2026-04-24",
    "    - [ ] A_child_4_4space",
    "\t- [ ] A_child_5",
  ];

  const plan = planCrossFileNest(
    childFileLines,
    0, // C_top is at line 0 of child file
    0, // C_top's indent is "" (root) → indentLen 0
    parentFileLines,
    { line: 0, indentLen: 0 }, // A_parent at L0, indent="" → indentLen 0
  );

  // Source side: C_top + its subchild fully removed.
  assert.deepEqual(plan.newChildLines, []);

  // Destination side: the new child must use TAB indent so it parses as
  // A_parent's direct child. Currently the planner emits `"    "` (4
  // spaces), and after L6 (`\t- [ ] A_child_5`), Obsidian's CommonMark
  // list parser walks back up to the deepest preceding item whose
  // content column matches and treats `    - [ ] C_top` as a CHILD of
  // `\t- [ ] A_child_5`. That's the user-reported regression.
  //
  // After fix: new child uses `\t` (matching A_child_1/_2/_3/_5) and
  // C_subchild keeps its relative depth (so it ends up `\t    - [ ]`).
  assert.deepEqual(plan.newParentLines, [
    "- [ ] A_parent ⏳ 2026-04-26",
    "\t- [ ] A_child_1",
    "\t    - [ ] A_grandchild",
    "\t- [ ] A_child_2",
    "\t- [x] A_child_3_done ✅ 2026-04-24",
    "    - [ ] A_child_4_4space",
    "\t- [ ] A_child_5",
    "\t- [ ] C_top ➕ 2026-04-26",
    "\t    - [ ] C_subchild",
  ]);
});

// Coverage backstop: when the parent has NO existing children, the
// fallback to "    " (4 spaces) still applies. This keeps the original
// task-#37 scenario green.
test("planCrossFileNest — task #57 corollary: parent with NO children falls back to 4-space new-child indent", () => {
  const childFileLines = ["- [ ] moved"];
  const parentFileLines = ["- [ ] empty-parent"];
  const plan = planCrossFileNest(
    childFileLines,
    0,
    0,
    parentFileLines,
    { line: 0, indentLen: 0 },
  );
  assert.deepEqual(plan.newParentLines, [
    "- [ ] empty-parent",
    "    - [ ] moved",
  ]);
  assert.deepEqual(plan.newChildLines, []);
});

// task #57 v2: Jerry's mandatory review (msg `1e4304ab`) caught that the
// production cross-file `nestUnder()` runtime path duplicates the
// planner's indent decision INLINE (writer.ts:865 `parent.indent +
// "    "`) instead of delegating to `planCrossFileNest`. So the
// planner-only fix from `087fcbc` greens the unit but the actual
// vault-touching nestUnder cross-file write still emits 4-space.
//
// This test imports the runtime `nestUnder` and drives it through a
// minimal in-memory vault stub mirroring ctrdh's real setup. Asserts
// the parent file ends with `\t- [ ] C_top` (matching its existing
// TAB-indented children), not `    - [ ] C_top`.
const { nestUnder, TFile } = await import("../test/.compiled/writer.bundle.js");

test("nestUnder cross-file — task #57 runtime: production path also matches existing TAB-indented children", async () => {
  // ctrdh's real shape: parent file has TAB children with one 4-space
  // outlier; source file has a top-level task with one 4-space subchild.
  const parentInitial =
    "- [ ] A_parent ⏳ 2026-04-26\n" +
    "\t- [ ] A_child_1\n" +
    "\t- [ ] A_child_2\n" +
    "    - [ ] A_child_3_4space\n" +
    "\t- [ ] A_child_4\n";
  const childInitial =
    "- [ ] C_top ➕ 2026-04-26\n" +
    "    - [ ] C_subchild\n";

  // Vault stub: each file is a real TFile instance (so instanceof checks
  // inside nestUnder pass). Track each file's content; expose
  // getAbstractFileByPath, cachedRead, and `vault.process(file, fn)`.
  const fileObjs = new Map();
  const fileData = new Map();
  for (const [path, data] of [
    ["parent.md", parentInitial],
    ["child.md", childInitial],
  ]) {
    const f = new TFile();
    f.path = path;
    f.extension = "md";
    f.stat = { mtime: 1000 };
    fileObjs.set(path, f);
    fileData.set(path, data);
  }

  const app = {
    vault: {
      getAbstractFileByPath: (p) => fileObjs.get(p) ?? null,
      cachedRead: async (file) => fileData.get(file.path),
      process: async (file, fn) => {
        const data = fileData.get(file.path);
        const next = fn(data);
        fileData.set(file.path, next);
      },
    },
  };

  // Minimal ParsedTask shapes — only the fields nestUnder actually
  // reads (id, path, line, indent, rawLine, parentLine).
  const child = {
    id: "child.md:L0",
    path: "child.md",
    line: 0,
    indent: "",
    rawLine: "- [ ] C_top ➕ 2026-04-26",
    parentLine: null,
  };
  const parent = {
    id: "parent.md:L0",
    path: "parent.md",
    line: 0,
    indent: "",
    rawLine: "- [ ] A_parent ⏳ 2026-04-26",
    parentLine: null,
  };

  await nestUnder(app, child, parent);

  const parentAfter = fileData.get("parent.md");
  // The new child must use TAB to match A_child_1/_2/_4 (the dominant
  // indent style under A_parent). NOT 4-space — that would cause
  // CommonMark to nest under the last TAB-indented sibling.
  assert.ok(
    parentAfter.includes("\t- [ ] C_top ➕ 2026-04-26"),
    `parent file did not get TAB-indented C_top.\nGot:\n${parentAfter}`,
  );
  // C_subchild moves with C_top: was 4-space relative to C_top (root),
  // so under TAB-prefixed C_top it becomes "\t    - [ ] C_subchild".
  assert.ok(
    parentAfter.includes("\t    - [ ] C_subchild"),
    `parent file did not get C_subchild at the correct relative depth.\nGot:\n${parentAfter}`,
  );
  // The original C_top in child.md must be removed (cross-file move).
  const childAfter = fileData.get("child.md");
  assert.ok(
    !childAfter.includes("- [ ] C_top"),
    `child file still has C_top after move.\nGot:\n${childAfter}`,
  );
});
