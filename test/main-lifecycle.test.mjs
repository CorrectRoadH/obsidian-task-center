import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import esbuild from "esbuild";

const compiledPath = "test/.compiled/main-lifecycle.bundle.js";

function stubModule(contents) {
  return {
    contents,
    loader: "js",
  };
}

async function compile() {
  mkdirSync("test/.compiled", { recursive: true });
  await esbuild.build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: compiledPath,
    plugins: [
      {
        name: "main-lifecycle-stubs",
        setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({
            path: "obsidian",
            namespace: "main-lifecycle-stub",
          }));
          build.onResolve({ filter: /^\.\/(types|settings|view|cli|api|cache|status-bar|dep-health|quickadd|i18n|dates|parser|writer|platform)$/ }, (args) => {
            // US-219: exercise real DSL translations; stub only the Obsidian language boundary.
            if (args.path === "./i18n" && args.importer.endsWith("/saved-views.ts")) return undefined;
            return { path: args.path, namespace: "main-lifecycle-stub" };
          });
          build.onLoad({ filter: /.*/, namespace: "main-lifecycle-stub" }, (args) => {
            switch (args.path) {
              case "obsidian":
                return stubModule(`
                  export class Plugin {
                    constructor(app) {
                      this.app = app;
                      this._commands = [];
                      this._ribbons = [];
                      this._events = [];
                      this._settingsTabs = [];
                    }
                    async loadData() { return {}; }
                    registerEvent(ref) { this._events.push(ref); }
                    addRibbonIcon(icon, title, callback) { this._ribbons.push({ icon, title, callback }); }
                    addCommand(command) { this._commands.push(command); }
                    addSettingTab(tab) { this._settingsTabs.push(tab); }
                    addStatusBarItem() { return { empty() {}, remove() {}, createSpan() { return this; }, setText() {}, addClass() {}, setAttr() {} }; }
                    registerCliHandler(command, description, flags, handler) {
                      this.app.__cliHandlers ??= new Map();
                      if (this.app.__cliHandlers.has(command)) {
                        throw new Error('Command "' + command + '" is already registered as a handler.');
                      }
                      this.app.__cliHandlers.set(command, { description, flags, handler });
                    }
                    registerView(type, creator) {
                      this.app.__viewCreators ??= new Map();
                      if (this.app.__viewCreators.has(type)) {
                        throw new Error('Attempting to register an existing view type "' + type + '"');
                      }
                      this.app.__viewCreators.set(type, creator);
                    }
                  }
                  export class Notice { constructor(message) { globalThis.__taskCenterNotices?.push(message); } }
                  export class WorkspaceLeaf {}
                  export function getLanguage() { return "zh"; }
                `);
              case "./types":
                return stubModule(`
                  export const VIEW_TYPE_TASK_CENTER = "task-center-board";
                  export const DEFAULT_SETTINGS = { openOnStartup: false };
                `);
              case "./settings":
                return stubModule("export class TaskCenterSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }");
              case "./view":
                return stubModule(`
                  export class TaskCenterView {
                    constructor(leaf, plugin) {
                      this.leaf = leaf;
                      this.plugin = plugin;
                      this.__openManageTabsCalls = 0;
                    }
                    openManageTabs() {
                      this.__openManageTabsCalls++;
                    }
                    async reloadTasks() {}
                    render() {}
                  }
                `);
              case "./cli":
                return stubModule(`
                  export function formatList() { return ""; }
                  export function formatShow() { return ""; }
                  export function formatStats() { return ""; }
                  export function formatAgentBrief() { return ""; }
                  export function formatReviewSummary() { return ""; }
                  export function formatQueryRun(result) { return "Query " + result.preset.id + " · " + result.preset.name + "\\nview " + result.view.type + " · " + result.filteredTasks.length + " tasks · anchor " + result.anchorISO; }
                  export function formatOkWrite() { return ""; }
                  export function formatAdd() { return ""; }
                `);
              case "./api":
                return stubModule(`
                  export class TaskCenterApi {
                    constructor(app, cache) {
                      this.app = app;
                      this.cache = cache;
                    }
                  }
                `);
              case "./cache":
                return stubModule("export class TaskCache { constructor(app) { this.app = app; } bind() { return []; } dispose() {} async forFlush() {} }");
              case "./status-bar":
                return stubModule("export class StatusBar { constructor(el, cache, options) { this.el = el; this.cache = cache; this.options = options; } refresh() {} flush() {} dispose() {} }");
              case "./dep-health":
                return stubModule("export class DepHealthBanner { constructor(el, app, options) { this.el = el; this.app = app; this.options = options; } refresh() {} dispose() {} }");
              case "./quickadd":
                return stubModule("export class QuickAddModal { constructor(app, api, onAdd, settings) {} open() {} }");
              case "./i18n":
                return stubModule("export function t(key) { return key; }");
              case "./dates":
                return stubModule("export function todayISO() { return '2026-04-29'; }");
              case "./parser":
                return stubModule("export function parseDurationToMinutes() { return null; }");
              case "./writer":
                return stubModule(`
                  export class TaskWriterError extends Error {
                    constructor(code, hint) {
                      super(code + ": " + hint);
                      this.code = code;
                      this.hint = hint;
                    }
                  }
                `);
              case "./platform":
                return stubModule("export function __setTestForceMobile() {}");
              default:
                throw new Error(`Unhandled stub module: ${args.path}`);
            }
          });
        },
      },
    ],
  });
}

