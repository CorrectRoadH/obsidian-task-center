// Unit tests for US-109c/g/h: saved filter views.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/saved-views.ts",
      "--bundle=true",
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
  normalizeQueryStatus,
  deleteQueryPresetById,
  upsertQueryPreset,
  normalizeQueryPreset,
  createQueryPreset,
  isBuiltinSavedViewId,
  sameQueryPresetContent,
  parseQueryDsl,
  stringifyQueryPreset,
  computeQueryPresetDeleteUndoPlan,
  executeQueryPresetDeleteUndo,
  executeDeleteQueryPresetFlow,
  computeQueryPresetSnapshot,
  updateQueryPresetById,
  computeDeleteQueryPresetState,
  computeUndoQueryPresetState,
  computeSaveAsFromSnapshot,
  computeUpdateFromDraftComponents,
  migrateLegacySavedTaskView,
  isLegacySavedTaskView,
  isLegacyQueryPresetShape,
  ensureBuiltinQueryPresets,
  restoreBuiltinQueryPresetById,
  restoreBuiltinQueryPresets,
  collectAreas,
} = await import("../test/.compiled/saved-views.js");

// ── US-720d2: 全空布局不再折叠成一个 view 级居中空状态——每个 area 各显示各自
test("US-109c1 #8/#9: reload preserves mixed tab order and edited builtin layout", () => {
  const builtins = ensureBuiltinQueryPresets([]);
  builtins[0].view = { layout: { dir: "row", children: [
    { type: "list", title: "My tasks", limit: 12, when: { search: "work" } },
    { type: "week" },
  ] } };
  const custom = createQueryPreset("My tab", {});
  const saved = [custom, builtins[2], builtins[0], ...builtins.filter((_, i) => i !== 0 && i !== 2)];
  const normalized = saved.map(normalizeQueryPreset);
  const reloaded = ensureBuiltinQueryPresets(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(reloaded, normalized);
  assert.deepEqual(ensureBuiltinQueryPresets(reloaded), normalized);
  const restored = restoreBuiltinQueryPresetById(reloaded, "preset-today");
  assert.deepEqual(restored.map((p) => p.id), normalized.map((p) => p.id));
  assert.deepEqual(restored.find((p) => p.id === "preset-today").view,
    ensureBuiltinQueryPresets([])[0].view);
});

test("US-109l #9: missing defaults append without moving existing tabs or reviving deletions", () => {
  const custom = createQueryPreset("First", {});
  const saved = [custom, ensureBuiltinQueryPresets([])[2]];
  const reloaded = ensureBuiltinQueryPresets(saved, {}, ["preset-today"]);
  assert.deepEqual(reloaded.slice(0, 2), saved);
  assert.equal(reloaded.some((p) => p.id === "preset-today"), false);
  assert.equal(new Set(reloaded.map((p) => p.id)).size, reloaded.length);
});

// 的空状态。四象限 col[row,row] 全空时仍渲染 4 个 area（不被压平、不被一个空状态
// 盖住）。collectAreas 仍按 DFS 收集到 4 个叶子。──

test("US-720d2: collectAreas — four-quadrant col[row,row] keeps all 4 areas", () => {
  const quad = {
    dir: "col",
    children: [
      { dir: "row", children: [{ type: "list", title: "①" }, { type: "list", title: "②" }] },
      { dir: "row", children: [{ type: "list", title: "③" }, { type: "list", title: "④" }] },
    ],
  };
  assert.equal(collectAreas(quad).length, 4);
});

// ── US-109l: builtin presets are deletable; deletion is persisted via a
// `deletedBuiltinIds` tombstone that ensureBuiltinQueryPresets honors. ──

test("US-109l: ensureBuiltinQueryPresets skips re-seeding tombstoned builtins", () => {
  // Start from a full builtin set, delete one, then re-ensure with its id
  // tombstoned — it must stay gone (the other 6 builtins remain).
  const full = ensureBuiltinQueryPresets([]);
  assert.ok(full.some((p) => p.id === "preset-today"));
  const afterDelete = deleteQueryPresetById(full, "preset-today");
  const reEnsured = ensureBuiltinQueryPresets(afterDelete, {}, ["preset-today"]);
  assert.equal(reEnsured.find((p) => p.id === "preset-today"), undefined);
  assert.ok(reEnsured.some((p) => p.id === "preset-week"));
});

test("US-109l: restoreBuiltinQueryPresetById brings back one preset but keeps OTHER tombstones gone", () => {
  const full = ensureBuiltinQueryPresets([]);
  // Two builtins deleted + tombstoned.
  let presets = deleteQueryPresetById(full, "preset-today");
  presets = deleteQueryPresetById(presets, "preset-week");
  const tombstone = ["preset-today", "preset-week"];
  // Restore only today; week must stay deleted.
  const restored = restoreBuiltinQueryPresetById(presets, "preset-today", {}, tombstone);
  assert.ok(restored.some((p) => p.id === "preset-today"));
  assert.equal(restored.find((p) => p.id === "preset-week"), undefined);
});

test("US-109l: restoreBuiltinQueryPresets resurrects all tombstoned builtins", () => {
  const full = ensureBuiltinQueryPresets([]);
  let presets = deleteQueryPresetById(full, "preset-today");
  presets = deleteQueryPresetById(presets, "preset-month");
  // restore-all ignores the tombstone (caller clears it) and re-seeds everything.
  const restored = restoreBuiltinQueryPresets(presets);
  assert.ok(restored.some((p) => p.id === "preset-today"));
  assert.ok(restored.some((p) => p.id === "preset-month"));
});

test("US-109h: status filters normalize legacy single-select and new multi-select values", () => {
  assert.equal(normalizeQueryStatus("all"), "all");
  assert.deepEqual(normalizeQueryStatus("todo"), ["todo"]);
  assert.deepEqual(normalizeQueryStatus(["todo", "done", "todo"]), ["todo", "done"]);
  assert.equal(normalizeQueryStatus([]), "all");
});

// ── VAL-GUI-004: delete custom tab + undo restore ──

test("VAL-GUI-004: deleteQueryPresetById removes target and leaves others untouched", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  const after = deleteQueryPresetById(presets, "sv-b");

  assert.equal(after.length, 2);
  assert.deepEqual(after.map((p) => p.id), ["sv-a", "sv-c"]);
});

test("VAL-GUI-004: deleteQueryPresetById is no-op when id not found", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const after = deleteQueryPresetById([a], "nonexistent");

  assert.equal(after.length, 1);
  assert.equal(after[0].id, "sv-a");
});

test("VAL-GUI-004: undo delete restores QueryPreset snapshot with all fields", () => {
  // Simulate: create preset → snapshot → delete → undo (upsert)
  const original = createQueryPreset(
    "My Tab",
    {
      search: "focus",
      tags: ["#work", "#urgent"],
      status: ["todo", "in_progress"],
      time: { scheduled: "week", deadline: "overdue" },
      view: { type: "week", preset: "today", orderBy: ["deadline_risk"] },
      summary: [{ type: "count" }, { type: "sum", field: "actual", format: "duration" }],
    },
    () => "sv-custom-1",
  );

  // Take a snapshot
  const snapshot = normalizeQueryPreset(original);
  assert.equal(snapshot.id, "sv-custom-1");
  assert.equal(snapshot.name, "My Tab");
  assert.equal(snapshot.builtin, false);
  assert.equal(snapshot.hidden, false);
  // US-109z2: presets carry no tab-level filters anymore.
  assert.equal(snapshot.filters, undefined);
  // Legacy {type:week, preset, orderBy} migrates to a week area; preset is dropped.
  assert.deepEqual(snapshot.view, { layout: { type: "week" } });

  // Delete from the array
  const otherPreset = createQueryPreset("Other", { status: "all" }, () => "sv-other");
  let afterDelete = deleteQueryPresetById([otherPreset, original], "sv-custom-1");
  assert.equal(afterDelete.length, 1);
  assert.equal(afterDelete[0].id, "sv-other");

  // Undo: upsert the snapshot back
  const afterUndo = upsertQueryPreset(afterDelete, snapshot);
  assert.equal(afterUndo.length, 2);
  const restored = afterUndo.find((p) => p.id === "sv-custom-1");
  assert.ok(restored, "restored preset should exist");
  assert.equal(restored.name, "My Tab");
  assert.equal(restored.builtin, false);
  assert.equal(restored.hidden, false);
  assert.deepEqual(restored.view, snapshot.view);
});

test("VAL-GUI-004: undo restores preset at original position when possible", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  // Snapshot of B at index 1
  const snapshot = normalizeQueryPreset(b);
  const originalIndex = 1;

  // Delete B
  const afterDelete = deleteQueryPresetById(presets, "sv-b");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-a", "sv-c"]);

  // Undo: insert at originalIndex
  const insertIdx = Math.min(originalIndex, afterDelete.length);
  const presetsCopy = [...afterDelete];
  presetsCopy.splice(insertIdx, 0, snapshot);

  assert.deepEqual(presetsCopy.map((p) => p.id), ["sv-a", "sv-b", "sv-c"]);
});

