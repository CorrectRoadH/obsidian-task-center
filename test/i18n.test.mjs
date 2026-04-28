// Unit tests for i18n locale handling — task #34 US-408 + US-412.
//
// Run with: `node --test test/i18n.test.mjs`

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Provide a controllable window/localStorage shim so the compiled i18n
// bundle's `detectLocale()` (which reads window.localStorage.language)
// has something to read in Node. Tests mutate `mockStorage` to simulate
// the user changing Obsidian's UI language mid-session.
const mockStorage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (mockStorage.has(k) ? mockStorage.get(k) : null),
    setItem: (k, v) => mockStorage.set(k, v),
    removeItem: (k) => mockStorage.delete(k),
  },
};

before(() => {
  const r = spawnSync(
    "npx",
    [
      "esbuild",
      "src/i18n.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outfile=test/.compiled/i18n.bundle.js",
      "--alias:obsidian=./test/obsidian-stub.mjs",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error("esbuild failed:\n" + r.stderr);
});

// US-408: live language switch — when the user changes Obsidian's UI
// language mid-session (Settings → About → Language), the next `t()`
// call must reflect the new locale without restarting the plugin.
//
// Currently `const locale = detectLocale()` runs ONCE at module load,
// so the test below FAILS — t() returns the locale from import time
// even though localStorage["language"] changed.
test("US-408 — t() reflects current localStorage language (live switch)", async () => {
  mockStorage.clear();
  mockStorage.set("language", "zh");
  const mod = await import(
    `../test/.compiled/i18n.bundle.js?cachebust=${Date.now()}`
  );
  // First call: zh → "本周"
  assert.equal(mod.t("tab.week"), "本周");

  // Switch to English mid-session.
  mockStorage.set("language", "en");
  // Currently FAILS: returns "本周" because locale was captured at import.
  // After fix: returns "Week".
  assert.equal(mod.t("tab.week"), "Week");
});

// US-412: error messages must go through the i18n layer so non-English
// users see them in their language (currently throw new TaskWriterError(
// "code", "english literal") bypasses tr()).
//
// Test asserts a known error key exists in both EN and ZH tables. The
// downstream writer/cli refactor is covered by GREEN commit + integration.
test("US-412 — err.task_not_found key exists in both EN and ZH tables", async () => {
  mockStorage.clear();
  mockStorage.set("language", "en");
  const en = await import(
    `../test/.compiled/i18n.bundle.js?cachebust=${Date.now()}_en`
  );
  // Currently FAILS: err.task_not_found doesn't exist as a key — the
  // error message is hard-coded in writer.ts/cli.ts.
  // After fix: the key resolves to an English template.
  const enMsg = en.t("err.task_not_found", { ref: "x:L1" });
  assert.notEqual(enMsg, "err.task_not_found", "EN err key must be defined");
  assert.match(enMsg, /x:L1/);

  mockStorage.set("language", "zh");
  const zh = await import(
    `../test/.compiled/i18n.bundle.js?cachebust=${Date.now()}_zh`
  );
  const zhMsg = zh.t("err.task_not_found", { ref: "x:L1" });
  assert.notEqual(zhMsg, "err.task_not_found", "ZH err key must be defined");
  assert.match(zhMsg, /x:L1/);
  // Must differ from EN (i.e., actually translated).
  assert.notEqual(zhMsg, enMsg);
});

// task #43 (US-402): the persistent status bar text, mobile mirrored
// status row, est/act metadata badges, mobile long-press action sheet,
// and date prompt hint were all hard-coded English literals. In a
// Chinese Obsidian session they leaked through unchanged. This test
// asserts every replacement i18n key exists in both EN and ZH tables;
// the green commit then routes the call sites through `tr()`.
//
// Coverage mirrors the categories reviewer called out:
//   - status.today / status.overdue / status.openTooltip
//     → status-bar.ts + view.ts:renderMobileStatusRow (shared keys)
//   - meta.est / meta.act        → view.ts est/act badges
//   - sheet.markUndone / sheet.done / sheet.scheduleAt /
//     sheet.scheduleClear / sheet.drop
//                                 → view.ts:openCardActionSheet
//   - prompt.dateHint            → dateprompt.ts
test("task #43 — status / meta / sheet / prompt keys defined for EN and ZH (translated where text-bearing)", async () => {
  const keys = [
    { key: "status.today", vars: { n: 3 }, mustDifferFromEnInZh: true },
    { key: "status.overdue", vars: { n: 2 }, mustDifferFromEnInZh: true },
    { key: "status.openTooltip", vars: undefined, mustDifferFromEnInZh: true },
    { key: "meta.est", vars: { dur: "30m" }, mustDifferFromEnInZh: true },
    { key: "meta.act", vars: { dur: "25m" }, mustDifferFromEnInZh: true },
    { key: "sheet.markUndone", vars: undefined, mustDifferFromEnInZh: true },
    { key: "sheet.done", vars: undefined, mustDifferFromEnInZh: true },
    { key: "sheet.scheduleAt", vars: { date: "2026-04-26" }, mustDifferFromEnInZh: false },
    { key: "sheet.scheduleClear", vars: undefined, mustDifferFromEnInZh: false },
    { key: "sheet.drop", vars: undefined, mustDifferFromEnInZh: true },
    { key: "prompt.dateHint", vars: undefined, mustDifferFromEnInZh: true },
    // PM HOLD on first review (msg `cbf0489c`): Completed tab's
    // 7-day stats header was the third Completed surface and was
    // initially missed.
    { key: "stats.sevenDayDone", vars: { n: 5 }, mustDifferFromEnInZh: true },
    { key: "stats.ratio", vars: { ratio: "1.05", sign: "+", delta: 5 }, mustDifferFromEnInZh: true },
  ];

  mockStorage.clear();
  mockStorage.set("language", "en");
  const en = await import(
    `../test/.compiled/i18n.bundle.js?cachebust=${Date.now()}_t43_en`
  );
  mockStorage.set("language", "zh");
  const zh = await import(
    `../test/.compiled/i18n.bundle.js?cachebust=${Date.now()}_t43_zh`
  );

  for (const { key, vars, mustDifferFromEnInZh } of keys) {
    mockStorage.set("language", "en");
    const enMsg = en.t(key, vars);
    assert.notEqual(enMsg, key, `EN table missing key: ${key}`);

    mockStorage.set("language", "zh");
    const zhMsg = zh.t(key, vars);
    assert.notEqual(zhMsg, key, `ZH table missing key: ${key}`);

    if (mustDifferFromEnInZh) {
      assert.notEqual(
        zhMsg,
        enMsg,
        `ZH translation for ${key} should differ from EN ("${enMsg}")`,
      );
    }
  }
});

// task #108: toolbar / Today / saved-view controls are a high-risk i18n
// surface because they sit in the first viewport. Keep the assertion at the
// i18n layer so it can run in unit tests without launching Obsidian.
test("task #108 — toolbar, Today, and saved-view control labels are localized", async () => {
  const keys = [
    { key: "toolbar.add", vars: undefined, mustDifferFromEnInZh: true },
    { key: "toolbar.filter", vars: undefined, mustDifferFromEnInZh: true },
    { key: "filters.empty", vars: undefined, mustDifferFromEnInZh: true },
    { key: "filters.clear", vars: undefined, mustDifferFromEnInZh: true },
    { key: "today.groupOverdue", vars: undefined, mustDifferFromEnInZh: true },
    { key: "today.groupToday", vars: undefined, mustDifferFromEnInZh: true },
    { key: "today.groupRec", vars: undefined, mustDifferFromEnInZh: true },
    { key: "today.groupEmpty", vars: undefined, mustDifferFromEnInZh: true },
    { key: "today.actionDone", vars: undefined, mustDifferFromEnInZh: true },
    { key: "today.actionReschedule", vars: undefined, mustDifferFromEnInZh: true },
    { key: "today.actionDrop", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.current", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.tag", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.timeScheduled", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.timeDeadline", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.timeCompleted", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.timeCreated", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.timeMore", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.statusAll", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.statusAny", vars: undefined, mustDifferFromEnInZh: true },
    { key: "settings.skillInstall.name", vars: undefined, mustDifferFromEnInZh: false },
    { key: "settings.skillInstall.desc", vars: undefined, mustDifferFromEnInZh: true },
    { key: "settings.copy", vars: undefined, mustDifferFromEnInZh: true },
    { key: "settings.copied", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.save", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.update", vars: undefined, mustDifferFromEnInZh: true },
    { key: "savedViews.saveDisabled", vars: undefined, mustDifferFromEnInZh: true },
  ];

  mockStorage.clear();
  mockStorage.set("language", "en");
  const en = await import(
    `../test/.compiled/i18n.bundle.js?cachebust=${Date.now()}_t108_en`
  );
  mockStorage.set("language", "zh");
  const zh = await import(
    `../test/.compiled/i18n.bundle.js?cachebust=${Date.now()}_t108_zh`
  );

  for (const { key, vars, mustDifferFromEnInZh } of keys) {
    mockStorage.set("language", "en");
    const enMsg = en.t(key, vars);
    assert.notEqual(enMsg, key, `EN table missing key: ${key}`);

    mockStorage.set("language", "zh");
    const zhMsg = zh.t(key, vars);
    assert.notEqual(zhMsg, key, `ZH table missing key: ${key}`);
    if (mustDifferFromEnInZh) {
      assert.notEqual(
        zhMsg,
        enMsg,
        `ZH translation for ${key} should differ from EN ("${enMsg}")`,
      );
    }
  }
});
