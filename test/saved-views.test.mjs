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
  suggestSavedViewName,
  upsertSavedView,
} = await import("../test/.compiled/saved-views.js");

test("US-109c: createSavedView persists the current filter conditions, not a task snapshot", () => {
  const view = createSavedView(
    " Alpha Focus ",
    {
      search: "  report  ",
      tag: " #alpha,#beta ",
      date: " week ",
      status: "todo",
    },
    () => "sv-fixed",
  );

  assert.deepEqual(view, {
    id: "sv-fixed",
    name: "Alpha Focus",
    search: "report",
    tag: "#alpha,#beta",
    date: "week",
    status: "todo",
    grouping: "",
  });
});

test("US-109c: upsertSavedView replaces an existing view with the same name", () => {
  const oldView = createSavedView("Alpha", { search: "old", tag: "#old", date: "today", status: "todo" }, () => "sv-old");
  const otherView = createSavedView("Gamma", { search: "", tag: "#gamma", date: "", status: "all" }, () => "sv-gamma");
  const newView = createSavedView("Alpha", { search: "new", tag: "#alpha", date: "week", status: "done" }, () => "sv-new");

  const views = upsertSavedView([oldView, otherView], newView);

  assert.deepEqual(views.map((view) => view.name), ["Gamma", "Alpha"]);
  assert.equal(views[1].id, "sv-new");
  assert.equal(views[1].search, "new");
  assert.equal(views[1].tag, "#alpha");
  assert.equal(views[1].date, "week");
  assert.equal(views[1].status, "done");
});

test("US-109g: applySavedViewFilters restores saved filters and clears legacy grouping state", () => {
  const filters = applySavedViewFilters({
    id: "sv-q1",
    name: "Q1",
    search: "brief",
    tag: "#alpha,#beta",
    date: "2026-04-01..2026-04-30",
    status: "todo",
    grouping: "",
  });

  assert.deepEqual(filters, {
    savedViewId: "sv-q1",
    search: "brief",
    tag: "#alpha,#beta",
    date: "2026-04-01..2026-04-30",
    status: "todo",
    grouping: "",
  });
});

test("US-109f: applySavedViewFilters treats legacy grouping as an extra tag filter", () => {
  assert.deepEqual(
    applySavedViewFilters({
      id: "sv-legacy",
      name: "Legacy",
      search: "",
      tag: "#alpha",
      date: "",
      status: "all",
      grouping: "#1象限",
    }),
    {
      savedViewId: "sv-legacy",
      search: "",
      tag: "#alpha,#1象限",
      date: "",
      status: "all",
      grouping: "",
    },
  );

  assert.equal(
    applySavedViewFilters({
      id: "sv-legacy-only",
      name: "Legacy only",
      search: "",
      tag: "",
      date: "",
      status: "all",
      grouping: "#安全",
    }).tag,
    "#安全",
  );
});

test("US-109g: clearSavedViewFilters returns the current-view empty filter state", () => {
  assert.deepEqual(clearSavedViewFilters(), {
    savedViewId: null,
    search: "",
    tag: "",
    date: "",
    status: "all",
    grouping: "",
  });
});

test("US-109c: suggestSavedViewName prefers tag, then status, then fallback", () => {
  assert.equal(suggestSavedViewName({ tag: " #alpha,#beta ", status: "all" }, "Saved view"), "alpha,#beta");
  assert.equal(suggestSavedViewName({ tag: "", status: "done" }, "Saved view"), "done");
  assert.equal(suggestSavedViewName({ tag: "", status: "all" }, "Saved view"), "Saved view");
});