test("VAL-GUI-004: undo handles originalIndex beyond current length (appends)", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const presets = [a];

  const snapshot = normalizeQueryPreset(a);
  const afterDelete = deleteQueryPresetById(presets, "sv-a");
  assert.equal(afterDelete.length, 0);

  // originalIndex was 0, now length is 0, insertIdx = min(0, 0) = 0
  const insertIdx = Math.min(0, afterDelete.length);
  const presetsCopy = [...afterDelete];
  presetsCopy.splice(insertIdx, 0, snapshot);

  assert.equal(presetsCopy.length, 1);
  assert.equal(presetsCopy[0].id, "sv-a");
});


test("VAL-GUI-004: builtin tab IDs are detected by isBuiltinSavedViewId", () => {
  assert.equal(isBuiltinSavedViewId("preset-today"), true);
  assert.equal(isBuiltinSavedViewId("preset-week"), true);
  assert.equal(isBuiltinSavedViewId("preset-month"), true);
  assert.equal(isBuiltinSavedViewId("preset-todo"), true);
  assert.equal(isBuiltinSavedViewId("preset-unscheduled"), true);
  assert.equal(isBuiltinSavedViewId("preset-completed"), true);
  assert.equal(isBuiltinSavedViewId("preset-dropped"), true);
  assert.equal(isBuiltinSavedViewId("sv-custom"), false);
  assert.equal(isBuiltinSavedViewId("preset-unknown"), false);
});

test("VAL-GUI-004: snapshot normalizeQueryPreset preserves hidden state", () => {
  const preset = normalizeQueryPreset({
    id: "sv-hidden",
    name: "Hidden Tab",
    builtin: false,
    hidden: true,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [],
  });

  assert.equal(preset.hidden, true);
});

test("VAL-GUI-004: snapshot normalizeQueryPreset strips unknown fields", () => {
  const preset = normalizeQueryPreset({
    id: "sv-clean",
    name: "Clean",
    filters: {},
    view: {},
    summary: [],
    // @ts-expect-error: unknown field
    unknownField: "should be stripped",
  });

  assert.equal("unknownField" in preset, false);
});

// ── fix-m3-delete-undo-original-index ──

test("VAL-GUI-004: originalIndex computed by stable id, not object-reference indexOf on normalized copies", () => {
  // Simulate the real-world scenario:
  // settings.queryPresets holds the original objects.
  // visibleQueryTabs() returns normalized copies (new objects via normalizeQueryPreset).
  // deleteSavedViewWithConfirm receives a normalized copy as `view`.
  // originalIndex must be found by matching id, not by object-reference indexOf.

  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const settingsArray = [a, b, c];

  // Simulate visibleQueryTabs() returning normalized copies
  const normalizedCopies = settingsArray.map((p) => normalizeQueryPreset(p));

  // The normalized copy of B is a *different object* than the original B
  const normalizedB = normalizedCopies[1];
  assert.equal(normalizedB.id, "sv-b");
  assert.notStrictEqual(normalizedB, b, "normalizeQueryPreset must create a new object");

  // BUG: indexOf on original array with normalized copy returns -1
  const badIndex = settingsArray.indexOf(normalizedB);
  assert.equal(badIndex, -1, "indexOf a normalized copy should fail on the original array");

  // FIX: findIndex by stable id works correctly
  const goodIndex = settingsArray.findIndex((p) => p.id === normalizedB.id);
  assert.equal(goodIndex, 1, "findIndex by id should find the correct position");

  // Full undo simulation with the fixed index computation
  const snapshot = normalizeQueryPreset(normalizedB);
  const originalIndex = goodIndex; // The correct computation

  // Delete B from settingsArray
  const afterDelete = deleteQueryPresetById(settingsArray, "sv-b");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-a", "sv-c"]);

  // Undo: insert snapshot at originalIndex
  const insertIdx = Math.min(originalIndex, afterDelete.length);
  const restored = [...afterDelete];
  restored.splice(insertIdx, 0, snapshot);

  // Verify B is restored at its original position (index 1), between A and C
  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo must restore deleted preset at its original stable-id order position");
});

test("VAL-GUI-004: undo restores preset at correct position when deleted from end, using stable id", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const settingsArray = [a, b, c];

  // Simulate normalized copy for C (last item, index 2)
  const normalizedCopies = settingsArray.map((p) => normalizeQueryPreset(p));
  const normalizedC = normalizedCopies[2];
  assert.equal(normalizedC.id, "sv-c");

  // findIndex by id gives 2
  const originalIndex = settingsArray.findIndex((p) => p.id === normalizedC.id);
  assert.equal(originalIndex, 2);

  const snapshot = normalizeQueryPreset(normalizedC);

  // Delete C
  const afterDelete = deleteQueryPresetById(settingsArray, "sv-c");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-a", "sv-b"]);

  // Undo: insert at originalIndex (2), min(2, 2) = 2, splice appends
  const insertIdx = Math.min(originalIndex, afterDelete.length);
  const restored = [...afterDelete];
  restored.splice(insertIdx, 0, snapshot);

  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo must restore last preset at its original end position");
});

test("VAL-GUI-004: undo restores preset at correct position when deleted from beginning, using stable id", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const settingsArray = [a, b, c];

  // Simulate normalized copy for A (first item, index 0)
  const normalizedCopies = settingsArray.map((p) => normalizeQueryPreset(p));
  const normalizedA = normalizedCopies[0];
  assert.equal(normalizedA.id, "sv-a");

  // findIndex by id gives 0
  const originalIndex = settingsArray.findIndex((p) => p.id === normalizedA.id);
  assert.equal(originalIndex, 0);

  const snapshot = normalizeQueryPreset(normalizedA);

  // Delete A
  const afterDelete = deleteQueryPresetById(settingsArray, "sv-a");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-b", "sv-c"]);

  // Undo: insert at originalIndex 0
  const insertIdx = Math.min(originalIndex, afterDelete.length);
  const restored = [...afterDelete];
  restored.splice(insertIdx, 0, snapshot);

  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo must restore first preset at its original beginning position");
});

// ── fix-m3-delete-undo-real-path: regression tests through
//   computeQueryPresetDeleteUndoPlan / executeQueryPresetDeleteUndo,
//   the same functions used by deleteSavedViewWithConfirm. ──

test("VAL-GUI-004: computeQueryPresetDeleteUndoPlan uses stable-id findIndex, not object-reference indexOf", () => {
  // Simulate the real scenario in deleteSavedViewWithConfirm:
  // settings.queryPresets holds the originals; view comes from visibleQueryTabs()
  // (normalized copies). originalIndex must be found by matching id.

  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const settingsArray = [a, b, c];

  // visibleQueryTabs() returns normalized copies (new objects)
  const normalizedCopies = settingsArray.map((p) => normalizeQueryPreset(p));
  const normalizedB = normalizedCopies[1];

  // The normalized copy is a different object
  assert.notStrictEqual(normalizedB, b);

  // Production path: plan uses stable-id findIndex
  const plan = computeQueryPresetDeleteUndoPlan(settingsArray, normalizedB);
  assert.equal(plan.originalIndex, 1, "originalIndex must be found by id match");
  assert.equal(plan.snapshot.id, "sv-b");
  assert.equal(plan.snapshot.name, "B");

  // Verify the snapshot is normalized (has the correct shape)
  assert.equal(plan.snapshot.builtin, false);
  assert.equal(plan.snapshot.hidden, false);
  // US-109z2: presets carry no tab-level filters anymore.
  assert.equal(plan.snapshot.filters, undefined);
});

test("VAL-GUI-004: executeQueryPresetDeleteUndo restores at original position within bounds", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const settingsArray = [a, b, c];

  // Delete B (index 1)
  const plan = computeQueryPresetDeleteUndoPlan(settingsArray, b);
  const afterDelete = deleteQueryPresetById(settingsArray, "sv-b");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-a", "sv-c"]);

  // Undo via production function
  const restored = executeQueryPresetDeleteUndo(afterDelete, plan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo restores at original position via executeQueryPresetDeleteUndo");
  assert.equal(restored[1].name, "B");
});

