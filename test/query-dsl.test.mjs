// Unit tests for VAL-CORE-005, VAL-CORE-006, VAL-CROSS-002:
// QueryPreset DSL schema, normalize, validate, section errors,
// legacy SavedTaskView rejection, and 7 builtin presets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/saved-views.ts",
      "--alias:obsidian=./test/obsidian-stub.mjs",
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

globalThis.window = { localStorage: { getItem: () => "zh" } };
compilePure();
const {
  normalizeQueryPreset,
  validateQueryPreset,
  isLegacySavedTaskView,
  parseQueryDsl,
  stringifyQueryPreset,
  createBuiltinQueryPresets,
} = await import("../test/.compiled/saved-views.js");

// ── tag match mode (AND default / OR object) ──

test("US-109d4: every tag-filter shape migrates to a single { expr } form", () => {
  const dsl = JSON.stringify({
    name: "T",
    view: { layout: { dir: "col", children: [
      { type: "list", when: { tags: { values: ["#a", "#b"], mode: "or" } } },
      { type: "list", when: { tags: { values: ["#a", "#b"], mode: "and" } } },
      { type: "list", when: { tags: ["#c"] } },
    ] } },
  });
  const preset = parseQueryDsl(dsl);
  const areas = preset.view.layout.children;
  assert.deepEqual(areas[0].when.tags, { expr: "#a or #b" }, "OR → expression");
  assert.deepEqual(areas[1].when.tags, { expr: "#a and #b" }, "AND → expression");
  assert.deepEqual(areas[2].when.tags, { expr: "#c" }, "bare array → expression");
});

// ── VAL-CORE-005: normalizeQueryPreset ──

test("VAL-CORE-005: normalizeQueryPreset fills defaults and trims strings", () => {
  const normalized = normalizeQueryPreset({
    id: "  q1  ",
    name: "  My Query  ",
    builtin: false,
    hidden: false,
    filters: {
      search: "  focus  ",
      tags: ["  #alpha  ", "#beta"],
      status: ["todo", "done"],
      time: { scheduled: "  today  ", deadline: "overdue" },
    },
    // Legacy view shape with preset — preset is dropped during migration.
    view: { type: "week", preset: "  today  " },
    summary: [
      { type: "count" },
      { type: "sum", field: "  actual  ", format: "  duration  " },
    ],
  });

  assert.equal(normalized.id, "q1");
  assert.equal(normalized.name, "My Query");
  assert.equal(normalized.builtin, false);
  assert.equal(normalized.hidden, false);
  // US-109z2: tab-level filters are dropped (filtering is per-area `when`).
  assert.equal(normalized.filters, undefined);
  // Legacy {type:"week", preset} migrates to a week area layout; preset dropped.
  assert.deepEqual(normalized.view, { layout: { type: "week" } });
});

test("VAL-CORE-005: normalizeQueryPreset defaults missing fields", () => {
  const normalized = normalizeQueryPreset({ id: "q2", name: "Minimal", builtin: false, hidden: false, filters: {}, view: { type: "list" }, summary: [] });

  assert.equal(normalized.id, "q2");
  // US-109z2: no tab-level filters on the normalized preset.
  assert.equal(normalized.filters, undefined);
  assert.deepEqual(normalized.view, { layout: { type: "list" } });
});

test("VAL-CORE-005: normalizeQueryPreset drops legacy list sections", () => {
  const normalized = normalizeQueryPreset({
    id: "q-sections",
    name: "Sections",
    builtin: false,
    hidden: false,
    filters: {},
    view: {
      type: "list",
      sections: [
        { id: "a", title: "A", when: { status: ["todo"] } },
        { id: "b", title: "B", when: {} },
      ],
    },
    summary: [],
  });

  // list no longer groups internally. Feeding a legacy `{type:list, sections}`
  // must migrate cleanly to a plain list area — the deepEqual proves nothing
  // extra (no sections) survived, without naming the dead field. Multi-segment
  // views (Today) use col[ list×N ] instead.
  assert.deepEqual(normalized.view.layout, { type: "list" });
});

