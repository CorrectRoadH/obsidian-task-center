/**
 * US-701d/e/f: Dependency health check — Tasks community plugin
 *
 * The plugin integrates with the Obsidian Tasks community plugin for task
 * parsing compatibility. When Tasks is not installed or is disabled, the
 * current code continues silently without telling the user their Tasks-format
 * data may not display correctly. US-701d/e adds a status-bar warning.
 *
 * Detection logic (expected from implementation):
 *   - app.plugins.manifests["obsidian-tasks"] absent → "tasks-missing"
 *   - manifests present but app.plugins.plugins["obsidian-tasks"] absent → "tasks-disabled"
 *   - app.plugins.plugins["obsidian-tasks"] present → healthy (no warning)
 *
 * Stable DOM attributes:
 *   data-dep-warning="tasks-missing"   — Tasks plugin not installed
 *   data-dep-warning="tasks-disabled"  — Tasks plugin installed but disabled
 *
 * All tests currently FAIL — no such warning element is rendered yet.
 * This is the Rally-first red commit for task #71.
 */
import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const VAULT = "test/e2e/vaults/simple";

async function forFlush() {
  await browser.executeObsidian(async ({ app }) => {
    // @ts-expect-error — runtime plugin
    await (app as any).plugins.plugins["obsidian-task-center"].__forFlush();
  });
}

/** Remove any fake Tasks manifest/plugin injected by tests. */
async function cleanupFakeTasks() {
  await browser.executeObsidian(async ({ app }) => {
    const p = (app as any).plugins;
    delete p.manifests["obsidian-tasks"];
    delete p.plugins["obsidian-tasks"];
  });
}

/** Simulate Tasks plugin installed but disabled: manifest exists, plugin not loaded. */
async function fakeInstallTasksDisabled() {
  await browser.executeObsidian(async ({ app }) => {
    const p = (app as any).plugins;
    p.manifests["obsidian-tasks"] = {
      id: "obsidian-tasks",
      name: "Tasks",
      version: "999.0.0",
      minAppVersion: "1.0.0",
    };
    delete p.plugins["obsidian-tasks"];
  });
}

/** Simulate Tasks plugin installed and enabled: both manifest and loaded plugin present. */
async function fakeEnableTasks() {
  await browser.executeObsidian(async ({ app }) => {
    const p = (app as any).plugins;
    p.manifests["obsidian-tasks"] = {
      id: "obsidian-tasks",
      name: "Tasks",
      version: "999.0.0",
      minAppVersion: "1.0.0",
    };
    p.plugins["obsidian-tasks"] = { _enabled: true };
  });
}

describe("US-701d/e/f dependency health check (Tasks plugin)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  afterEach(async function () {
    await cleanupFakeTasks();
  });

  // US-701d: Tasks plugin not installed → status bar must warn.
  //
  // In the test vault the Tasks community plugin is not installed, so
  // app.plugins.manifests["obsidian-tasks"] is absent by default.
  // FAIL until: plugin emits data-dep-warning="tasks-missing".
  it("US-701d: shows tasks-missing warning when Tasks plugin is not installed", async function () {
    await cleanupFakeTasks(); // ensure no manifest

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    // Board must still open (plugin must not crash).
    await expect($(".task-center-view")).toExist();

    // BUG: no warning element is rendered — assertion FAILS.
    await expect($('[data-dep-warning="tasks-missing"]')).toExist();
  });

  // US-701e: Tasks plugin installed but disabled → status bar must warn.
  //
  // FAIL until: plugin checks manifests vs plugins and emits
  // data-dep-warning="tasks-disabled".
  it("US-701e: shows tasks-disabled warning when Tasks plugin is installed but disabled", async function () {
    await fakeInstallTasksDisabled();

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await expect($(".task-center-view")).toExist();

    // BUG: no warning element is rendered — assertion FAILS.
    await expect($('[data-dep-warning="tasks-disabled"]')).toExist();
  });

  // US-701f: Tasks plugin enabled → no tasks-related warning must appear.
  //
  // This guards against false positives (always-visible warnings).
  // FAIL until the feature lands (tasks-missing is always shown right now).
  it("US-701f: no tasks warning when Tasks plugin is enabled", async function () {
    await fakeEnableTasks();

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await expect($(".task-center-view")).toExist();

    // No tasks-* warning must appear when Tasks is loaded.
    await expect($('[data-dep-warning="tasks-missing"]')).not.toExist();
    await expect($('[data-dep-warning="tasks-disabled"]')).not.toExist();
  });
});