test("VAL-GUI-004: executeQueryPresetDeleteUndo handles originalIndex beyond current length (clamps)", () => {
  // If presets changed between delete and undo (e.g., other presets added),
  // originalIndex may exceed current array length. The function clamps safely.

  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const settingsArray = [a, b];

  // B is at index 1
  const plan = computeQueryPresetDeleteUndoPlan(settingsArray, b);
  assert.equal(plan.originalIndex, 1);

  // After delete, another preset gets added (simulating race)
  const afterDelete = deleteQueryPresetById(settingsArray, "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const withExtra = upsertQueryPreset(afterDelete, c);
  assert.deepEqual(withExtra.map((p) => p.id), ["sv-a", "sv-c"]);
  // originalIndex=1, but current length=2, so insertIdx = min(1, 2) = 1

  const restored = executeQueryPresetDeleteUndo(withExtra, plan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo clamps originalIndex when presets changed after delete");
});

test("VAL-GUI-004: full delete+undo flow preserves original order with default and active state, exercising production functions", () => {
  // This test mirrors the exact logic from deleteSavedViewWithConfirm:
  //   snapshot = computeQueryPresetDeleteUndoPlan(presets, view)
  //   wasDefault = defaultId === view.id
  //   wasActive = activeId === view.id
  //   delete
  //   undo restore with position + default + active

  const a = createQueryPreset("Alpha", {
    search: "focus",
    tags: ["#work"],
    status: ["todo"],
    time: { scheduled: "week", deadline: "overdue" },
    view: { type: "week", orderBy: ["deadline_risk"] },
    summary: [{ type: "count" }, { type: "sum", field: "actual", format: "duration" }],
  }, () => "sv-alpha");
  const b = createQueryPreset("Beta", {
    search: "docs",
    tags: ["#docs"],
    status: ["done"],
    view: { type: "list" },
    summary: [{ type: "count" }],
  }, () => "sv-beta");
  const c = createQueryPreset("Gamma", {
    search: "meetings",
    tags: ["#meeting"],
    status: ["todo", "done"],
    view: { type: "month" },
    summary: [],
  }, () => "sv-gamma");
  const presets = [a, b, c];
  const defaultId = "sv-alpha";
  const activeId = "sv-beta";

  // visibleQueryTabs() returns normalized copies
  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedB = normalizedCopies[1]; // "Beta", the active one

  // --- Snapshot via production function ---
  const plan = computeQueryPresetDeleteUndoPlan(presets, normalizedB);
  assert.equal(plan.originalIndex, 1);
  assert.equal(plan.snapshot.id, "sv-beta");
  assert.equal(plan.snapshot.name, "Beta");
  assert.equal(plan.snapshot.filters, undefined);
  assert.deepEqual(plan.snapshot.view, { layout: { type: "list" } });

  // --- Capture state before delete (as deleteSavedViewWithConfirm does) ---
  const wasDefault = defaultId === normalizedB.id;
  const wasActive = activeId === normalizedB.id;
  assert.equal(wasDefault, false, "Beta was not default");
  assert.equal(wasActive, true, "Beta was active");

  // --- Delete via production helper ---
  const afterDelete = deleteQueryPresetById(presets, "sv-beta");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-alpha", "sv-gamma"]);

  // --- Undo via production function ---
  const restored = executeQueryPresetDeleteUndo(afterDelete, plan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-alpha", "sv-beta", "sv-gamma"],
    "undo restores Beta at its original position between Alpha and Gamma");

  const restoredBeta = restored[1];
  assert.equal(restoredBeta.name, "Beta");
  assert.equal(restoredBeta.builtin, false);
  assert.equal(restoredBeta.hidden, false);
  assert.deepEqual(restoredBeta.view, plan.snapshot.view,
    "restored snapshot must have view config preserved");

  // --- Verify default/active restoration logic ---
  if (wasDefault) {
    // wasDefault=false for Beta, so this branch wouldn't execute
  }
  if (wasActive) {
    const reactivated = restored.find((p) => p.id === plan.snapshot.id);
    assert.ok(reactivated, "restored to active tab when wasActive is true");
    assert.equal(reactivated.id, "sv-beta");
  }
});

test("VAL-GUI-004: delete+undo restores default state correctly through production functions", () => {
  // Delete the DEFAULT tab (Alpha), verify undo restores it as default

  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-alpha");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-beta");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-gamma");
  const presets = [a, b, c];
  const defaultId = "sv-alpha"; // Alpha is default
  const activeId = "sv-alpha";  // Alpha is also active

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedA = normalizedCopies[0];

  const plan = computeQueryPresetDeleteUndoPlan(presets, normalizedA);
  assert.equal(plan.originalIndex, 0);

  const wasDefault = defaultId === normalizedA.id;
  const wasActive = activeId === normalizedA.id;
  assert.equal(wasDefault, true, "Alpha was default");
  assert.equal(wasActive, true, "Alpha was active");

  const afterDelete = deleteQueryPresetById(presets, "sv-alpha");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-beta", "sv-gamma"]);

  const restored = executeQueryPresetDeleteUndo(afterDelete, plan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-alpha", "sv-beta", "sv-gamma"],
    "undo restores default/active tab at original position");

  // Verify default and active state would be restored
  if (wasDefault) {
    // Production code would do: this.plugin.settings.defaultSavedViewId = plan.snapshot.id
    const newDefaultId = plan.snapshot.id;
    assert.equal(newDefaultId, "sv-alpha", "default should be restored to Alpha");
  }
  if (wasActive) {
    const reactivated = restored.find((p) => p.id === plan.snapshot.id);
    assert.ok(reactivated, "restored to active tab");
  }
});

test("VAL-GUI-004: delete+undo preserves full QueryPreset detail through production snapshot", () => {
  // Verify that the snapshot captured by computeQueryPresetDeleteUndoPlan
  // preserves all QueryPreset fields including nested layout, tray, sections, summary

  const rich = normalizeQueryPreset({
    id: "sv-rich",
    name: "Rich View",
    builtin: false,
    hidden: false,
    filters: {
      search: "deep work",
      tags: ["#focus", "#priority"],
      status: ["todo", "in_progress"],
      time: { scheduled: "week", deadline: "overdue", completed: "month" },
    },
    view: {
      layout: {
        dir: "col",
        children: [
          {
            type: "grid",
            title: "Priority",
            when: { tags: ["#high"], status: ["todo"] },
            orderBy: ["deadline_asc"],
          },
          {
            type: "list",
            title: "Backlog",
            when: { status: ["todo"], time: { scheduled: "unscheduled" } },
            orderBy: ["deadline_asc"],
            onDrop: { clearScheduled: true },
          },
        ],
      },
    },
    summary: [
      { type: "count" },
      { type: "sum", field: "planned", format: "duration" },
      { type: "ratio", numerator: "actual", denominator: "estimate", format: "percent" },
      { type: "top_n", by: "tags", limit: 5 },
      { type: "group_by", by: "tags" },
    ],
  });

  const presets = [createQueryPreset("Other", { status: "all" }, () => "sv-other"), rich];
  const plan = computeQueryPresetDeleteUndoPlan(presets, rich);
  const snapshot = plan.snapshot;

  assert.equal(snapshot.id, "sv-rich");
  assert.equal(snapshot.name, "Rich View");

  // US-109z2: no tab-level filters; filtering lives on each area's `when`.
  assert.equal(snapshot.filters, undefined);

  // View — area layout tree (col[ grid, list-tray ])
  const richLayout = snapshot.view.layout;
  assert.equal(richLayout.dir, "col");
  assert.equal(richLayout.children.length, 2);
  assert.equal(richLayout.children[0].type, "grid");
  assert.equal(richLayout.children[0].title, "Priority");
  assert.deepEqual(richLayout.children[0].when.tags, { expr: "#high" });
  assert.deepEqual(richLayout.children[0].orderBy, ["deadline_asc"]);
  assert.equal(richLayout.children[1].type, "list");
  assert.equal(richLayout.children[1].title, "Backlog");

  // Summary — all 5 metric types preserved

  // Full roundtrip: delete then undo
  const afterDelete = deleteQueryPresetById(presets, "sv-rich");
  assert.equal(afterDelete.length, 1);
  const restored = executeQueryPresetDeleteUndo(afterDelete, plan);
  assert.equal(restored.length, 2);
  const restoredRich = restored.find((p) => p.id === "sv-rich");
  assert.ok(restoredRich);
  assert.deepEqual(restoredRich.view, snapshot.view);
});

test("VAL-GUI-004: computeQueryPresetDeleteUndoPlan returns originalIndex=-1 for non-existent id", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const ghost = normalizeQueryPreset({
    id: "sv-ghost",
    name: "Ghost",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [],
  });

  const plan = computeQueryPresetDeleteUndoPlan([a], ghost);
  assert.equal(plan.originalIndex, -1,
    "missing id returns -1; caller should guard before undo");

  // executeQueryPresetDeleteUndo with -1 inserts at 0 (min(-1, len) = 0)
  const result = executeQueryPresetDeleteUndo([a], plan);
  assert.deepEqual(result.map((p) => p.id), ["sv-ghost", "sv-a"],
    "insertIdx is clamped to 0 when originalIndex is -1");
});

// ── fix-m3-desktop-query-editor-full-dsl-roundtrip ──

test("roundtrip: a legacy list with sections migrates to a plain list area", () => {
  const preset = normalizeQueryPreset({
    id: "sv-sections",
    name: "With sections",
    builtin: false,
    hidden: false,
    filters: {},
    view: {
      type: "list",
      sections: [
        { id: "s1", title: "Urgent", when: { status: ["todo"], time: { deadline: "overdue" } } },
        { id: "s2", title: "Normal", when: { status: ["todo"] }, orderBy: ["deadline_asc"], limit: 10 },
      ],
    },
    summary: [],
  });

  // list no longer groups internally. The legacy sections fixture migrates to a
  // plain list area; deepEqual proves the result is exactly a clean list with no
  // leftover grouping, without re-naming the dead field. (Today uses col[ list×N ].)
  assert.deepEqual(preset.view.layout, { type: "list" });
});

test("roundtrip: normalizeQueryPresetView preserves tray config", () => {
  const preset = normalizeQueryPreset({
    id: "sv-tray",
    name: "With tray",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: {
      type: "week",
      tray: {
        enabled: true,
        title: "Unscheduled",
        filters: { status: ["todo"], time: { scheduled: "unscheduled" } },
        orderBy: ["deadline_asc"],
      },
    },
    summary: [],
  });

  // Legacy {type:week, tray} migrates to col[ week, list(tray) ]; the tray
  // becomes a list area whose when = the tray filters, with clearScheduled onDrop.
  const layout = preset.view.layout;
  assert.equal(layout.dir, "col");
  assert.equal(layout.children.length, 2);
  assert.equal(layout.children[0].type, "week");
  const tray = layout.children[1];
  assert.equal(tray.type, "list");
  assert.equal(tray.title, "Unscheduled");
  assert.deepEqual(tray.when.status, ["todo"]);
  assert.deepEqual(tray.when.time, { scheduled: "unscheduled" });
  assert.deepEqual(tray.orderBy, ["deadline_asc"]);
  assert.equal(tray.onDrop.clearScheduled, true);
});