function makeAppWithExistingTaskCenterView() {
  const app = {
    __viewCreators: new Map([["task-center-board", () => ({})]]),
    __cliHandlers: new Map(),
    workspace: {
      onLayoutReady(callback) {
        app.__layoutCallbacks.push(callback);
      },
      on(event, callback) {
        return { event, callback };
      },
      revealLeaf() {},
      getLeavesOfType() {
        return [];
      },
    },
    __layoutCallbacks: [],
  };
  return app;
}

function makeAppWithExistingRegistrations() {
  const app = makeAppWithExistingTaskCenterView();
  app.__cliHandlers.set("task-center:list", {});
  return app;
}

async function createPluginForQueryCli(overrides = {}) {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}-${Math.random()}`);
  const app = makeAppWithExistingTaskCenterView();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);
  const calls = { save: 0, refresh: 0 };
  plugin.settings = {
    queryPresets: [],
    deletedBuiltinIds: [],
    defaultSavedViewId: null,
    lastSavedViewId: null,
    groupingTags: [],
    ...overrides,
  };
  plugin.saveSettings = async () => {
    calls.save++;
  };
  plugin.refreshOpenViews = async () => {
    calls.refresh++;
  };
  return { plugin, calls };
}

function withDeterministicSavedViewId(fn) {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => 1714764600000;
  Math.random = () => 0.123456789;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Date.now = originalNow;
      Math.random = originalRandom;
    });
}

test("plugin onload rejects duplicate view registration in the production path", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}`);
  const app = makeAppWithExistingTaskCenterView();
  const plugin = new TaskCenterPlugin(app);

  await assert.rejects(
    () => plugin.onload(),
    /Attempting to register an existing view type "task-center-board"/,
  );
});

test("plugin onload rejects duplicate native CLI handlers in the production path", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}`);
  const app = makeAppWithExistingRegistrations();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);

  await assert.rejects(
    () => plugin.onload(),
    /Command "task-center:list" is already registered as a handler/,
  );
});

test("CLI write handlers rely on cache events instead of directly refreshing open views", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}`);
  const app = makeAppWithExistingTaskCenterView();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);
  await plugin.onload();

  let refreshCalls = 0;
  plugin.refreshOpenViews = async () => {
    refreshCalls++;
  };
  plugin.api = {
    async done() {
      return { before: "- [ ] A", after: "- [x] A", unchanged: false };
    },
    async show() {
      return { id: "Tasks/Inbox.md:L1", completed: "2026-04-29" };
    },
  };

  await plugin.cliDone({ ref: "Tasks/Inbox.md:L1" });
  assert.equal(refreshCalls, 0, "CLI writes should not force an immediate view render");
});

test("loadSettings seeds built-in query tabs and migrates legacy defaultView/lastTab to saved-view ids", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}-${Math.random()}`);
  const app = makeAppWithExistingTaskCenterView();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);
  plugin.loadData = async () => ({
    queryPresets: [
      {
        id: "sv-custom",
        name: "Custom",
        builtin: false,
        hidden: false,
        filters: { search: "docs", tags: ["#work"], status: ["todo"], time: {} },
        view: { type: "list" },
        summary: [],
      },
    ],
    defaultView: "month",
    lastTab: "completed",
  });

  await plugin.loadSettings();

  assert.deepEqual(plugin.settings.queryPresets.map((view) => view.id), [
    "sv-custom",
    "preset-today",
    "preset-week",
    "preset-month",
    "preset-todo",
    "preset-unscheduled",
    "preset-completed",
    "preset-dropped",
  ]);
  assert.equal(plugin.settings.defaultSavedViewId, "preset-month");
  assert.equal(plugin.settings.lastSavedViewId, "preset-completed");
});

test("US-414: loadSettings migrates legacy flat SavedTaskView instead of dropping it", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}-${Math.random()}`);
  const app = makeAppWithExistingTaskCenterView();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);
  plugin.loadData = async () => ({
    queryPresets: [
      // legacy flat shape (0.8.27): top-level search/tag/status/time, no nested filters
      { id: "sv-legacy", name: "Legacy", builtin: false, hidden: true, search: "report", tag: "work", status: ["todo"], time: {}, view: { type: "week" }, summary: [] },
    ],
  });

  await plugin.loadSettings();

  const migrated = plugin.settings.queryPresets.find((p) => p.id === "sv-legacy");
  assert.ok(migrated, "legacy custom view survives as a migrated QueryPreset");
  assert.equal(migrated.hidden, true, "user hidden flag preserved");
  // US-109z2: legacy flat tab-level filters are dropped (no tab filter).
  assert.equal(migrated.filters, undefined, "flat tab-level filters dropped");
  assert.ok(migrated.view.layout, "legacy view migrated to a layout tree");
});

