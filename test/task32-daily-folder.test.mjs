// task #32 red tests (US-32) — 0.3.0 breaking removal of settings.dailyFolder.
//
// These tests FAIL on current main (dailyFolder still in DEFAULT_SETTINGS /
// i18n tables) and PASS after Wood's green commit removes the field.
//
// Predicted failing test names:
//   "US-32: DEFAULT_SETTINGS must not expose dailyFolder"
//   "US-32: DEFAULT_SETTINGS keys must not include dailyFolder"
//   "US-32: i18n EN table must not contain settings.dailyFolder keys"
//   "US-32: i18n ZH table must not contain settings.dailyFolder keys"
//
// Why the tests are designed this way (per Jerry red commit requirements):
//   - DEFAULT_SETTINGS tests → verify the TypeScript interface and runtime
//     constant no longer carry the field; this is the single ground-truth
//     that all call-sites depend on.
//   - i18n tests → settings UI can only be removed cleanly if the i18n keys
//     driving its label/description are also gone; leaving dead i18n keys
//     is a half-removal (Wood's green commit checklist includes both).
//   - Root of predicted failure: src/types.ts:L46 `dailyFolder: string` and
//     L73 `dailyFolder: "Daily"` still present; src/i18n.ts still has
//     `settings.dailyFolder.name` / `settings.dailyFolder.desc` in EN+ZH.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// ─── compile helpers ─────────────────────────────────────────────────────────

function esbuild(entry, outfile) {
  const r = spawnSync(
    "npx",
    [
      "esbuild",
      entry,
      "--bundle",
      "--format=esm",
      "--platform=node",
      `--outfile=${outfile}`,
      "--alias:obsidian=./test/obsidian-stub.mjs",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`esbuild failed for ${entry}:\n${r.stderr}`);
}

const mockStorage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (mockStorage.has(k) ? mockStorage.get(k) : null),
    setItem: (k, v) => mockStorage.set(k, v),
    removeItem: (k) => mockStorage.delete(k),
  },
};

before(() => {
  esbuild("src/types.ts", "test/.compiled/types.bundle.js");
  esbuild("src/i18n.ts", "test/.compiled/i18n.bundle.js");
});

// ─── DEFAULT_SETTINGS tests ───────────────────────────────────────────────────

test("US-32: DEFAULT_SETTINGS must not expose dailyFolder — write path SSOT is Obsidian daily-notes plugin, not a local folder setting", async () => {
  // Predicted failure: DEFAULT_SETTINGS.dailyFolder === "Daily"
  // Root: src/types.ts L46 + L73 still declare the field.
  // Fix (green): delete dailyFolder from TaskCenterSettings interface and DEFAULT_SETTINGS object.
  const mod = await import(
    `../test/.compiled/types.bundle.js?cachebust=${Date.now()}_t32_ds1`
  );
  assert.ok(
    !("dailyFolder" in mod.DEFAULT_SETTINGS),
    `DEFAULT_SETTINGS.dailyFolder still present (value="${mod.DEFAULT_SETTINGS.dailyFolder}"). ` +
      "Task #32 removes this field: write target is now determined solely by Obsidian's " +
      "built-in Daily Notes plugin config (or falls back to settings.inboxPath if disabled).",
  );
});

test("US-32: DEFAULT_SETTINGS keys must not include dailyFolder", async () => {
  // Belt-and-suspenders: also check Object.keys() so we catch the case where
  // the value is present but set to undefined (which `"in"` would still catch,
  // but explicit key check makes the failure message clearer).
  const mod = await import(
    `../test/.compiled/types.bundle.js?cachebust=${Date.now()}_t32_ds2`
  );
  const keys = Object.keys(mod.DEFAULT_SETTINGS);
  assert.ok(
    !keys.includes("dailyFolder"),
    `dailyFolder still in DEFAULT_SETTINGS keys: [${keys.join(", ")}]`,
  );
});

// ─── i18n key removal tests ───────────────────────────────────────────────────
//
// t() returns the key string itself as fallback when the key is not defined.
// So: t("settings.dailyFolder.name") === "settings.dailyFolder.name" means the key is GONE.
//     t("settings.dailyFolder.name") !== "settings.dailyFolder.name" means the key STILL EXISTS.
// assert.equal(t(key), key) → FAILS now (key exists → translated string returned)
//                           → PASSES after green (key removed → fallback = key string)

test("US-32: i18n EN table must not contain settings.dailyFolder keys — dead i18n keys must be removed with the UI", async () => {
  // Predicted failure: EN["settings.dailyFolder.name"] and
  //                    EN["settings.dailyFolder.desc"] still exist.
  // Root: src/i18n.ts L148-L150 still has both EN entries.
  // Fix (green): delete those 2 lines from the EN table.
  mockStorage.set("language", "en");
  const mod = await import(
    `../test/.compiled/i18n.bundle.js?cachebust=${Date.now()}_t32_en`
  );
  for (const key of ["settings.dailyFolder.name", "settings.dailyFolder.desc"]) {
    assert.equal(
      mod.t(key),
      key,
      `EN i18n table still contains removed-in-0.3.0 key: "${key}". ` +
        "Delete this from src/i18n.ts along with the settings UI block.",
    );
  }
});

test("US-32: i18n ZH table must not contain settings.dailyFolder keys — dead i18n keys must be removed with the UI", async () => {
  // Predicted failure: ZH["settings.dailyFolder.name"] and
  //                    ZH["settings.dailyFolder.desc"] still exist.
  // Root: src/i18n.ts ZH table still has both ZH entries.
  mockStorage.set("language", "zh");
  const mod = await import(
    `../test/.compiled/i18n.bundle.js?cachebust=${Date.now()}_t32_zh`
  );
  for (const key of ["settings.dailyFolder.name", "settings.dailyFolder.desc"]) {
    assert.equal(
      mod.t(key),
      key,
      `ZH i18n table still contains removed-in-0.3.0 key: "${key}". ` +
        "Delete this from src/i18n.ts along with the settings UI block.",
    );
  }
});

// ─── migration note test ──────────────────────────────────────────────────────

test("US-32: README must document the 0.3.0 breaking change with migration guide for dailyFolder removal", async () => {
  // Predicted failure: README.md has no 0.3.0 breaking change section for dailyFolder.
  // Root: migration note has not been written yet.
  // Fix (green): Wood/Jerry adds a 0.3.0 breaking change section to README.md with
  //   - "settings.dailyFolder" (the removed setting name)
  //   - "Daily Notes" (the replacement SSOT)
  //   - "Breaking" or "Migration" heading
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync("README.md", "utf8");
  const hasBreaking = /Breaking|Migration/i.test(readme) && readme.includes("settings.dailyFolder") && readme.includes("Daily Notes");
  assert.ok(
    hasBreaking,
    "README.md must contain a 0.3.0 breaking change / migration section that mentions " +
      "settings.dailyFolder, Daily Notes, and Breaking/Migration. " +
      "Add a ## Breaking Changes or ## Migration section describing the dailyFolder removal.",
  );
});