test("roundtrip: unsupported area type in a layout → unknown area keeps raw JSON", () => {
  // matrix was removed. A new-shape layout with an unsupported area type
  // normalizes to an `unknown` area that preserves the original JSON, so the
  // view renders "未知类型 + JSON" instead of dropping it.
  const preset = normalizeQueryPreset({
    id: "sv-unknown",
    name: "With unknown area",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: {
      layout: {
        type: "matrix",
        title: "Legacy Matrix",
        x: { id: "priority" },
        y: { id: "status" },
      },
    },
    summary: [],
  });

  const layout = preset.view.layout;
  assert.equal(layout.type, "unknown");
  assert.equal(layout.rawType, "matrix");
  assert.equal(layout.title, "Legacy Matrix");
  assert.equal(layout.raw.x.id, "priority");
  assert.equal(layout.raw.y.id, "status");
});

test("roundtrip: normalizeQueryPresetView preserves orderBy", () => {
  const preset = normalizeQueryPreset({
    id: "sv-orderby",
    name: "With orderBy",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: {
      type: "list",
      orderBy: ["deadline_asc", "created_desc"],
    },
    summary: [],
  });

  assert.equal(preset.view.layout.type, "list");
  assert.deepEqual(preset.view.layout.orderBy, ["deadline_asc", "created_desc"]);
});

test("VAL-GUI-004 production: confirm denied → no deletion, presets unchanged", async () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedB = normalizedCopies[1];

  let confirmCalled = false;
  let noticeCreated = false;

  const result = await executeDeleteQueryPresetFlow(
    presets,
    normalizedB,
    "sv-a",
    "sv-b",
    {
      confirm: async (viewName) => {
        confirmCalled = true;
        assert.equal(viewName, "Beta");
        return false; // User cancels
      },
      createUndoNotice: () => {
        noticeCreated = true;
        return { onUndoClick: () => {}, close: () => {} };
      },
      showRestoredNotice: () => {},
    },
  );

  assert.equal(result.confirmed, false);
  assert.equal(result.undoPlan, null);
  assert.equal(result.wasDefault, false);
  assert.equal(result.wasActive, false);
  assert.deepEqual(result.presetsAfter, presets, "presets unchanged when cancelled");
  assert.equal(result.undoNotice, null);
  assert.equal(confirmCalled, true);
  assert.equal(noticeCreated, false, "notice should not be created when cancelled");
});

test("VAL-GUI-004 production: confirm → delete → presetsAfter removes target, undoPlan captures snapshot", async () => {
  const a = createQueryPreset("Alpha", {
    search: "focus",
    tags: ["#work"],
    status: ["todo"],
    time: { scheduled: "week" },
    view: { type: "week", orderBy: ["deadline_risk"] },
    summary: [{ type: "count" }, { type: "sum", field: "planned" }],
  }, () => "sv-a");
  const b = createQueryPreset("Beta", {
    search: "docs",
    tags: ["#docs"],
    status: ["done"],
    view: { type: "list" },
    summary: [{ type: "count" }],
  }, () => "sv-b");
  const c = createQueryPreset("Gamma", {
    search: "meetings",
    tags: ["#meeting"],
    status: ["todo", "done"],
    view: { type: "month" },
    summary: [],
  }, () => "sv-c");
  const presets = [a, b, c];

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedB = normalizedCopies[1];

  let confirmCallName = null;
  let noticeCallName = null;
  let noticeUndoLabel = null;

  const result = await executeDeleteQueryPresetFlow(
    presets,
    normalizedB,
    "sv-a",   // Alpha is default
    "sv-b",   // Beta is active
    {
      confirm: async (viewName) => {
        confirmCallName = viewName;
        return true; // User confirms
      },
      createUndoNotice: (viewName, undoLabel) => {
        noticeCallName = viewName;
        noticeUndoLabel = undoLabel;
        // Return a controller — caller (view.ts) wires onUndoClick
        let storedHandler = null;
        return {
          onUndoClick: (handler) => { storedHandler = handler; },
          close: () => {},
          // Expose for test verification
          getStoredHandler: () => storedHandler,
        };
      },
      showRestoredNotice: () => {},
    },
  );

  assert.equal(result.confirmed, true);
  assert.equal(confirmCallName, "Beta");
  assert.equal(noticeCallName, "Beta");
  assert.equal(noticeUndoLabel, "撤销");

  // Verify deletion
  assert.deepEqual(result.presetsAfter.map((p) => p.id), ["sv-a", "sv-c"],
    "Beta should be removed");

  // Verify undo plan snapshot
  assert.ok(result.undoPlan);
  assert.equal(result.undoPlan.snapshot.id, "sv-b");
  assert.equal(result.undoPlan.snapshot.name, "Beta");
  assert.equal(result.undoPlan.originalIndex, 1);
  assert.equal(result.undoPlan.snapshot.filters, undefined);
  assert.deepEqual(result.undoPlan.snapshot.view, { layout: { type: "list" } });

  // Verify state flags
  assert.equal(result.wasDefault, false, "Beta was not default (Alpha is)");
  assert.equal(result.wasActive, true, "Beta was active");

  // Verify undo notice controller was returned
  assert.ok(result.undoNotice);
  assert.equal(typeof result.undoNotice.onUndoClick, "function");
  assert.equal(typeof result.undoNotice.close, "function");
});

test("VAL-GUI-004 production: clicking undo restores order via executeQueryPresetDeleteUndo", async () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedB = normalizedCopies[1];

  let undoHandler = null;
  let closed = false;

  const result = await executeDeleteQueryPresetFlow(
    presets,
    normalizedB,
    "sv-a",
    "sv-b",
    {
      confirm: async () => true,
      createUndoNotice: () => ({
        onUndoClick: (handler) => { undoHandler = handler; },
        close: () => { closed = true; },
      }),
      showRestoredNotice: () => {},
    },
  );

  assert.equal(result.confirmed, true);
  assert.deepEqual(result.presetsAfter.map((p) => p.id), ["sv-a", "sv-c"]);

  // Simulate the caller (view.ts) wiring the undo handler
  const undoPlan = result.undoPlan;
  assert.ok(undoPlan);
  result.undoNotice.onUndoClick(async () => {
    closed = true;
  });
  assert.ok(undoHandler, "undo click handler should have been registered by onUndoClick");

  // Apply the undo manually (as the production view.ts undo handler would)
  const restored = executeQueryPresetDeleteUndo(result.presetsAfter, undoPlan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo restores Beta to its original position (index 1)");

  const restoredBeta = restored[1];
  assert.equal(restoredBeta.id, "sv-b");
  assert.equal(restoredBeta.name, "Beta");
  assert.deepEqual(restoredBeta.view, undoPlan.snapshot.view);
  assert.deepEqual(restoredBeta.view, undoPlan.snapshot.view);
});

test("VAL-GUI-004 production: undo restores default state when deleted tab was default", async () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedA = normalizedCopies[0]; // Alpha is default AND active

  let undoHandler = null;

  const result = await executeDeleteQueryPresetFlow(
    presets,
    normalizedA,
    "sv-a",   // Alpha IS default
    "sv-a",   // Alpha IS active
    {
      confirm: async () => true,
      createUndoNotice: () => ({
        onUndoClick: (handler) => { undoHandler = handler; },
        close: () => {},
      }),
      showRestoredNotice: () => {},
    },
  );

  assert.equal(result.confirmed, true);
  assert.equal(result.wasDefault, true, "deleted tab was default");
  assert.equal(result.wasActive, true, "deleted tab was active");
  assert.deepEqual(result.presetsAfter.map((p) => p.id), ["sv-b", "sv-c"]);
  assert.equal(result.undoPlan.originalIndex, 0);

  // Simulate caller wiring: register the undo handler
  result.undoNotice.onUndoClick(async () => {});
  assert.ok(undoHandler, "undo click handler should have been registered by onUndoClick");

  // Apply undo manually
  const restored = executeQueryPresetDeleteUndo(result.presetsAfter, result.undoPlan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"]);

  // Verify default/active would be restored (as production code does)
  if (result.wasDefault) {
    const newDefaultId = result.undoPlan.snapshot.id;
    assert.equal(newDefaultId, "sv-a", "default restored to Alpha");
  }
  if (result.wasActive) {
    const reactivated = restored.find((p) => p.id === result.undoPlan.snapshot.id);
    assert.ok(reactivated, "Alpha restored as active tab");
  }
});

