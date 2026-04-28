/**
 * US-701: Dependency health check — Daily Notes plugin
 *
 * The plugin relies on Obsidian's built-in Daily Notes plugin to determine
 * the write target for Quick Add. When Daily Notes is disabled or has no
 * folder configured, the current code silently falls back to inbox with no
 * user-visible indication (the "silent fallback" bug US-701 fixes).
 *
 * Acceptance criteria (US-701a/b):
 *   - Status bar (or persistent element) must show an actionable warning
 *     when Daily Notes is disabled or unconfigured.
 *   - Warning element must carry data-dep-warning="daily-notes-disabled" or
 *     data-dep-warning="daily-notes-no-folder" so tests can assert it.
 *   - Warning must NOT appear when Daily Notes is enabled and configured.
 *
 * These tests currently FAIL because no such warning element is rendered —
 * the plugin silently falls back to inbox without surfacing anything.
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

/** Disable the built-in Daily Notes plugin and return its prior enabled state. */
async function disableDailyNotes(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const dn = (app as any).internalPlugins?.plugins?.["daily-notes"];
    if (dn?.enabled) await dn.disable();
  });
}

/** Re-enable the built-in Daily Notes plugin. */
async function enableDailyNotes(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const dn = (app as any).internalPlugins?.plugins?.["daily-notes"];
    if (!dn?.enabled) await dn.enable();
  });
}

async function configureDailyNotesFolder(folder = "Daily"): Promise<void> {
  await browser.executeObsidian(async ({ app }, folder) => {
    const dn = (app as any).internalPlugins?.plugins?.["daily-notes"];
    if (!dn?.enabled) await dn?.enable?.();
    if (dn?.instance?.options) {
      dn.instance.options.folder = folder;
    }
  }, folder);
}

async function fakeEnableTasks(): Promise<void> {
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

async function cleanupFakeTasks(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const p = (app as any).plugins;
    delete p.manifests["obsidian-tasks"];
    delete p.plugins["obsidian-tasks"];
  });
}

describe("US-701 dependency health check (Daily Notes)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  afterEach(async function () {
    // Always restore Daily Notes so we don't bleed state into other specs.
    await enableDailyNotes();
    await cleanupFakeTasks();
  });

  // US-701a: Daily Notes disabled → status bar must warn the user.
  //
  // FAIL until: the plugin emits a DOM element with
  // data-dep-warning="daily-notes-disabled" when Daily Notes is disabled.
  it("US-701a: shows warning in status bar when Daily Notes plugin is disabled", async function () {
    await disableDailyNotes();

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    // Board must still open (plugin must not crash).
    await expect($(".task-center-view")).toExist();

    // BUG: currently no warning element is rendered — assertion FAILS.
    await expect(
      $('[data-dep-warning="daily-notes-disabled"]'),
    ).toExist();
  });

  // US-701b: Daily Notes enabled but folder not configured → must warn.
  //
  // FAIL until: plugin checks options.folder and emits a DOM element with
  // data-dep-warning="daily-notes-no-folder".
  it("US-701b: shows warning when Daily Notes folder is not configured", async function () {
    // Clear the Daily Notes folder setting (simulate unconfigured state).
    await browser.executeObsidian(async ({ app }) => {
      const dn = (app as any).internalPlugins?.plugins?.["daily-notes"];
      if (dn?.instance?.options) {
        dn.instance.options._savedFolder = dn.instance.options.folder;
        dn.instance.options.folder = "";
      }
    });

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await expect($(".task-center-view")).toExist();

    // BUG: currently no warning element is rendered — assertion FAILS.
    await expect(
      $('[data-dep-warning="daily-notes-no-folder"]'),
    ).toExist();

    // Restore folder setting. Use `in` check because the original value may
    // be undefined (unset property), which would cause `!== undefined` to
    // always skip the restore block — the bug Engineer caught in the first draft.
    await browser.executeObsidian(async ({ app }) => {
      const dn = (app as any).internalPlugins?.plugins?.["daily-notes"];
      const opts = dn?.instance?.options;
      if (opts && "_savedFolder" in opts) {
        if (opts._savedFolder === undefined) {
          delete opts.folder;
        } else {
          opts.folder = opts._savedFolder;
        }
        delete opts._savedFolder;
      }
    });
  });

  // US-701c: Warning must NOT appear when Daily Notes is properly configured.
  //
  // This assertion is expected to pass even before the fix — it guards against
  // false positives (always-visible warnings).
  it("US-701c: no dep warning when Daily Notes is enabled and configured", async function () {
    await enableDailyNotes();
    await configureDailyNotesFolder();
    // task #71 adds Tasks-plugin warnings to the same status-bar surface.
    // This Daily Notes healthy-state test needs all deps healthy, otherwise a
    // valid `tasks-missing` warning would make `[data-dep-warning]` exist.
    await fakeEnableTasks();

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await expect($(".task-center-view")).toExist();

    // No warning must appear when deps are healthy.
    await expect($('[data-dep-warning]')).not.toExist();
  });
});