test("US-414: loadSettings flags old-DSL view (nested filters but no layout) for the gate", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}-${Math.random()}`);
  const app = makeAppWithExistingTaskCenterView();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);
  plugin.loadData = async () => ({
    queryPresets: [
      // old DSL: filters already nested, but view is the old {type} shape
      { id: "sv-old-dsl", name: "Old DSL", builtin: false, hidden: false, filters: { status: ["todo"] }, view: { type: "month" }, summary: [] },
    ],
  });

  await plugin.loadSettings();

  assert.equal(plugin.migratedLegacyCount, 1, "old-DSL view counted as legacy");
  const migrated = plugin.settings.queryPresets.find((p) => p.id === "sv-old-dsl");
  assert.ok(migrated.view.layout, "old-DSL view migrated to a layout tree in memory");
});

test("US-415: onload does NOT persist migration — the gate must be confirmed first", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}-${Math.random()}`);
  const app = makeAppWithExistingTaskCenterView();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);
  plugin.loadData = async () => ({
    queryPresets: [
      { id: "sv-legacy", name: "Legacy", builtin: false, hidden: false, search: "x", tag: "deep", status: "all", time: {}, view: { type: "list" }, summary: [] },
    ],
  });
  let saves = 0;
  plugin.saveSettings = async () => { saves++; };

  await plugin.onload();
  for (const cb of app.__layoutCallbacks) cb();

  assert.equal(plugin.migratedLegacyCount, 1, "gate stays armed until user confirms");
  assert.equal(saves, 0, "onload never auto-persists the migration");
});

test("US-415: completeMigration persists once, clears the gate, and refreshes views", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}-${Math.random()}`);
  const app = makeAppWithExistingTaskCenterView();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);
  plugin.loadData = async () => ({
    queryPresets: [
      { id: "sv-legacy", name: "Legacy", builtin: false, hidden: false, search: "x", tag: "deep", status: "all", time: {}, view: { type: "list" }, summary: [] },
    ],
  });
  let saves = 0;
  let refreshes = 0;
  plugin.saveSettings = async () => { saves++; };
  plugin.refreshOpenViews = async () => { refreshes++; };

  await plugin.loadSettings();
  assert.equal(plugin.migratedLegacyCount, 1);

  await plugin.completeMigration();
  assert.equal(saves, 1, "migration persisted exactly once on confirm");
  assert.equal(plugin.migratedLegacyCount, 0, "gate cleared after confirm");
  assert.equal(refreshes, 1, "open boards refreshed to leave the gate");

  // idempotent: a second confirm is a no-op
  await plugin.completeMigration();
  assert.equal(saves, 1, "no extra persist after the gate is cleared");
});

test("US-415: completeMigration is a no-op when nothing was migrated", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}-${Math.random()}`);
  const app = makeAppWithExistingTaskCenterView();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);
  plugin.loadData = async () => ({
    queryPresets: [
      { id: "sv-modern", name: "Modern", builtin: false, hidden: false, filters: { status: "all" }, view: { layout: { type: "list" } }, summary: [] },
    ],
  });
  let saves = 0;
  plugin.saveSettings = async () => { saves++; };

  await plugin.loadSettings();
  assert.equal(plugin.migratedLegacyCount, 0, "modern data is not flagged");

  await plugin.completeMigration();
  assert.equal(saves, 0, "nothing to persist for new-structure data");
});