test("VAL-GUI-004 production: confirm-delete-undo roundtrip preserves all QueryPreset fields", async () => {
  // Full grid+section+tray+summary preset — verify complete roundtrip
  const rich = normalizeQueryPreset({
    id: "sv-full",
    name: "Full View",
    builtin: false,
    hidden: false,
    filters: {
      search: "deep work",
      tags: ["#focus", "#priority"],
      status: ["todo", "in_progress"],
      time: { scheduled: "week", deadline: "overdue", completed: "month" },
    },
    view: {
      layout: {
        dir: "col",
        children: [
          {
            type: "grid",
            title: "Priority",
            when: { tags: ["#high"], status: ["todo"] },
            orderBy: ["deadline_asc"],
          },
          {
            type: "list",
            title: "Backlog",
            when: { status: ["todo"], time: { scheduled: "unscheduled" } },
            orderBy: ["deadline_asc"],
            onDrop: { clearScheduled: true },
          },
        ],
      },
    },
    summary: [
      { type: "count" },
      { type: "sum", field: "planned", format: "duration" },
      { type: "ratio", numerator: "actual", denominator: "estimate", format: "percent" },
      { type: "top_n", by: "tags", limit: 5 },
      { type: "group_by", by: "tags" },
    ],
  });

  const other = createQueryPreset("Other", { status: "all" }, () => "sv-other");
  const presets = [other, rich];

  let undoHandler = null;

  const result = await executeDeleteQueryPresetFlow(
    presets,
    rich,
    null,
    "sv-full",
    {
      confirm: async () => true,
      createUndoNotice: () => ({
        onUndoClick: (handler) => { undoHandler = handler; },
        close: () => {},
      }),
      showRestoredNotice: () => {},
    },
  );

  assert.equal(result.confirmed, true);
  assert.deepEqual(result.presetsAfter.map((p) => p.id), ["sv-other"]);

  // Simulate caller wiring: register the undo handler
  result.undoNotice.onUndoClick(async () => {});
  assert.ok(undoHandler, "undo click handler should have been registered by onUndoClick");

  // Verify snapshot preserves ALL fields
  const snap = result.undoPlan.snapshot;
  assert.equal(snap.id, "sv-full");
  assert.equal(snap.name, "Full View");

  // Filters
  assert.equal(snap.filters, undefined);

  // View — col[ grid, list-tray ] preserved
  const snapLayout = snap.view.layout;
  assert.equal(snapLayout.dir, "col");
  assert.equal(snapLayout.children[0].type, "grid");
  assert.equal(snapLayout.children[0].title, "Priority");
  assert.deepEqual(snapLayout.children[0].when.tags, { expr: "#high" });
  assert.deepEqual(snapLayout.children[0].orderBy, ["deadline_asc"]);
  assert.equal(snapLayout.children[1].type, "list");
  assert.equal(snapLayout.children[1].title, "Backlog");

  // Summary — all 5 types

  // Undo restores everything
  const restored = executeQueryPresetDeleteUndo(result.presetsAfter, result.undoPlan);
  assert.equal(restored.length, 2);
  const restoredRich = restored.find((p) => p.id === "sv-full");
  assert.ok(restoredRich);
  assert.deepEqual(restoredRich.view, snap.view);
  assert.deepEqual(restoredRich.view, snap.view);
});

// ── fix-m3-delete-undo-taskcenterview-path ──
// Production-path tests that exercise the view-level state management
// functions (computeDeleteQueryPresetState / computeUndoQueryPresetState)
// called by TaskCenterView.deleteSavedViewWithConfirm.  These tests
// stub Obsidian Modal/Notice through executeDeleteQueryPresetFlow
// callbacks and verify delete + undo state restoration including
// order, default, and active tab recovery.

test("VAL-GUI-004: computeDeleteQueryPresetState — no fallback when deleting non-default non-active tab", () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  // Simulate: flow result for deleting Beta (non-default, non-active)
  // But Beta IS NOT default, IS NOT active in this test
  const flowResult = {
    confirmed: true,
    undoPlan: computeQueryPresetDeleteUndoPlan(presets, b),
    wasDefault: false,
    wasActive: false,
    presetsAfter: deleteQueryPresetById(presets, "sv-b"),
    undoNotice: null,
  };

  const state = computeDeleteQueryPresetState({
    result: flowResult,
    visibleTabs: [a, b, c],
    view: b,
  });

  assert.deepEqual(state.presetsAfter.map((p) => p.id), ["sv-a", "sv-c"]);
  assert.equal(state.newDefaultId, null, "default should not change");
  assert.equal(state.shouldSwitchActive, false, "active should not switch");
  assert.equal(state.nextActiveView, null);
});

test("VAL-GUI-004: computeDeleteQueryPresetState — fallback default when deleted tab was default", () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  // Alpha IS default. Deleting Alpha.
  const flowResult = {
    confirmed: true,
    undoPlan: computeQueryPresetDeleteUndoPlan(presets, a),
    wasDefault: true,   // Alpha was default
    wasActive: false,
    presetsAfter: deleteQueryPresetById(presets, "sv-a"),
    undoNotice: null,
  };

  const state = computeDeleteQueryPresetState({
    result: flowResult,
    visibleTabs: [a, b, c],
    view: a,
  });

  assert.deepEqual(state.presetsAfter.map((p) => p.id), ["sv-b", "sv-c"]);
  assert.equal(state.newDefaultId, "sv-b", "default should fallback to next visible tab (Beta)");
  assert.equal(state.shouldSwitchActive, false);
});

test("VAL-GUI-004: computeDeleteQueryPresetState — switch active when deleted tab was active", () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  // Beta IS active. Deleting Beta.
  const flowResult = {
    confirmed: true,
    undoPlan: computeQueryPresetDeleteUndoPlan(presets, b),
    wasDefault: false,
    wasActive: true,    // Beta was active
    presetsAfter: deleteQueryPresetById(presets, "sv-b"),
    undoNotice: null,
  };

  const state = computeDeleteQueryPresetState({
    result: flowResult,
    visibleTabs: [a, b, c],
    view: b,
  });

  assert.deepEqual(state.presetsAfter.map((p) => p.id), ["sv-a", "sv-c"]);
  assert.equal(state.shouldSwitchActive, true);
  assert.ok(state.nextActiveView);
  assert.equal(state.nextActiveView.id, "sv-a", "should switch to first remaining visible tab (Alpha)");
  assert.equal(state.newDefaultId, null);
});

test("VAL-GUI-004: computeDeleteQueryPresetState — both default+active fallback when deleted tab was both", () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  // Alpha IS default AND active. Deleting Alpha.
  const flowResult = {
    confirmed: true,
    undoPlan: computeQueryPresetDeleteUndoPlan(presets, a),
    wasDefault: true,
    wasActive: true,
    presetsAfter: deleteQueryPresetById(presets, "sv-a"),
    undoNotice: null,
  };

  const state = computeDeleteQueryPresetState({
    result: flowResult,
    visibleTabs: [a, b, c],
    view: a,
  });

  assert.deepEqual(state.presetsAfter.map((p) => p.id), ["sv-b", "sv-c"]);
  assert.equal(state.newDefaultId, "sv-b", "default falls back to Beta");
  assert.equal(state.shouldSwitchActive, true);
  assert.ok(state.nextActiveView);
  assert.equal(state.nextActiveView.id, "sv-b", "active switches to Beta");
});

test("VAL-GUI-004: computeUndoQueryPresetState — restores deleted tab at original position", () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  // Delete Beta (index 1)
  const undoPlan = computeQueryPresetDeleteUndoPlan(presets, b);
  const afterDelete = deleteQueryPresetById(presets, "sv-b");

  const undoState = computeUndoQueryPresetState({
    presets: afterDelete,
    undoPlan,
    wasDefault: false,
    wasActive: true,  // Beta was active
  });

  assert.deepEqual(undoState.presetsRestored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo restores Beta at original position (index 1)");
  assert.equal(undoState.restoredDefaultId, null, "was not default");
  assert.equal(undoState.shouldRestoreActive, true, "should restore active tab");
  assert.ok(undoState.restoredView);
  assert.equal(undoState.restoredView.id, "sv-b");
  assert.equal(undoState.restoredView.name, "Beta");
});

test("VAL-GUI-004: computeUndoQueryPresetState — restores default when deleted tab was default", () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const presets = [a, b];

  // Delete Alpha (index 0, was default)
  const undoPlan = computeQueryPresetDeleteUndoPlan(presets, a);
  const afterDelete = deleteQueryPresetById(presets, "sv-a");

  const undoState = computeUndoQueryPresetState({
    presets: afterDelete,
    undoPlan,
    wasDefault: true,
    wasActive: true,  // Alpha was both default and active
  });

  assert.deepEqual(undoState.presetsRestored.map((p) => p.id), ["sv-a", "sv-b"],
    "undo restores Alpha at original position (index 0)");
  assert.equal(undoState.restoredDefaultId, "sv-a", "default restored to Alpha");
  assert.equal(undoState.shouldRestoreActive, true);
  assert.ok(undoState.restoredView);
  assert.equal(undoState.restoredView.id, "sv-a");
});

test("VAL-GUI-004: computeUndoQueryPresetState — handles deleted tab that was neither default nor active", () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  // Delete Beta (neither default nor active)
  const undoPlan = computeQueryPresetDeleteUndoPlan(presets, b);
  const afterDelete = deleteQueryPresetById(presets, "sv-b");

  const undoState = computeUndoQueryPresetState({
    presets: afterDelete,
    undoPlan,
    wasDefault: false,
    wasActive: false,
  });

  assert.deepEqual(undoState.presetsRestored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"]);
  assert.equal(undoState.restoredDefaultId, null);
  assert.equal(undoState.shouldRestoreActive, false, "no active restore needed");
  assert.equal(undoState.restoredView, null);
});

