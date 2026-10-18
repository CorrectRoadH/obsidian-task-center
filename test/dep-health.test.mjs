// Unit tests for dependency-health pure checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compileDepHealth() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/dep-health.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outfile=test/.compiled/dep-health.bundle.js",
      "--loader:.ts=ts",
      "--alias:obsidian=./test/obsidian-stub.mjs",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild compile failed:\n" + result.stderr);
  }
}

compileDepHealth();
const { checkTaskFormatCompanion } = await import("../test/.compiled/dep-health.bundle.js");

function appWith({ manifests = {}, plugins = {} } = {}) {
  return { plugins: { manifests, plugins } };
}

test("US-701f: task-format companion is healthy when Tasks is enabled", () => {
  const app = appWith({ plugins: { "obsidian-tasks-plugin": {} } });
  assert.equal(checkTaskFormatCompanion(app), null);
});

test("US-701f: task-format companion is healthy when Dataview is enabled", () => {
  const app = appWith({ plugins: { dataview: {} } });
  assert.equal(checkTaskFormatCompanion(app), null);
});

test("US-701e: installed but disabled companion reports disabled", () => {
  const app = appWith({ manifests: { dataview: {} } });
  assert.equal(checkTaskFormatCompanion(app), "task-format-companion-disabled");
});

test("US-701d: no Tasks or Dataview companion reports missing", () => {
  assert.equal(checkTaskFormatCompanion(appWith()), "task-format-companion-missing");
});

test("US-701d/e/f: warning opens community plugins, self-refreshes and releases its timer", async () => {
  const { DepHealthBanner } = await import("../test/.compiled/dep-health.bundle.js");
  class Element extends EventTarget {
    children = []; dataset = {};
    addClass() {} setText(text) { this.text = text; }
    empty() { this.children = []; }
    createEl() { const child = new Element(); this.children.push(child); return child; }
    createDiv() { return this.createEl(); }
  }
  let tick; let released = false; let opened = false; let tab;
  const originalWindow = globalThis.window;
  globalThis.window = { setInterval: cb => { tick = cb; return 123; }, clearInterval: id => { released = id === 123; } };
  try {
    const app = appWith();
    app.internalPlugins = { plugins: { "daily-notes": { enabled: true, instance: { options: { folder: "Daily" } } } } };
    app.setting = { open: () => { opened = true; }, openTabById: id => { tab = id; } };
    const el = new Element();
    const banner = new DepHealthBanner(el, app, { onClick: () => {} });
    el.children[0].dispatchEvent(new Event("click"));
    assert.equal(opened, true);
    assert.equal(tab, "community-plugins");
    app.plugins.plugins.dataview = {};
    tick();
    assert.equal(el.children.length, 0);
    banner.dispose();
    assert.equal(released, true);
  } finally { globalThis.window = originalWindow; }
});