test("VAL-CORE-005: normalizeQueryPreset migrates legacy week tray into a stack layout", () => {
  const normalized = normalizeQueryPreset({
    id: "q-tray",
    name: "Tray",
    builtin: false,
    hidden: false,
    filters: {},
    view: {
      type: "week",
      tray: {
        enabled: true,
        title: "Backlog",
        filters: { status: ["todo"] },
        orderBy: ["scheduled"],
      },
    },
    summary: [],
  });

  const layout = normalized.view.layout;
  assert.equal(layout.dir, "col");
  assert.equal(layout.children.length, 2);
  assert.deepEqual(layout.children[0], { type: "week" });
  const tray = layout.children[1];
  assert.equal(tray.type, "list");
  assert.equal(tray.title, "Backlog");
  assert.deepEqual(tray.when, { status: ["todo"] });
  assert.deepEqual(tray.orderBy, ["scheduled"]);
  assert.deepEqual(tray.onDrop, { clearScheduled: true });
});

test("normalizeQueryPreset: unsupported area type → unknown area preserving raw JSON", () => {
  // matrix was removed; any unsupported `type` (including old "matrix") becomes
  // an `unknown` area that keeps the original JSON so the view can render
  // "未知类型 + JSON" instead of silently dropping it.
  const normalized = normalizeQueryPreset({
    id: "q-unknown",
    name: "U",
    builtin: false,
    hidden: false,
    filters: {},
    view: {
      layout: {
        type: "matrix",
        title: "Old Matrix",
        x: { id: "urgency" },
        y: { id: "importance" },
      },
    },
    summary: [],
  });

  const layout = normalized.view.layout;
  assert.equal(layout.type, "unknown");
  assert.equal(layout.rawType, "matrix");
  assert.equal(layout.title, "Old Matrix");
  assert.ok(layout.raw && typeof layout.raw === "object", "raw JSON preserved");
  assert.equal(layout.raw.x.id, "urgency");
});

test("VAL-CORE-005: normalizeQueryPreset deduplicates tags case-insensitively", () => {
  // US-109z2: tag dedup now applies to an area's `when` (no tab-level filter).
  const normalized = normalizeQueryPreset({
    id: "q3", name: "Dedup", builtin: false, hidden: false,
    view: { layout: { type: "list", when: { tags: ["#Alpha", "#alpha", "#BETA", "#Beta"] } } },
  });

  // US-109d4: migrated to an expression; tags lowercased + deduped.
  assert.deepEqual(normalized.view.layout.when.tags, { expr: "#alpha and #beta" });
});

// ── US-109d3: tag exclude group normalization ──

test("US-109d4: legacy include+exclude migrates to an expression", () => {
  const normalized = normalizeQueryPreset({
    id: "q-excl", name: "Excl", builtin: false, hidden: false,
    view: { layout: { type: "list", when: { tags: { values: ["#work"], mode: "and", exclude: ["#someday"] } } } },
  });
  assert.deepEqual(normalized.view.layout.when.tags, { expr: "#work and not #someday" });
});

test("US-109d4: legacy exclude-only (empty include) migrates to an expression", () => {
  const normalized = normalizeQueryPreset({
    id: "q-excl2", name: "ExclOnly", builtin: false, hidden: false,
    view: { layout: { type: "list", when: { tags: { values: [], mode: "and", exclude: ["#done"] } } } },
  });
  assert.deepEqual(normalized.view.layout.when.tags, { expr: "not #done" });
});

test("US-109d4: a tag in both include and exclude stays in include during migration", () => {
  const normalized = normalizeQueryPreset({
    id: "q-excl3", name: "Mutual", builtin: false, hidden: false,
    view: { layout: { type: "list", when: { tags: { values: ["#work"], mode: "or", exclude: ["#work", "#someday"] } } } },
  });
  assert.deepEqual(normalized.view.layout.when.tags, { expr: "#work and not #someday" });
});