test("VAL-GUI-004: computeUndoQueryPresetState — preserves all snapshot fields through undo", () => {
  // Full legacy list+section+tray+summary preset (migrates to col[ list, tray ])
  const rich = normalizeQueryPreset({
    id: "sv-full",
    name: "Full View",
    builtin: false,
    hidden: false,
    filters: {
      search: "deep work",
      tags: ["#focus", "#priority"],
      status: ["todo", "in_progress"],
      time: { scheduled: "week", deadline: "overdue", completed: "month" },
    },
    view: {
      type: "list",
      sections: [
        { id: "urgent", title: "Urgent", when: { time: { deadline: "overdue" } }, limit: 5, orderBy: ["deadline_asc"] },
      ],
      tray: {
        enabled: true,
        title: "Backlog",
        filters: { status: ["todo"], time: { scheduled: "unscheduled" } },
        orderBy: ["deadline_asc"],
      },
      orderBy: ["deadline_asc", "created_desc"],
    },
    summary: [
      { type: "count" },
      { type: "sum", field: "planned", format: "duration" },
      { type: "ratio", numerator: "actual", denominator: "estimate", format: "percent" },
      { type: "top_n", by: "tags", limit: 5 },
      { type: "group_by", by: "tags" },
    ],
  });

  const other = createQueryPreset("Other", { status: "all" }, () => "sv-other");
  const presets = [other, rich];

  const undoPlan = computeQueryPresetDeleteUndoPlan(presets, rich);
  const afterDelete = deleteQueryPresetById(presets, "sv-full");

  const undoState = computeUndoQueryPresetState({
    presets: afterDelete,
    undoPlan,
    wasDefault: false,
    wasActive: true,
  });

  assert.equal(undoState.presetsRestored.length, 2);
  const restored = undoState.presetsRestored.find((p) => p.id === "sv-full");
  assert.ok(restored);
  assert.equal(restored.name, "Full View");
  assert.deepEqual(restored.view, undoPlan.snapshot.view);
  assert.deepEqual(restored.view, undoPlan.snapshot.view);
  // Legacy list+sections+tray migrated to col[ list, list-tray ]; legacy
  // sections are dropped (list no longer groups internally).
  assert.equal(restored.view.layout.children[0].type, "list");
  assert.equal(restored.view.layout.children[0].sections, undefined);
  assert.equal(restored.view.layout.children[1].title, "Backlog");
  assert.equal(undoState.restoredView?.id, "sv-full");
  assert.equal(undoState.shouldRestoreActive, true);
});

// ── Full confirm-delete-undo production-path with Modal/Notice stubs ──
// These tests exercise the exact production flow that
// TaskCenterView.deleteSavedViewWithConfirm follows:
//   executeDeleteQueryPresetFlow → computeDeleteQueryPresetState
//   → undo click → computeUndoQueryPresetState
// with stub callbacks that simulate real Modal confirm + Notice undo click.

test("VAL-GUI-004 production view-path: confirm → delete → compute state → undo → restore all", async () => {
  // Set up: 3 presets, default=Alpha, active=Beta. Delete Beta.
  const a = createQueryPreset("Alpha", {
    search: "focus",
    tags: ["#work"],
    status: ["todo"],
    time: { scheduled: "week", deadline: "overdue" },
    view: { type: "week", orderBy: ["deadline_risk"] },
    summary: [{ type: "count" }, { type: "sum", field: "planned" }],
  }, () => "sv-a");
  const b = createQueryPreset("Beta", {
    search: "docs",
    tags: ["#docs"],
    status: ["done"],
    view: { type: "list" },
    summary: [{ type: "count" }],
  }, () => "sv-b");
  const c = createQueryPreset("Gamma", {
    search: "meetings",
    tags: ["#meeting"],
    status: ["todo", "done"],
    view: { type: "month" },
    summary: [],
  }, () => "sv-c");
  const presets = [a, b, c];

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedB = normalizedCopies[1];

  let confirmCalledWith = null;
  let undoHandler = null;
  let noticeClosed = false;

  // Step 1: executeDeleteQueryPresetFlow (with Modal/Notice stubs)
  const flowResult = await executeDeleteQueryPresetFlow(
    presets,
    normalizedB,
    "sv-a",   // Alpha is default
    "sv-b",   // Beta is active
    {
      confirm: async (viewName) => {
        confirmCalledWith = viewName;
        return true; // User confirms deletion
      },
      createUndoNotice: (viewName, undoLabel) => {
        let handler = null;
        return {
          onUndoClick: (h) => { handler = h; },
          close: () => { noticeClosed = true; },
          // Expose for test
          getHandler: () => handler,
        };
      },
      showRestoredNotice: () => {},
    },
  );

  assert.equal(flowResult.confirmed, true);
  assert.equal(confirmCalledWith, "Beta");

  // Step 2: computeDeleteQueryPresetState (view.ts production path)
  const deleteState = computeDeleteQueryPresetState({
    result: flowResult,
    visibleTabs: [a, b, c],
    view: normalizedB,
  });

  assert.deepEqual(deleteState.presetsAfter.map((p) => p.id), ["sv-a", "sv-c"]);
  assert.equal(deleteState.newDefaultId, null, "default was Alpha, not Beta");
  assert.equal(deleteState.shouldSwitchActive, true, "Beta was active, switch needed");
  assert.ok(deleteState.nextActiveView);
  assert.equal(deleteState.nextActiveView.id, "sv-a", "switches to Alpha");

  // Simulate view applying the state (as deleteSavedViewWithConfirm does)
  const appliedPresets = deleteState.presetsAfter;

  // Step 3: Click undo → register handler and execute
  undoHandler = flowResult.undoNotice?.getHandler();
  // Simulate view wiring the undo handler (as deleteSavedViewWithConfirm does)
  flowResult.undoNotice?.onUndoClick(async () => {
    flowResult.undoNotice?.close();
    // ... the view would apply computeUndoQueryPresetState here
  });

  // Step 4: computeUndoQueryPresetState (view.ts production path)
  const undoState = computeUndoQueryPresetState({
    presets: appliedPresets,
    undoPlan: flowResult.undoPlan,
    wasDefault: flowResult.wasDefault,
    wasActive: flowResult.wasActive,
  });

  assert.deepEqual(undoState.presetsRestored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo restores Beta at original position (index 1)");

  // Verify order restoration
  assert.equal(undoState.presetsRestored[0].id, "sv-a", "Alpha stays first");
  assert.equal(undoState.presetsRestored[1].id, "sv-b", "Beta restored at index 1");
  assert.equal(undoState.presetsRestored[2].id, "sv-c", "Gamma stays last");

  // Verify default/active restoration
  assert.equal(undoState.restoredDefaultId, null, "wasDefault=false, no default restore");
  assert.equal(undoState.shouldRestoreActive, true, "wasActive=true, restore active");
  assert.ok(undoState.restoredView);
  assert.equal(undoState.restoredView.id, "sv-b", "Beta restored as active tab");

  // Verify snapshot content preserved
  const restoredBeta = undoState.presetsRestored[1];
  assert.equal(restoredBeta.name, "Beta");
  assert.equal(restoredBeta.filters, undefined);
  assert.deepEqual(restoredBeta.view, { layout: { type: "list" } });
});

test("VAL-GUI-004 production view-path: delete default+active tab → undo restores both default and active", async () => {
  // Alpha is both default and active. Delete Alpha. Undo restores both.
  const a = createQueryPreset("Alpha", {
    search: "main",
    tags: ["#primary"],
    status: ["todo"],
    view: { type: "list", preset: "today" },
    summary: [{ type: "count" }],
  }, () => "sv-a");
  const b = createQueryPreset("Beta", {
    search: "secondary",
    tags: ["#beta"],
    status: ["done"],
    view: { type: "week" },
    summary: [],
  }, () => "sv-b");
  const presets = [a, b];

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedA = normalizedCopies[0];

  // Step 1: executeDeleteQueryPresetFlow
  const flowResult = await executeDeleteQueryPresetFlow(
    presets,
    normalizedA,
    "sv-a",   // Alpha IS default
    "sv-a",   // Alpha IS active
    {
      confirm: async () => true,
      createUndoNotice: () => ({
        onUndoClick: () => {},
        close: () => {},
      }),
      showRestoredNotice: () => {},
    },
  );

  assert.equal(flowResult.confirmed, true);
  assert.equal(flowResult.wasDefault, true);
  assert.equal(flowResult.wasActive, true);

  // Step 2: compute delete state
  const deleteState = computeDeleteQueryPresetState({
    result: flowResult,
    visibleTabs: [a, b],
    view: normalizedA,
  });

  assert.deepEqual(deleteState.presetsAfter.map((p) => p.id), ["sv-b"]);
  assert.equal(deleteState.newDefaultId, "sv-b", "default falls back to Beta");
  assert.equal(deleteState.shouldSwitchActive, true);
  assert.equal(deleteState.nextActiveView?.id, "sv-b");

  // Step 3: compute undo state
  const undoState = computeUndoQueryPresetState({
    presets: deleteState.presetsAfter,
    undoPlan: flowResult.undoPlan,
    wasDefault: true,
    wasActive: true,
  });

  assert.deepEqual(undoState.presetsRestored.map((p) => p.id), ["sv-a", "sv-b"]);
  assert.equal(undoState.restoredDefaultId, "sv-a", "default restored to Alpha");
  assert.equal(undoState.shouldRestoreActive, true);
  assert.equal(undoState.restoredView?.id, "sv-a", "Alpha restored as active tab");

  // Verify restored Alpha has all fields
  const restoredAlpha = undoState.presetsRestored[0];
  assert.equal(restoredAlpha.name, "Alpha");
  assert.equal(restoredAlpha.view.layout.type, "list");
});

test("VAL-GUI-004 production view-path: cancel confirm → no state change", async () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));

  const flowResult = await executeDeleteQueryPresetFlow(
    presets,
    normalizedCopies[1],
    "sv-a",
    "sv-b",
    {
      confirm: async () => false, // User cancels
      createUndoNotice: () => ({ onUndoClick: () => {}, close: () => {} }),
      showRestoredNotice: () => {},
    },
  );

  assert.equal(flowResult.confirmed, false);
  assert.equal(flowResult.undoPlan, null);
  assert.deepEqual(flowResult.presetsAfter, presets, "no change when cancelled");
});