test("query-list 默认隐藏 hidden preset，format=json 会带出 builtin/default/hidden 元数据", async () => {
  const { plugin } = await createPluginForQueryCli({
    defaultSavedViewId: "sv-alpha",
    queryPresets: [
      {
        id: "preset-week",
        name: "Week",
        builtin: true,
        hidden: false,
        filters: { time: { scheduled: "week" }, status: ["todo"] },
        view: { type: "week" },
        summary: [],
      },
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { search: "focus", tags: ["#alpha"], time: {}, status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
      {
        id: "sv-beta",
        name: "Beta",
        builtin: false,
        hidden: true,
        filters: { tags: ["#beta"], status: "all" },
        view: { type: "month" },
        summary: [],
      },
    ],
  });

  const text = await plugin.cliQueryList({});
  assert.match(text, /^2 query presets/m);
  assert.match(text, /preset-week  Week  builtin · visible/);
  assert.match(text, /sv-alpha  Alpha  custom · default · visible/);
  assert.doesNotMatch(text, /sv-beta/);

  const json = JSON.parse(await plugin.cliQueryList({ hidden: "true", format: "json" }));
  assert.deepEqual(json, [
    { id: "preset-week", name: "Week", builtin: true, hidden: false, default: false },
    { id: "sv-alpha", name: "Alpha", builtin: false, hidden: false, default: true },
    { id: "sv-beta", name: "Beta", builtin: false, hidden: true, default: false },
  ]);
});

test("query-show 返回当前 preset 的 DSL JSON", async () => {
  const { plugin } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { search: "deep work", tags: ["#alpha", "#beta"], status: ["todo", "done"], time: { scheduled: "week" } },
        view: { type: "month", preset: "today" },
        summary: [{ type: "count" }],
      },
    ],
  });

  const shown = JSON.parse(await plugin.cliQueryShow({ id: "sv-alpha" }));
  // US-109z2: presets carry no tab-level filters; DSL is identity + view only.
  assert.deepEqual(shown, {
    id: "sv-alpha",
    name: "Alpha",
    builtin: false,
    hidden: false,
    view: { layout: { type: "month" } },
  });
});

test("US-220: query-run 支持临时 view 覆盖输出", async () => {
  const { plugin } = await createPluginForQueryCli({
    weekStartsOn: 1,
    groupingTags: [],
    queryPresets: [
      {
        id: "preset-today",
        name: "Today",
        builtin: true,
        hidden: false,
        filters: { status: ["todo"] },
        view: { type: "list", preset: "today" },
        summary: [{ type: "count" }],
      },
    ],
  });
  plugin.api = {
    runQueryPreset: async (preset, opts) => ({
      preset,
      view: { ...preset.view, type: opts.view ?? preset.view.type },
      anchorISO: opts.anchorISO,
      filteredTasks: [],
      summary: [{ type: "count", value: 0 }],
      viewModel: {
        type: "week",
        days: ["2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-09", "2026-05-10"].map((date) => ({ date, tasks: [] })),
      },
    }),
  };

  const out = await plugin.cliQueryRun({ id: "preset-today", view: "week", anchor: "2026-05-04" });

  assert.match(out, /Query preset-today · Today/);
  assert.match(out, /view week · 0 tasks · anchor 2026-05-04/);
});

test("query-save 总是新建 preset id，而不是复用 DSL 里的 id", async () => {
  const { plugin, calls } = await createPluginForQueryCli();

  await withDeterministicSavedViewId(async () => {
    const result = await plugin.cliQuerySave({
      dsl: JSON.stringify({
        id: "sv-from-dsl",
        name: " Deep Work ",
        view: {
          layout: {
            type: "week",
            when: {
              search: " docs ",
              tags: ["alpha"],
              status: ["todo"],
            },
          },
        },
      }),
    });

    assert.match(result, /^ok  sv-/);
    assert.match(result, /saved query preset/);
  });

  assert.equal(plugin.settings.queryPresets.length, 1);
  const createdId = plugin.settings.queryPresets[0].id;
  assert.match(createdId, /^sv-[a-z0-9]+-4fzz$/);
  assert.equal(createdId === "sv-from-dsl", false);
  assert.equal(plugin.settings.queryPresets[0].name, "Deep Work");
  assert.equal(plugin.settings.queryPresets[0].filters, undefined);
  assert.deepEqual(plugin.settings.queryPresets[0].view, {
    layout: { type: "week", when: { search: "docs", tags: { expr: "#alpha" }, status: ["todo"] } },
  });
  assert.equal(calls.save, 1);
  assert.equal(calls.refresh, 1);
});

