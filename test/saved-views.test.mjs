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
const {
  applySavedViewFilters,
  clearSavedViewFilters,
  createSavedView,
  hasSavedViewFilters,
  suggestSavedViewName,
  updateSavedViewById,
  upsertSavedView,
} = await import("../test/.compiled/saved-views.js");

test("US-109c: createSavedView persists the current filter conditions, not a task snapshot", () => {
  const view = createSavedView(
    " Alpha Focus ",
    {
      search: "  report  ",
      tag: " #alpha,#beta ",
      time: { scheduled: " week ", deadline: " overdue ", completed: "" },
      status: "todo",
    },
    () => "sv-fixed",
  );

  assert.deepEqual(view, {
    id: "sv-fixed",
    name: "Alpha Focus",
    search: "report",
    tag: "#alpha,#beta",
    time: { scheduled: "week", deadline: "overdue" },
    status: "todo",
  });
});

test("US-109c: upsertSavedView replaces an existing view with the same name", () => {
  const oldView = createSavedView("Alpha", { search: "old", tag: "#old", time: { scheduled: "today" }, status: "todo" }, () => "sv-old");
  const otherView = createSavedView("Gamma", { search: "", tag: "#gamma", time: {}, status: "all" }, () => "sv-gamma");
  const newView = createSavedView("Alpha", { search: "new", tag: "#alpha", time: { completed: "week" }, status: "done" }, () => "sv-new");

  const views = upsertSavedView([oldView, otherView], newView);

  assert.deepEqual(views.map((view) => view.name), ["Gamma", "Alpha"]);
  assert.equal(views[1].id, "sv-new");
  assert.equal(views[1].search, "new");
  assert.equal(views[1].tag, "#alpha");
  assert.deepEqual(views[1].time, { completed: "week" });
  assert.equal(views[1].status, "done");
});

test("US-109c: updateSavedViewById preserves the selected saved-view identity", () => {
  const alpha = createSavedView("Alpha", { search: "old", tag: "#old", time: { scheduled: "today" }, status: "todo" }, () => "sv-alpha");
  const gamma = createSavedView("Gamma", { search: "", tag: "#gamma", time: {}, status: "all" }, () => "sv-gamma");
  const updated = createSavedView("Alpha", { search: "new", tag: "#alpha", time: { deadline: "overdue" }, status: "done" }, () => "sv-alpha");

  const views = updateSavedViewById([alpha, gamma], updated);

  assert.deepEqual(views.map((view) => view.id), ["sv-alpha", "sv-gamma"]);
  assert.deepEqual(views.map((view) => view.name), ["Alpha", "Gamma"]);
  assert.equal(views[0].search, "new");
  assert.equal(views[0].tag, "#alpha");
  assert.deepEqual(views[0].time, { deadline: "overdue" });
  assert.equal(views[0].status, "done");
});

test("US-109g: applySavedViewFilters restores saved filters", () => {
  const filters = applySavedViewFilters({
    id: "sv-q1",
    name: "Q1",
    search: "brief",
    tag: "#alpha,#beta",
    time: {
      scheduled: "2026-04-01..2026-04-30",
      deadline: "overdue",
    },
    status: "todo",
  });

  assert.deepEqual(filters, {
    savedViewId: "sv-q1",
    search: "brief",
    tag: "#alpha,#beta",
    time: {
      scheduled: "2026-04-01..2026-04-30",
      deadline: "overdue",
    },
    status: "todo",
  });
});

test("US-109g: clearSavedViewFilters returns the current-view empty filter state", () => {
  assert.deepEqual(clearSavedViewFilters(), {
    savedViewId: null,
    search: "",
    tag: "",
    time: {},
    status: "all",
  });
});

test("US-109c: suggestSavedViewName prefers tag, then status, then fallback", () => {
  assert.equal(suggestSavedViewName({ tag: " #alpha,#beta ", status: "all" }, "Saved view"), "alpha,#beta");
  assert.equal(suggestSavedViewName({ tag: "", status: "done" }, "Saved view"), "done");
  assert.equal(suggestSavedViewName({ tag: "", status: "all" }, "Saved view"), "Saved view");
});

test("US-109c: empty filters are not a saveable filter view", () => {
  assert.equal(hasSavedViewFilters({ search: "", tag: "", time: {}, status: "all" }), false);
  assert.equal(hasSavedViewFilters({ search: "alpha", tag: "", time: {}, status: "all" }), true);
  assert.equal(hasSavedViewFilters({ search: "", tag: "#alpha", time: {}, status: "all" }), true);
  assert.equal(hasSavedViewFilters({ search: "", tag: "", time: { scheduled: "week" }, status: "all" }), true);
  assert.equal(hasSavedViewFilters({ search: "", tag: "", time: {}, status: "done" }), true);
});