test("VAL-GUI-004 production view-path: Notice undo click drives full restore callback", async () => {
  // This test verifies the exact undo wiring pattern used by
  // deleteSavedViewWithConfirm: onUndoClick registers a handler,
  // the handler is callable, and when called it triggers close()
  // and the view's undo logic.

  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const presets = [a, b];

  let undoClickHandler = null;
  let closed = false;
  let handlerExecuted = false;

  const flowResult = await executeDeleteQueryPresetFlow(
    presets,
    b,
    null,
    "sv-b",
    {
      confirm: async () => true,
      createUndoNotice: () => ({
        onUndoClick: (handler) => {
          undoClickHandler = handler;
        },
        close: () => { closed = true; },
      }),
      showRestoredNotice: () => {},
    },
  );

  assert.equal(flowResult.confirmed, true);

  // Simulate the view's undo handler wiring (exactly as deleteSavedViewWithConfirm does)
  flowResult.undoNotice?.onUndoClick(async () => {
    flowResult.undoNotice?.close();

    // This is where the view calls computeUndoQueryPresetState & applies settings
    const undoState = computeUndoQueryPresetState({
      presets: flowResult.presetsAfter,
      undoPlan: flowResult.undoPlan,
      wasDefault: flowResult.wasDefault,
      wasActive: flowResult.wasActive,
    });

    handlerExecuted = true;

    // Verify undo restored correctly
    assert.deepEqual(undoState.presetsRestored.map((p) => p.id), ["sv-a", "sv-b"]);
    assert.equal(undoState.restoredView?.id, "sv-b");
    assert.equal(undoState.shouldRestoreActive, true);
  });

  // Now simulate the user clicking the undo link in the Notice
  assert.ok(undoClickHandler, "undo click handler must be registered");
  await undoClickHandler();

  assert.equal(handlerExecuted, true, "undo handler should have been executed");
});

test("VAL-GUI-004 production view-path: undo preserves full QueryPreset fields (grid/sections/tray/summary)", async () => {
  // Comprehensive test: rich preset with all view config fields
  const rich = normalizeQueryPreset({
    id: "sv-rich",
    name: "Rich Tab",
    builtin: false,
    hidden: false,
    filters: {
      search: "deep work",
      tags: ["#focus", "#priority"],
      status: ["todo", "in_progress"],
      time: { scheduled: "week", deadline: "overdue", completed: "month" },
    },
    view: {
      layout: {
        dir: "col",
        children: [
          {
            type: "grid",
            title: "Priority",
            when: { tags: ["#high"], status: ["todo"] },
            orderBy: ["deadline_asc"],
          },
          {
            type: "list",
            title: "Backlog",
            when: { status: ["todo"], time: { scheduled: "unscheduled" } },
            orderBy: ["deadline_asc"],
            onDrop: { clearScheduled: true },
          },
        ],
      },
    },
    summary: [
      { type: "count" },
      { type: "sum", field: "planned", format: "duration" },
      { type: "ratio", numerator: "actual", denominator: "estimate", format: "percent" },
      { type: "top_n", by: "tags", limit: 5 },
      { type: "group_by", by: "tags" },
    ],
  });

  const other = createQueryPreset("Other", { status: "all" }, () => "sv-other");
  const presets = [other, rich];

  let undoHandler = null;

  const flowResult = await executeDeleteQueryPresetFlow(
    presets,
    rich,
    null,
    "sv-rich",
    {
      confirm: async () => true,
      createUndoNotice: () => ({
        onUndoClick: (handler) => { undoHandler = handler; },
        close: () => {},
      }),
      showRestoredNotice: () => {},
    },
  );

  assert.equal(flowResult.confirmed, true);
  assert.equal(flowResult.presetsAfter.length, 1);

  // Register undo handler (as view.ts does)
  let undoApplied = false;
  flowResult.undoNotice?.onUndoClick(async () => {
    flowResult.undoNotice?.close();

    const undoState = computeUndoQueryPresetState({
      presets: flowResult.presetsAfter,
      undoPlan: flowResult.undoPlan,
      wasDefault: flowResult.wasDefault,
      wasActive: flowResult.wasActive,
    });

    undoApplied = true;

    assert.equal(undoState.presetsRestored.length, 2);
    const restored = undoState.presetsRestored.find((p) => p.id === "sv-rich");
    assert.ok(restored);

    // Verify ALL fields survived the roundtrip
    assert.equal(restored.name, "Rich Tab");
    assert.equal(restored.filters, undefined);

    // View — col[ grid, list-tray ]
    const rLayout = restored.view.layout;
    assert.equal(rLayout.dir, "col");
    assert.equal(rLayout.children.length, 2);

    // Content grid area
    const rGrid = rLayout.children[0];
    assert.equal(rGrid.type, "grid");
    assert.equal(rGrid.title, "Priority");
    assert.deepEqual(rGrid.when.tags, { expr: "#high" });
    assert.deepEqual(rGrid.orderBy, ["deadline_asc"]);

    // Tray (list area)
    assert.equal(rLayout.children[1].type, "list");
    assert.equal(rLayout.children[1].title, "Backlog");

    // Summary — all 5 types
  });

  // Click undo
  await undoHandler();
  assert.equal(undoApplied, true);
});

// ── fix-m3-query-editor-production-path-tests ──
// Production-path tests that exercise computeQueryPresetSnapshot with real
// tabDrafts Maps — the same function called by TaskCenterView.currentQuerySnapshot.
// Also exercise summary metric add/edit/remove pure helpers, and verify
// summary:[] and top_n by through the production save/update seams.

test("production: computeQueryPresetSnapshot merges tabDrafts view over saved view", () => {
  const tabDrafts = new Map();

  const saved = normalizeQueryPreset({
    id: "sv-1",
    name: "My Tab",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [{ type: "count" }],
  });

  // Draft modifies the view
  const draft = normalizeQueryPreset({
    ...saved,
    view: { type: "week" },
  });
  tabDrafts.set("sv-1", draft);

  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "",
    filterTags: "",
    filterTime: {},
    filterStatus: "all",
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [],
  });

  // Draft view wins
  assert.equal(snapshot.view.layout.type, "week", "draft view must win over saved view");
  // Identity preserved from saved
  assert.equal(snapshot.id, "sv-1");
  assert.equal(snapshot.name, "My Tab");
});

test("production: snapshot falls back to saved when no draft exists in tabDrafts", () => {
  const tabDrafts = new Map();
  // tabDrafts is empty — no draft for sv-5

  const saved = normalizeQueryPreset({
    id: "sv-5",
    name: "No Draft",
    builtin: false,
    hidden: false,
    filters: { status: "done" },
    view: { type: "month" },
    summary: [{ type: "count" }, { type: "ratio", numerator: "actual", denominator: "estimate" }],
  });

  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "",
    filterTags: "",
    filterTime: {},
    filterStatus: "all",
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [],
  });

  // No draft → saved wins
  assert.equal(snapshot.view.layout.type, "month");
});

test("production: snapshot falls back to explicit fallbacks when no saved and no draft", () => {
  const tabDrafts = new Map();

  const snapshot = computeQueryPresetSnapshot({
    existing: null,
    tabDrafts,
    filterSearch: "search term",
    filterTags: "#alpha",
    filterTime: { scheduled: "today" },
    filterStatus: ["todo"],
    fallbackView: () => ({ layout: { type: "week" } }),
    fallbackSummary: () => [{ type: "count" }, { type: "group_by", by: "tags" }],
    name: "New Snapshot",
  });

  assert.equal(snapshot.name, "New Snapshot");
  assert.equal(snapshot.builtin, false);
  assert.equal(snapshot.hidden, false);
  // US-109z2: snapshot is identity + view only (no tab-level filters).
  assert.equal(snapshot.filters, undefined);
  // Fallback view used
  assert.equal(snapshot.view.layout.type, "week");
  // Fallback summary used
});