test("query-update 固定覆盖当前 id，不允许 DSL 偷换 preset 身份", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { search: "old", tags: ["#alpha"], status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  const result = await plugin.cliQueryUpdate({
    id: "sv-alpha",
    dsl: JSON.stringify({
      id: "sv-should-not-win",
      name: "Alpha Updated",
      view: {
        layout: {
          type: "month",
          when: {
            search: "new",
            tags: ["#beta"],
            status: ["done"],
            time: { completed: "month" },
          },
        },
      },
    }),
  });

  assert.match(result, /^ok  sv-alpha  Alpha Updated/);
  assert.deepEqual(plugin.settings.queryPresets, [
    {
      id: "sv-alpha",
      name: "Alpha Updated",
      builtin: false,
      hidden: false,
      view: { layout: { type: "month", when: { search: "new", tags: { expr: "#beta" }, status: ["done"], time: { completed: "month" } } } },
    },
  ]);
  assert.equal(calls.save, 1);
  assert.equal(calls.refresh, 1);
});

test("query-copy / hide / set-default / delete 维护 preset 生命周期与默认指针", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    defaultSavedViewId: "sv-alpha",
    lastSavedViewId: "sv-alpha",
    queryPresets: [
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { search: "focus", tags: ["#alpha"], status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  await withDeterministicSavedViewId(async () => {
    const copied = await plugin.cliQueryCopy({ id: "sv-alpha", name: "Alpha Copy" });
    assert.match(copied, /^ok  sv-[a-z0-9]+-4fzz  Alpha Copy/);
  });

  assert.equal(plugin.settings.queryPresets.length, 2);
  const copiedId = plugin.settings.queryPresets.find((view) => view.name === "Alpha Copy")?.id;
  assert.match(copiedId, /^sv-[a-z0-9]+-4fzz$/);

  const hidden = await plugin.cliQueryHide({ id: "sv-alpha", hidden: "true" });
  assert.match(hidden, /hidden query preset/);
  assert.equal(plugin.settings.defaultSavedViewId, null);
  assert.equal(plugin.settings.lastSavedViewId, null);
  assert.equal(plugin.settings.queryPresets.find((view) => view.id === "sv-alpha")?.hidden, true);

  await assert.rejects(
    () => plugin.cliQuerySetDefault({ id: "sv-alpha" }),
    /invalid_query/,
  );

  const setDefault = await plugin.cliQuerySetDefault({ id: copiedId });
  assert.match(setDefault, /set as default query preset/);
  assert.equal(plugin.settings.defaultSavedViewId, copiedId);

  const cleared = await plugin.cliQuerySetDefault({ id: "null" });
  assert.match(cleared, /default-query-preset/);
  assert.equal(plugin.settings.defaultSavedViewId, null);

  const deleted = await plugin.cliQueryDelete({ id: copiedId });
  assert.match(deleted, /deleted query preset/);
  assert.deepEqual(plugin.settings.queryPresets, [
    {
      id: "sv-alpha",
      name: "Alpha",
      builtin: false,
      hidden: true,
      view: { layout: { type: "list" } },
    },
  ]);
  assert.equal(calls.save, 5);
  assert.equal(calls.refresh, 3);
});

// ── CLI query-save / query-update negative tests ──
// VAL-CLI-006: invalid_query surfaced for legacy and invalid DSL;
// failed save/update leaves existing QueryPreset state unchanged.

test("query-save rejects legacy flat SavedTaskView DSL with invalid_query", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { search: "focus", tags: ["#alpha"], status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  const legacyDsl = JSON.stringify({
    name: "Legacy View",
    search: "docs",
    tag: "#work",
    time: { scheduled: "today" },
    status: "todo",
    view: { type: "list" },
  });

  await assert.rejects(
    () => plugin.cliQuerySave({ dsl: legacyDsl }),
    (err) => err.code === "invalid_query" && /更新 skill/.test(err.message) && /view\.layout/.test(err.message),
  );

  // Presets unchanged — no save/refresh side effects
  assert.equal(plugin.settings.queryPresets.length, 1);
  assert.equal(plugin.settings.queryPresets[0].id, "sv-alpha");
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

test("query-save rejects legacy flat DSL with only search field", async () => {
  const { plugin, calls } = await createPluginForQueryCli();

  const legacyDsl = JSON.stringify({
    name: "Search Only",
    search: "focus",
    view: { type: "list" },
  });

  await assert.rejects(
    () => plugin.cliQuerySave({ dsl: legacyDsl }),
    (err) => err.code === "invalid_query" && /更新 skill/.test(err.message) && /view\.layout/.test(err.message),
  );

  assert.equal(plugin.settings.queryPresets.length, 0);
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

test("query-save rejects legacy flat DSL with only status field", async () => {
  const { plugin, calls } = await createPluginForQueryCli();

  const legacyDsl = JSON.stringify({
    name: "Status Only",
    status: "done",
    view: { type: "list" },
  });

  await assert.rejects(
    () => plugin.cliQuerySave({ dsl: legacyDsl }),
    (err) => err.code === "invalid_query" && /更新 skill/.test(err.message) && /view\.layout/.test(err.message),
  );

  assert.equal(plugin.settings.queryPresets.length, 0);
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

test("query-save rejects invalid QueryPreset DSL (unknown view type) with invalid_query", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  const invalidDsl = JSON.stringify({
    name: "Bad View",
    view: { layout: { type: 42 } },
  });

  await assert.rejects(
    () => plugin.cliQuerySave({ dsl: invalidDsl }),
    (err) => err.code === "invalid_query" && /invalid_area_type/.test(err.message),
  );

  // Presets unchanged
  assert.equal(plugin.settings.queryPresets.length, 1);
  assert.equal(plugin.settings.queryPresets[0].id, "sv-alpha");
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

test("query-save rejects invalid QueryPreset DSL (non-object root) with invalid_query", async () => {
  const { plugin, calls } = await createPluginForQueryCli();

  await assert.rejects(
    () => plugin.cliQuerySave({ dsl: '"not an object"' }),
    (err) => err.code === "invalid_query",
  );

  assert.equal(plugin.settings.queryPresets.length, 0);
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

test("query-save rejects legacy DSL wrapped in query key with invalid_query", async () => {
  const { plugin, calls } = await createPluginForQueryCli();

  const wrappedLegacy = JSON.stringify({
    query: {
      name: "Wrapped Legacy",
      search: "docs",
      status: "todo",
      view: { type: "list" },
    },
  });

  await assert.rejects(
    () => plugin.cliQuerySave({ dsl: wrappedLegacy }),
    (err) => err.code === "invalid_query" && /更新 skill/.test(err.message) && /view\.layout/.test(err.message),
  );

  assert.equal(plugin.settings.queryPresets.length, 0);
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

test("query-update rejects legacy flat SavedTaskView DSL with invalid_query", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { search: "focus", tags: ["#alpha"], status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  const legacyDsl = JSON.stringify({
    name: "Legacy Update",
    search: "docs",
    tag: "#work",
    time: { scheduled: "today" },
    status: "done",
    view: { type: "week" },
  });

  await assert.rejects(
    () => plugin.cliQueryUpdate({ id: "sv-alpha", dsl: legacyDsl }),
    (err) => err.code === "invalid_query" && /更新 skill/.test(err.message) && /view\.layout/.test(err.message),
  );

  // Existing preset unchanged — no save/refresh
  assert.equal(plugin.settings.queryPresets.length, 1);
  assert.equal(plugin.settings.queryPresets[0].id, "sv-alpha");
  assert.equal(plugin.settings.queryPresets[0].name, "Alpha");
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

test("query-update rejects invalid QueryPreset DSL (unknown view type) with invalid_query", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { search: "focus", tags: ["#alpha"], status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  const invalidDsl = JSON.stringify({
    name: "Bad View",
    view: { layout: { type: 42 } },
  });

  await assert.rejects(
    () => plugin.cliQueryUpdate({ id: "sv-alpha", dsl: invalidDsl }),
    (err) => err.code === "invalid_query" && /invalid_area_type/.test(err.message),
  );

  // Existing preset unchanged
  assert.equal(plugin.settings.queryPresets.length, 1);
  assert.equal(plugin.settings.queryPresets[0].id, "sv-alpha");
  assert.equal(plugin.settings.queryPresets[0].name, "Alpha");
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

test("US-219: query-update without name preserves the existing name", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  const invalidDsl = JSON.stringify({
    view: { layout: { type: "list" } },
  });

  await plugin.cliQueryUpdate({ id: "sv-alpha", dsl: invalidDsl });
  assert.equal(plugin.settings.queryPresets[0].name, "Alpha");

  // Identity and name preserved; layout is updated.
  assert.equal(plugin.settings.queryPresets.length, 1);
  assert.equal(plugin.settings.queryPresets[0].id, "sv-alpha");
  assert.equal(calls.save, 1);
  assert.equal(calls.refresh, 1);
});

test("query-update rejects invalid QueryPreset DSL (multi-section errors) with invalid_query", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  const invalidDsl = JSON.stringify({
    name: "Multi Bad",
    view: { layout: { dir: "diagonal", children: [] } },
  });

  let caught = null;
  try {
    await plugin.cliQueryUpdate({ id: "sv-alpha", dsl: invalidDsl });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, "Should throw");
  assert.equal(caught.code, "invalid_query");
  // Error message should surface the failing sections
  assert.match(caught.message, /view/);
  assert.match(caught.message, /invalid_stack_dir/);
  assert.match(caught.message, /invalid_stack_children/);

  // Existing preset unchanged
  assert.equal(plugin.settings.queryPresets.length, 1);
  assert.equal(plugin.settings.queryPresets[0].id, "sv-alpha");
  assert.equal(plugin.settings.queryPresets[0].name, "Alpha");
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

test("query-update: non-existent preset id throws query_not_found, leaves settings untouched", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  const validDsl = JSON.stringify({
    name: "Valid Update",
    filters: { status: ["done"] },
    view: { type: "list" },
    summary: [],
  });

  await assert.rejects(
    () => plugin.cliQueryUpdate({ id: "sv-nonexistent", dsl: validDsl }),
    (err) => err.code === "query_not_found",
  );

  // Existing preset unchanged
  assert.equal(plugin.settings.queryPresets.length, 1);
  assert.equal(plugin.settings.queryPresets[0].id, "sv-alpha");
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

// ── End CLI query-save / query-update negative tests ──

// ── CLI query-create ──
// VAL-CLI-006: query-create is an alias that reuses query-save implementation
// (stable id, invalid_query rejection, does not overwrite existing presets).

test("query-create 创建新 preset，输出稳定 id，且不覆盖已有 preset", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-existing",
        name: "Existing",
        builtin: false,
        hidden: false,
        filters: { status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  await withDeterministicSavedViewId(async () => {
    const result = await plugin.cliQuerySave({
      dsl: JSON.stringify({
        name: " New via Create ",
        view: {
          layout: {
            type: "week",
            when: {
              search: " focus ",
              tags: ["#work"],
              status: ["todo"],
            },
          },
        },
      }),
    });

    assert.match(result, /^ok  sv-/);
    assert.match(result, /saved query preset/);
    assert.match(result, /New via Create/);
  });

  // Existing preset unchanged
  assert.equal(plugin.settings.queryPresets.length, 2);
  assert.equal(plugin.settings.queryPresets[0].id, "sv-existing");
  assert.equal(plugin.settings.queryPresets[0].name, "Existing");

  // New preset created with stable id
  const created = plugin.settings.queryPresets[1];
  assert.match(created.id, /^sv-[a-z0-9]+-4fzz$/);
  assert.equal(created.name, "New via Create");
  assert.equal(created.filters, undefined);
  assert.deepEqual(created.view, { layout: { type: "week", when: { search: "focus", tags: { expr: "#work" }, status: ["todo"] } } });
  assert.equal(calls.save, 1);
  assert.equal(calls.refresh, 1);
});

test("query-create rejects legacy flat SavedTaskView DSL with invalid_query, leaves state unchanged", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-alpha",
        name: "Alpha",
        builtin: false,
        hidden: false,
        filters: { search: "focus", tags: ["#alpha"], status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  const legacyDsl = JSON.stringify({
    name: "Legacy via Create",
    search: "docs",
    tag: "#work",
    time: { scheduled: "today" },
    status: "todo",
    view: { type: "list" },
  });

  await assert.rejects(
    () => plugin.cliQuerySave({ dsl: legacyDsl }),
    (err) => err.code === "invalid_query" && /更新 skill/.test(err.message) && /view\.layout/.test(err.message),
  );

  // Presets unchanged — no save/refresh side effects
  assert.equal(plugin.settings.queryPresets.length, 1);
  assert.equal(plugin.settings.queryPresets[0].id, "sv-alpha");
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

test("query-create rejects invalid QueryPreset DSL (unknown view type) with invalid_query", async () => {
  const { plugin, calls } = await createPluginForQueryCli();

  const invalidDsl = JSON.stringify({
    name: "Bad View",
    view: { layout: { type: 42 } },
  });

  await assert.rejects(
    () => plugin.cliQuerySave({ dsl: invalidDsl }),
    (err) => err.code === "invalid_query" && /invalid_area_type/.test(err.message),
  );

  assert.equal(plugin.settings.queryPresets.length, 0);
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

test("query-create rejects invalid QueryPreset DSL (non-object root) with invalid_query", async () => {
  const { plugin, calls } = await createPluginForQueryCli();

  await assert.rejects(
    () => plugin.cliQuerySave({ dsl: '"not an object"' }),
    (err) => err.code === "invalid_query",
  );

  assert.equal(plugin.settings.queryPresets.length, 0);
  assert.equal(calls.save, 0);
  assert.equal(calls.refresh, 0);
});

// ── End CLI query-create tests ──

const EXPECTED_CLI_HANDLERS = [
  "task-center",
  "task-center:list",
  "task-center:show",
  "task-center:stats",
  "task-center:brief",
  "task-center:review",
  "task-center:schedule",
  "task-center:deadline",
  "task-center:actual",
  "task-center:estimate",
  "task-center:done",
  "task-center:undone",
  "task-center:abandon",
  "task-center:drop",
  "task-center:add",
  "task-center:tag",
  "task-center:nest",
  "task-center:rename",
  "task-center:query-list",
  "task-center:query-show",
  "task-center:query-run",
  "task-center:query-save",
  "task-center:query-create",
  "task-center:query-update",
  "task-center:query-rename",
  "task-center:query-copy",
  "task-center:query-hide",
  "task-center:query-delete",
  "task-center:query-set-default",
];

// Verify the full CLI surface is registered in Obsidian native CLI handlers.
test("plugin onload registers the full Task Center CLI surface", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}-${Math.random()}`);
  const app = makeAppWithExistingTaskCenterView();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);
  await plugin.onload();

  assert.deepEqual([...app.__cliHandlers.keys()].sort(), [...EXPECTED_CLI_HANDLERS].sort());
  for (const command of EXPECTED_CLI_HANDLERS) {
    const handler = app.__cliHandlers.get(command);
    assert.ok(handler, `${command} handler should exist`);
    assert.equal(typeof handler.handler, "function", `${command} handler should be a function`);
  }
});

test("task-center root CLI handler prints help with AI skill install command", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}-${Math.random()}`);
  const app = makeAppWithExistingTaskCenterView();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);
  await plugin.onload();

  const help = await app.__cliHandlers.get("task-center").handler({});
  assert.match(help, /Task Center CLI/);
  assert.match(help, /task-center:query-list/);
  assert.match(help, /task-center:query-set-default/);
  assert.match(help, /npx skills add CorrectRoadH\/obsidian-task-center/);
});

// VAL-CLI-006: builtins cannot be permanently deleted via CLI
// US-109l: builtins are now deletable; deleting one tombstones its id so it is
// not re-seeded on next load (recoverable via 「恢复预设 Tabs」).
test("query-delete 删除内置 preset 并把 id 记入 deletedBuiltinIds 墓碑", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "preset-today",
        name: "今日",
        builtin: true,
        hidden: false,
        filters: { status: ["todo"], time: { scheduled: "today" } },
        view: { type: "list", preset: "today" },
        summary: [],
      },
      {
        id: "sv-custom",
        name: "Custom",
        builtin: false,
        hidden: false,
        filters: { search: "docs", status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  const result = await plugin.cliQueryDelete({ id: "preset-today" });
  assert.match(result, /^ok  preset-today  今日/);
  assert.match(result, /deleted query preset/);

  // Builtin preset removed and tombstoned; custom preset untouched.
  assert.equal(plugin.settings.queryPresets.length, 1);
  assert.equal(plugin.settings.queryPresets.find((v) => v.id === "preset-today"), undefined);
  assert.deepEqual(plugin.settings.deletedBuiltinIds, ["preset-today"]);
  assert.equal(calls.save, 1);
  assert.equal(calls.refresh, 1);
});

test("query-delete 允许删除非内置的自定义 preset", async () => {
  const { plugin, calls } = await createPluginForQueryCli({
    queryPresets: [
      {
        id: "sv-custom",
        name: "Custom",
        builtin: false,
        hidden: false,
        filters: { search: "docs", status: ["todo"] },
        view: { type: "list" },
        summary: [],
      },
    ],
  });

  const result = await plugin.cliQueryDelete({ id: "sv-custom" });
  assert.match(result, /^ok  sv-custom  Custom/);
  assert.match(result, /deleted query preset/);
  assert.equal(plugin.settings.queryPresets.length, 0);
  assert.equal(calls.save, 1);
  assert.equal(calls.refresh, 1);
});

// ── End CLI query-delete builtin protection tests ──

test("openManageTabs 会激活 Task Center 并打开主界面的 Tabs 管理器", async () => {
  await compile();
  const { default: TaskCenterPlugin } = await import(`../${compiledPath}?t=${Date.now()}-${Math.random()}`);
  const app = makeAppWithExistingTaskCenterView();
  app.__viewCreators.clear();
  const plugin = new TaskCenterPlugin(app);
  await plugin.onload();

  const leaf = {};
  const creator = app.__viewCreators.get("task-center-board");
  leaf.view = creator(leaf);
  app.workspace.getLeavesOfType = () => [leaf];

  await plugin.openManageTabs();

  assert.equal(leaf.view.__openManageTabsCalls, 1);
});
