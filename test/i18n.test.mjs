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