test("US-109d4: plain AND include migrates to an and-joined expression", () => {
  const normalized = normalizeQueryPreset({
    id: "q-excl4", name: "Bare", builtin: false, hidden: false,
    view: { layout: { type: "list", when: { tags: { values: ["#work"], mode: "and", exclude: [] } } } },
  });
  assert.deepEqual(normalized.view.layout.when.tags, { expr: "#work" });
});

// ── VAL-CORE-006: validateQueryPreset — section-specific errors ──

test("VAL-CORE-006: validateQueryPreset — valid preset returns no errors", () => {
  const result = validateQueryPreset({
    name: "Valid",
    view: { layout: { type: "week", when: { search: "focus", tags: ["#work"], status: ["todo"], time: { scheduled: "today" } } } },
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("VAL-CORE-006: validateQueryPreset — valid layout view returns no errors", () => {
  const result = validateQueryPreset({
    name: "ValidLayout",
    view: { layout: { dir: "col", children: [{ type: "week" }, { type: "list" }] } },
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("VAL-CORE-006: validateQueryPreset — missing name is a filters error", () => {
  const result = validateQueryPreset({
    view: { layout: { type: "list" } },
  });

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].section, "filters");
  assert.equal(result.errors[0].code, "missing_name");
});

test("VAL-CORE-006: validateQueryPreset — non-object root is a filters error", () => {
  const result = validateQueryPreset("not an object");

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].section, "filters");
  assert.equal(result.errors[0].code, "not_object");
});

test("VAL-CORE-006: validateQueryPreset — invalid filters.status points to filters section", () => {
  const result = validateQueryPreset({
    name: "BadStatus",
    view: { layout: { type: "list", when: { status: 42 } } },
  });

  assert.equal(result.valid, false);
  const statusErr = result.errors.find((e) => e.section === "view" && e.code === "invalid_status");
  assert.ok(statusErr, "Expected invalid_status error in filters section");
});

test("VAL-CORE-006: validateQueryPreset — invalid filters.tags points to filters", () => {
  const result = validateQueryPreset({
    name: "BadTags",
    view: { layout: { type: "list", when: { tags: 42 } } },
  });

  assert.equal(result.valid, false);
  const tagErr = result.errors.find((e) => e.section === "view" && e.code === "invalid_tags");
  assert.ok(tagErr, "Expected invalid_tags error in filters section");
});

test("VAL-CORE-006: validateQueryPreset — invalid filters.time points to filters", () => {
  const result = validateQueryPreset({
    name: "BadTime",
    view: { layout: { type: "list", when: { time: "not-an-object" } } },
  });

  assert.equal(result.valid, false);
  const timeErr = result.errors.find((e) => e.section === "view" && e.code === "invalid_time");
  assert.ok(timeErr, "Expected invalid_time error in filters section");
});

test("VAL-CORE-006: validateQueryPreset — unknown legacy view.type points to view", () => {
  const result = validateQueryPreset({
    name: "BadView",
    view: { type: "gantt" },
  });

  assert.equal(result.valid, false);
  const viewErr = result.errors.find((e) => e.section === "view" && e.code === "legacy_query");
  assert.ok(viewErr, "Expected unknown_view_type error in view section");
  assert.ok(viewErr.message.includes("view.layout"));
});

test("US-103c/US-219: unknown types are rejected on submission but retained on stored-data loading", () => {
  const input = { name: "Unknown", view: { layout: { type: "gantt", title: "Keep me" } } };
  assert.equal(validateQueryPreset(input).valid, false);
  assert.throws(() => parseQueryDsl(JSON.stringify(input)), /view.layout.type/);
  const stored = normalizeQueryPreset(input).view.layout;
  assert.equal(stored.type, "unknown");
  assert.equal(stored.rawType, "gantt");
  assert.equal(stored.raw.title, "Keep me");
});

test("VAL-CORE-006: validateQueryPreset — non-string area type errors", () => {
  const result = validateQueryPreset({
    name: "BadAreaType",
    view: { layout: { type: 42 } },
  });

  assert.equal(result.valid, false);
  const viewErr = result.errors.find((e) => e.section === "view" && e.code === "invalid_area_type");
  assert.ok(viewErr, "Expected invalid_area_type error for a non-string type");
});

test("VAL-CORE-006: validateQueryPreset — drop area without onDrop points to view", () => {
  const result = validateQueryPreset({
    name: "BadDrop",
    view: { layout: { type: "drop" } },
  });

  assert.equal(result.valid, false);
  const viewErr = result.errors.find((e) => e.section === "view" && e.code === "drop_requires_on_drop");
  assert.ok(viewErr, "Expected drop_requires_on_drop error in view section");
});

test("VAL-CORE-006: validateQueryPreset — stack with bad dir points to view", () => {
  const result = validateQueryPreset({
    name: "BadStackDir",
    view: { layout: { dir: "diagonal", children: [{ type: "list" }] } },
  });

  assert.equal(result.valid, false);
  const viewErr = result.errors.find((e) => e.section === "view" && e.code === "invalid_stack_dir");
  assert.ok(viewErr, "Expected invalid_stack_dir error in view section");
});

test("VAL-CORE-006: validateQueryPreset — stack with empty children points to view", () => {
  const result = validateQueryPreset({
    name: "EmptyStack",
    view: { layout: { dir: "col", children: [] } },
  });

  assert.equal(result.valid, false);
  const viewErr = result.errors.find((e) => e.section === "view" && e.code === "invalid_stack_children");
  assert.ok(viewErr, "Expected invalid_stack_children error in view section");
});

test("VAL-CORE-006: validateQueryPreset — non-object view points to view", () => {
  const result = validateQueryPreset({
    name: "BadViewObj",
    view: "not-an-object",
  });

  assert.equal(result.valid, false);
  const viewErr = result.errors.find((e) => e.section === "view" && e.code === "invalid_view");
  assert.ok(viewErr, "Expected invalid_view error in view section");
});

test("VAL-CORE-006: validateQueryPreset — valid preset stays unchanged after validation", () => {
  const preset = {
    id: "stays-put",
    name: "StaysPut",
    builtin: false,
    hidden: false,
    filters: { status: ["todo"] },
    view: { layout: { type: "list" } },
  };

  const before = JSON.stringify(preset);
  validateQueryPreset(preset);
  const after = JSON.stringify(preset);

  assert.equal(before, after, "Preset must not be mutated by validation");
});

test("US-219: validateQueryPreset collects errors from multiple area fields", () => {
  const result = validateQueryPreset({
    name: "MultiError",
    view: { layout: { type: "list", when: { tags: 42, search: 3 } } },
  });

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some(e => e.message.includes("when.tags")));
  assert.ok(result.errors.some(e => e.message.includes("when.search")));
});

// ── VAL-CORE-005 / VAL-CROSS-002: isLegacySavedTaskView ──

test("VAL-CROSS-002: isLegacySavedTaskView detects flat SavedTaskView shape", () => {
  // Legacy shape: flat search/tag/time/status at top level
  assert.equal(isLegacySavedTaskView({
    id: "sv-legacy",
    name: "Legacy View",
    search: "docs",
    tag: "#work",
    time: { scheduled: "today" },
    status: "todo",
    view: { type: "list" },
  }), true, "Flat search/tag/time/status → legacy");
});

test("VAL-CROSS-002: isLegacySavedTaskView rejects QueryPreset with nested filters", () => {
  assert.equal(isLegacySavedTaskView({
    id: "preset-1",
    name: "Modern",
    filters: { search: "docs" },
    view: { type: "list" },
    summary: [],
  }), false, "Nested filters → not legacy");
});

test("VAL-CROSS-002: isLegacySavedTaskView returns false for non-objects", () => {
  assert.equal(isLegacySavedTaskView(null), false);
  assert.equal(isLegacySavedTaskView("string"), false);
  assert.equal(isLegacySavedTaskView(42), false);
  assert.equal(isLegacySavedTaskView([]), false);
});

test("VAL-CROSS-002: isLegacySavedTaskView detects legacy with only search", () => {
  assert.equal(isLegacySavedTaskView({ id: "x", name: "X", search: "text" }), true);
});

test("VAL-CROSS-002: isLegacySavedTaskView detects legacy with only time", () => {
  assert.equal(isLegacySavedTaskView({ id: "x", name: "X", time: { scheduled: "today" } }), true);
});

test("VAL-CROSS-002: isLegacySavedTaskView detects legacy with only status", () => {
  assert.equal(isLegacySavedTaskView({ id: "x", name: "X", status: "todo" }), true);
});

// ── VAL-CORE-005 / VAL-CROSS-002: 7 builtin presets ──

test("VAL-CROSS-002: createBuiltinQueryPresets produces 7 default presets", () => {
  const presets = createBuiltinQueryPresets();

  assert.equal(presets.length, 7, "7 builtins: 今日, 本周, 本月, TODO, 未排期, 已完成, 已放弃");
  const ids = presets.map((p) => p.id);
  assert.deepEqual(ids, [
    "preset-today",
    "preset-week",
    "preset-month",
    "preset-todo",
    "preset-unscheduled",
    "preset-completed",
    "preset-dropped",
  ]);

  // All are builtin
  for (const p of presets) {
    assert.equal(p.builtin, true);
    assert.equal(p.hidden, false);
  }
});

test("VAL-CROSS-002: createBuiltinQueryPresets uses custom labels", () => {
  const presets = createBuiltinQueryPresets({
    today: "今日",
    week: "本周",
    month: "本月",
    todo: "TODO",
    unscheduled: "未排期",
    completed: "已完成",
    dropped: "已放弃",
  });

  assert.equal(presets[0].name, "今日");
  assert.equal(presets[3].name, "TODO");
  assert.equal(presets[6].name, "已放弃");
});

test("VAL-CROSS-002: TODO builtin preset filters todo tasks", () => {
  // US-109z2: status filter lives on the content area's `when`, not a tab filter.
  const presets = createBuiltinQueryPresets();
  const todoPreset = presets.find((p) => p.id === "preset-todo");
  assert.ok(todoPreset);
  assert.equal(todoPreset.filters, undefined);
  assert.equal(todoPreset.view.layout.type, "list");
  assert.deepEqual(todoPreset.view.layout.when.status, ["todo"]);
});

test("VAL-CROSS-002: Dropped builtin preset filters dropped tasks", () => {
  const presets = createBuiltinQueryPresets();
  const droppedPreset = presets.find((p) => p.id === "preset-dropped");
  assert.ok(droppedPreset);
  assert.equal(droppedPreset.filters, undefined);
  assert.equal(droppedPreset.view.layout.type, "list");
  // The dropped preset's content area filters for dropped/abandoned tasks.
  assert.deepEqual(droppedPreset.view.layout.when.status, ["dropped"]);
});

// ── VAL-CORE-005: stringifyQueryPreset / parseQueryDsl ──

test("VAL-CORE-005: stringifyQueryPreset emits normalized JSON", () => {
  const preset = normalizeQueryPreset({
    id: "preset-json",
    name: "JSON Test",
    builtin: false,
    hidden: false,
    filters: { search: "focus", tags: ["#alpha", "#beta"], status: ["todo"], time: { scheduled: "week" } },
    view: { type: "month", preset: "today" },
    summary: [{ type: "count" }],
  });

  const text = stringifyQueryPreset(preset);
  const parsed = JSON.parse(text);

  // US-109z2: no tab-level filters; preset is identity + view only.
  assert.deepEqual(parsed, {
    id: "preset-json",
    name: "JSON Test",
    builtin: false,
    hidden: false,
    // Legacy {type:"month", preset} migrates to a month area layout; preset dropped.
    view: { layout: { type: "month" } },
  });
});

test("VAL-CORE-005: parseQueryDsl parses and normalizes JSON DSL", () => {
  const preset = parseQueryDsl(JSON.stringify({
    name: " Deep Work ",
    view: {
      layout: {
        type: "week",
        when: {
          search: " docs ",
          tags: ["alpha", "#beta", "alpha"],
          status: ["todo", "done"],
          time: { scheduled: " week " },
        },
      },
    },
  }), { id: "preset-existing" });

  assert.equal(preset.id, "preset-existing");
  assert.equal(preset.name, "Deep Work");
  assert.equal(preset.builtin, false);
  // US-109z2: tab-level filters are dropped on parse.
  assert.equal(preset.filters, undefined);
  assert.deepEqual(preset.view, {
    layout: {
      type: "week",
      when: {
        search: "docs",
        tags: { expr: "#alpha and #beta" },
        status: ["todo", "done"],
        time: { scheduled: "week" },
      },
    },
  });
});

test("VAL-CORE-005: parseQueryDsl missing name throws", () => {
  assert.throws(() => {
    parseQueryDsl(JSON.stringify({ view: { layout: { type: "list" } } }));
  }, /DSL 缺少 name/);
});

test("VAL-CORE-005: parseQueryDsl generates id when missing", () => {
  const preset = parseQueryDsl(JSON.stringify({ name: "AutoId", view: { layout: { type: "list" } } }));
  assert.ok(preset.id, "Should generate an id");
  assert.ok(preset.id.startsWith("sv-"), "Should use default id prefix");
});

// ── VAL-CROSS-002: Legacy rejection does not crash settings-like load ──

test("VAL-CROSS-002: filtering legacy views from mixed array works safely", () => {
  const mixed = [
    // Legacy shapes (should be detected)
    { id: "sv-legacy-1", name: "Legacy 1", search: "docs", tag: "", time: {}, status: "all", view: { type: "list" } },
    { id: "sv-legacy-2", name: "Legacy 2", search: "", tag: "#work", time: {}, status: "todo" },
    // QueryPreset shapes (should pass through)
    { id: "preset-modern", name: "Modern", builtin: false, hidden: false, filters: { status: ["todo"] }, view: { type: "list" }, summary: [] },
    null,
    42,
    "string",
  ];

  const legacyCount = mixed.filter((v) => isLegacySavedTaskView(v)).length;
  assert.equal(legacyCount, 2, "Exactly 2 legacy shapes detected");

  const clean = mixed.filter((v) => !isLegacySavedTaskView(v));
  assert.equal(clean.length, 4, "4 non-legacy entries remain (modern + null + 42 + string)");
});

// ── VAL-CORE-006: validation preserves saved state ──

test("VAL-CORE-006: invalid DSL parse error does not produce a mutated preset", () => {
  // parseQueryDsl throws on invalid JSON — no preset is returned
  assert.throws(() => {
    parseQueryDsl("not json");
  }, /解析失败/);
});

// ── VAL-CORE-005 / VAL-CROSS-002: parseQueryDsl rejects legacy flat DSL ──

test("VAL-CROSS-002: parseQueryDsl rejects legacy flat SavedTaskView DSL", () => {
  const legacyJson = JSON.stringify({
    name: "Legacy View",
    search: "docs",
    tag: "#work",
    time: { scheduled: "today" },
    status: "todo",
    view: { type: "list" },
  });
  assert.throws(
    () => { parseQueryDsl(legacyJson); },
    /更新 skill.*view\.layout.*when/,
    "Legacy flat search/tag/time/status DSL must throw",
  );
});

test("VAL-CROSS-002: parseQueryDsl rejects legacy with only search", () => {
  const legacyJson = JSON.stringify({
    name: "Search Only",
    search: "focus",
    view: { type: "list" },
  });
  assert.throws(
    () => { parseQueryDsl(legacyJson); },
    /更新 skill.*view\.layout.*when/,
  );
});

test("VAL-CROSS-002: parseQueryDsl rejects legacy with only status", () => {
  const legacyJson = JSON.stringify({
    name: "Status Only",
    status: "todo",
    view: { type: "list" },
  });
  assert.throws(
    () => { parseQueryDsl(legacyJson); },
    /更新 skill.*view\.layout.*when/,
  );
});

test("US-217a: parseQueryDsl rejects pre-1.0 nested filters / summary DSL and points to skill update", () => {
  const legacyJson = JSON.stringify({
    name: "Old Skill Query",
    filters: { status: ["todo"], tags: ["#work"] },
    view: { type: "week" },
    summary: [{ type: "count" }],
  });
  assert.throws(
    () => { parseQueryDsl(legacyJson); },
    /npx skills add CorrectRoadH\/obsidian-task-center.*view\.layout.*when/,
  );
});

test("VAL-CROSS-002: parseQueryDsl rejects legacy wrapped in query key", () => {
  const wrappedLegacy = JSON.stringify({
    query: {
      name: "Wrapped Legacy",
      search: "docs",
      status: "todo",
      view: { type: "list" },
    },
  });
  assert.throws(
    () => { parseQueryDsl(wrappedLegacy); },
    /更新 skill.*view\.layout.*when/,
    'Legacy shape inside {"query": {...}} wrapper must also be rejected',
  );
});

test("VAL-CROSS-002: parseQueryDsl accepts valid 1.0 QueryPreset with area when", () => {
  const validJson = JSON.stringify({
    name: "Modern Query",
    view: { layout: { type: "week", when: { search: "docs", tags: ["#work"], status: ["todo"] } } },
  });
  const preset = parseQueryDsl(validJson);
  assert.equal(preset.name, "Modern Query");
  // US-109z2: tab-level filters dropped on parse.
  assert.equal(preset.filters, undefined);
  assert.equal(preset.view.layout.type, "week");
  assert.deepEqual(preset.view.layout.when, { search: "docs", tags: { expr: "#work" }, status: ["todo"] });
});

test("VAL-CROSS-002: parseQueryDsl accepts valid QueryPreset in query wrapper", () => {
  const wrappedJson = JSON.stringify({
    query: {
      name: "Wrapped Query",
      view: { layout: { type: "list", when: { status: ["done"] } } },
    },
  });
  const preset = parseQueryDsl(wrappedJson);
  assert.equal(preset.name, "Wrapped Query");
  assert.equal(preset.filters, undefined);
  assert.deepEqual(preset.view.layout.when, { status: ["done"] });
});

// ── VAL-CORE-006: parseQueryDsl validates after normalize ──

test("VAL-CORE-006: parseQueryDsl rejects invalid view type after parse", () => {
  const badJson = JSON.stringify({
    name: "Bad View",
    view: { layout: { type: 42 } },
  });
  assert.throws(
    () => { parseQueryDsl(badJson); },
    /view.*invalid_area_type/,
    "parseQueryDsl must call validateQueryPreset and surface view errors",
  );
});

test("VAL-CORE-006: parseQueryDsl collects multiple section errors in message", () => {
  const badJson = JSON.stringify({
    name: "Multi Bad",
    view: { layout: { dir: "diagonal", children: [] } },
  });
  assert.throws(
    () => { parseQueryDsl(badJson); },
    (err) => {
      const msg = err.message;
      return /\[view\]/.test(msg) && /invalid_stack_dir/.test(msg) && /invalid_stack_children/.test(msg);
    },
    "Multiple view errors should appear in error message",
  );
});

test("VAL-CORE-006: validateQueryPreset on invalid preset does not mutate the input", () => {
  const input = {
    name: "Immutable",
    filters: { tags: 42 }, // invalid
    view: { type: "gantt" }, // invalid
    summary: "invalid",
  };
  const frozen = JSON.stringify(input);

  validateQueryPreset(input);

  assert.equal(JSON.stringify(input), frozen, "Input must not be mutated by validation");
});

// US-219: reject malformed area predicates before normalization can erase them.
for (const [field, value, suffix] of [
  ['status', ['doing'], 'status'], ['tags', 5, 'tags'],
  ['tags', { expr: '#a and (' }, 'tags.expr'], ['tags', ['#a', 5], 'tags'],
  ['tags', { values: ['#a'], mode: 'xor' }, 'tags.mode'],
  ['search', 3, 'search'], ['time', 'today', 'time'],
  ['time', { scheduled: 'yesterday' }, 'time.scheduled'],
  ['time', { scheduled: '2026-02-30' }, 'time.scheduled'],
  ['time', { scheduled: '2026-10-20..2026-10-01' }, 'time.scheduled'],
  ['time', { scheduled: 'overdue' }, 'time.scheduled'],
  ['time', { scheduled: 'not-overdue' }, 'time.scheduled'],
  ['time', { typo: 'today' }, 'time.typo'],
]) {
  test(`US-219: rejects invalid nested when.${suffix}: ${JSON.stringify(value)}`, () => {
    const input = { name: 'Bad', view: { layout: { dir: 'col', children: [
      { type: 'week', when: { [field]: value } },
    ] } } };
    const result = validateQueryPreset(input);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes(`view.layout.children[0].when.${suffix}`)));
    assert.throws(() => parseQueryDsl(JSON.stringify(input)));
  });
}
for (const onDrop of [{}, { setStatus: 'done' }, { clearScheduled: true }, { setStatus: 'dropped', clearScheduled: true }]) {
  test(`US-100/US-219: drop only accepts abandonment: ${JSON.stringify(onDrop)}`, () => {
    assert.throws(() => parseQueryDsl(JSON.stringify({ name: 'Drop', view: { layout: { type: 'drop', onDrop } } })), /onDrop/);
  });
}
test('US-219: list/grid onDrop accepts exactly one supported action', () => {
  for (const type of ['list', 'grid']) {
    for (const onDrop of [{ setStatus: 'done' }, { setStatus: 'dropped' }, { setScheduled: 'tomorrow' }, { clearScheduled: true }]) {
      assert.deepEqual(parseQueryDsl(JSON.stringify({ name: 'Action', view: { layout: { type, onDrop } } })).view.layout.onDrop, onDrop);
    }
    for (const onDrop of [{}, { setStatus: 'doing' }, { clearScheduled: false }, { setScheduled: 'week' }, { setScheduled: 'today', clearScheduled: true }]) {
      assert.throws(() => parseQueryDsl(JSON.stringify({ name: 'Action', view: { layout: { type, onDrop } } })), /onDrop/);
    }
  }
});
test('US-109i/US-109t: dropped date survives round-trip and retired density is ignored on load', () => {
  const preset = parseQueryDsl(JSON.stringify({ name: 'Dropped', view: { layout: { type: 'list', when: { time: { dropped: 'today' } } } } }));
  assert.equal(JSON.parse(stringifyQueryPreset(preset)).view.layout.when.time.dropped, 'today');
  const loaded = normalizeQueryPreset({ name: 'Old', view: { layout: { type: 'month', density: 'compact' } } });
  assert.equal(loaded.view.layout.density, undefined);
  assert.throws(() => parseQueryDsl(JSON.stringify({ name: 'New', view: { layout: { type: 'month', density: 'compact' } } })), /density/);
});
test('US-217a: legacy fields mixed with layout are rejected', () => {
  assert.throws(() => parseQueryDsl(JSON.stringify({ name: 'Mixed', view: { type: 'week', layout: { type: 'list' } } })), /view.layout/);
});


test('US-219: DSL diagnostics follow the current Obsidian language', () => {
  try {
    globalThis.window.localStorage.getItem = () => 'en';
    assert.throws(() => parseQueryDsl(JSON.stringify({ name: 'Bad', view: { layout: { type: 'list', when: { search: 3 } } } })), /view.layout.when.search must be a string/);
    globalThis.window.localStorage.getItem = () => 'zh';
    assert.throws(() => parseQueryDsl(JSON.stringify({ name: 'Bad', view: { layout: { type: 'list', when: { search: 3 } } } })), /view.layout.when.search 必须是字符串/);
  } finally { globalThis.window.localStorage.getItem = () => 'zh'; }
});


test('US-720b: deadline not-overdue survives DSL serialization and re-editing', () => {
  const preset = parseQueryDsl(JSON.stringify({ name: 'Picks', view: { layout: { type: 'list', when: { time: { deadline: 'not-overdue' } } } } }));
  const edited = parseQueryDsl(stringifyQueryPreset(preset));
  assert.equal(edited.view.layout.when.time.deadline, 'not-overdue');
});