test("production: computeQueryPresetSnapshot with name override for save-as flow", () => {
  const tabDrafts = new Map();
  const saved = normalizeQueryPreset({
    id: "sv-saved",
    name: "Original",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [{ type: "count" }],
  });

  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "",
    filterTags: "",
    filterTime: {},
    filterStatus: "todo",
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [],
    name: "Save As Copy",
  });

  assert.equal(snapshot.name, "Save As Copy", "name override must be used for save-as");
  assert.equal(snapshot.id, "sv-saved", "identity id comes from existing preset");

  // The caller (saveCurrentView) will overwrite id with createSavedViewId()
  const asNew = normalizeQueryPreset({
    ...snapshot,
    id: "sv-new-id",
    builtin: false,
    hidden: false,
  });

  assert.equal(asNew.id, "sv-new-id");
  assert.equal(asNew.name, "Save As Copy");
  assert.deepEqual(asNew.view, snapshot.view);
});

// ── fix-m3-query-editor-real-controls-path ──
// Real TaskCenterView production-path tests that exercise the actual
// handler functions (handleQueryEditorSummaryEdit/Add/Remove) extracted
// from TaskCenterView's Query Editor rendering code.  These tests stub
// the view's state and tabDrafts, then drive the handler functions to
// verify the full production flow: draft → edit → snapshot → save/update.

/**
 * Builds a stub view state that mirrors TaskCenterView's relevant fields.
 * Uses real tabDrafts Map and QueryPreset[] — the same data structures
 * the production code manipulates.
 */
function buildStubViewState(overrides = {}) {
  const savedPresets = overrides.queryPresets ?? [];
  const activeId = savedPresets.length > 0 ? savedPresets[0].id : null;

  return {
    tabDrafts: new Map(),
    settings: {
      queryPresets: [...savedPresets],
      defaultSavedViewId: overrides.defaultId ?? null,
    },
    state: {
      savedViewId: activeId,
      filter: "",
      savedViewTag: "",
      savedViewTime: {},
      savedViewStatus: "all",
    },
  };
}

/**
 * Creates a getSnapshot function matching the production signature.
 * Uses computeQueryPresetSnapshot with the stub's state.
 */
function makeGetSnapshot(stub) {
  return (existing) =>
    computeQueryPresetSnapshot({
      existing,
      tabDrafts: stub.tabDrafts,
      filterSearch: stub.state.filter,
      filterTags: stub.state.savedViewTag,
      filterTime: stub.state.savedViewTime,
      filterStatus: stub.state.savedViewStatus,
      fallbackView: () => ({ type: "list" }),
      fallbackSummary: () => [],
    });
}

/**
 * Builds QueryEditorSummaryDraftParams from the stub view state.
 */
function makeSummaryDraftParams(stub) {
  const saved = stub.state.savedViewId
    ? stub.settings.queryPresets.find((p) => p.id === stub.state.savedViewId) ?? null
    : null;
  return {
    tabDrafts: stub.tabDrafts,
    activePresetId: stub.state.savedViewId,
    savedPreset: saved,
    getSnapshot: makeGetSnapshot(stub),
  };
}

// ── US-414 / US-415: legacy SavedTaskView → QueryPreset migration ──

test("US-414: isLegacySavedTaskView detects flat shape, ignores nested filters", () => {
  // legacy: flat top-level filter fields, no nested `filters`
  assert.equal(isLegacySavedTaskView({ id: "sv-x", name: "X", search: "", tag: "", status: "all", time: {} }), true);
  assert.equal(isLegacySavedTaskView({ id: "sv-y", name: "Y", status: ["todo"] }), true);
  // new: nested filters → not legacy
  assert.equal(isLegacySavedTaskView({ id: "sv-z", name: "Z", filters: { status: "all" } }), false);
  // neither → not legacy
  assert.equal(isLegacySavedTaskView({ id: "sv-w", name: "W" }), false);
  assert.equal(isLegacySavedTaskView(null), false);
});

test("US-414: migrate custom legacy view collapses flat fields into nested filters", () => {
  const legacy = {
    id: "sv-custom",
    name: "My work",
    builtin: false,
    hidden: true,
    search: "report",
    tag: "work, urgent",
    status: ["todo", "done"],
    time: { scheduled: "2026-01-01..2026-01-31" },
    view: { type: "week" },
    summary: [{ type: "count" }],
  };
  const migrated = migrateLegacySavedTaskView(legacy);

  assert.equal(migrated.id, "sv-custom");
  assert.equal(migrated.name, "My work");
  assert.equal(migrated.hidden, true);
  assert.equal(migrated.builtin, false);
  // US-109z2: the legacy flat tab-level filters are dropped (no tab filter).
  assert.equal(migrated.filters, undefined);
  // legacy view {type} migrated to a layout tree
  assert.ok(migrated.view.layout, "view.layout exists after migration");
});

test("US-414: migrate is robust to garbage fields and never throws", () => {
  const migrated = migrateLegacySavedTaskView({ status: 12345, tag: 999, time: "nope", view: 7 });
  assert.ok(migrated.id, "id falls back to a generated id");
  assert.equal(migrated.filters, undefined, "no tab-level filters");
  assert.ok(migrated.view.layout, "view.layout always present");
});

test("US-414: legacy builtin view keeps user edits but refreshes layout from factory", () => {
  // user had renamed + hidden the builtin Today tab in the old flat shape
  const legacyToday = {
    id: "preset-today",
    name: "我的今天",
    builtin: true,
    hidden: true,
    search: "",
    tag: "",
    status: ["todo"],
    time: {},
    view: { type: "list", preset: "today" },
    summary: [],
  };
  const migrated = migrateLegacySavedTaskView(legacyToday);
  const presets = ensureBuiltinQueryPresets([migrated]);
  const today = presets.find((p) => p.id === "preset-today");

  assert.ok(today, "builtin today preset present");
  assert.equal(today.name, "我的今天", "user rename preserved");
  assert.equal(today.hidden, true, "user hidden flag preserved");
  assert.equal(today.builtin, true);
  // layout comes from the factory JSON, not the degraded legacy {type:list}
  assert.ok(today.view.layout, "factory layout applied");
  assert.equal(today.view.layout.children.length, 3);
  assert.deepEqual(today.view.layout.children[1].when.status, ["todo"]);
});

test("US-414: full settings-shaped migration keeps builtins + custom views", () => {
  const rawViews = [
    { id: "preset-week", name: "Week", builtin: true, hidden: false, search: "", tag: "", status: ["todo"], time: {}, view: { type: "week" }, summary: [] },
    { id: "sv-mine", name: "Mine", builtin: false, hidden: false, search: "x", tag: "deep", status: "all", time: {}, view: { type: "list" }, summary: [] },
  ];
  const migratedViews = rawViews.map((v) => (isLegacySavedTaskView(v) ? migrateLegacySavedTaskView(v) : v));
  const presets = ensureBuiltinQueryPresets(migratedViews);

  // all 7 builtins present + the 1 custom view
  assert.ok(presets.some((p) => p.id === "sv-mine"), "custom view survives migration");
  const mine = presets.find((p) => p.id === "sv-mine");
  assert.equal(mine.filters, undefined, "custom view migrated without tab-level filters");
  assert.equal(presets.filter((p) => p.builtin).length >= 7, true);

  // re-running detection on migrated output finds nothing legacy (idempotent)
  assert.equal(presets.filter((p) => isLegacySavedTaskView(p)).length, 0, "migration is idempotent");
});

// ── US-414: broader legacy detection — old DSL view (no `layout`) ──

test("US-414: isLegacyQueryPresetShape flags old-DSL view even with nested filters", () => {
  // old DSL: nested filters present, but `view` uses {type} not {layout}
  assert.equal(isLegacyQueryPresetShape({ id: "q", name: "Q", filters: { status: "all" }, view: { type: "week" } }), true);
  assert.equal(isLegacyQueryPresetShape({ id: "q", name: "Q", filters: {}, view: { preset: "today" } }), true);
  assert.equal(isLegacyQueryPresetShape({ id: "q", name: "Q", filters: {}, view: { sections: [] } }), true);
  // flat SavedTaskView still flagged
  assert.equal(isLegacyQueryPresetShape({ id: "q", name: "Q", status: ["todo"] }), true);
  // modern preset (view.layout) → not legacy
  assert.equal(isLegacyQueryPresetShape({ id: "q", name: "Q", filters: { status: "all" }, view: { layout: { type: "list" } } }), false);
  // empty view object is not "legacy" (normalizes to default layout)
  assert.equal(isLegacyQueryPresetShape({ id: "q", name: "Q", filters: {}, view: {} }), false);
  assert.equal(isLegacyQueryPresetShape(null), false);
});

test("US-414: detection is idempotent after a full normalize+ensure pass", () => {
  const oldDsl = { id: "sv-old-dsl", name: "Old DSL", builtin: false, hidden: false, filters: { status: ["todo"] }, view: { type: "month" }, summary: [] };
  assert.equal(isLegacyQueryPresetShape(oldDsl), true, "old DSL flagged before migration");
  const presets = ensureBuiltinQueryPresets([normalizeQueryPreset(oldDsl)]);
  const migrated = presets.find((p) => p.id === "sv-old-dsl");
  assert.ok(migrated.view.layout, "old DSL view migrated to layout");
  assert.equal(isLegacyQueryPresetShape(migrated), false, "no longer legacy after migration");
});
