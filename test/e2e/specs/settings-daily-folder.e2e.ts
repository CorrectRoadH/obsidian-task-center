import { browser } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

/**
 * task #32 (US-32): e2e verification that the "Daily folder" settings UI
 * is removed in 0.3.0.
 *
 * This spec FAILS on current main (the input still exists) and PASSES
 * after Wood's green commit deletes the `new Setting(...)` block in
 * src/settings.ts.
 *
 * Predicted CI failure: "US-32: settings panel must not render a Daily folder input"
 * Root: src/settings.ts L32-41 still builds the Setting with label
 *       "settings.dailyFolder.name" and a text input bound to `settings.dailyFolder`.
 */

const VAULT = "test/e2e/vaults/simple";

describe("Task Center settings — 0.3.0 breaking removal of dailyFolder (task #32)", function () {
  before(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  it("US-32: settings panel must not render a Daily folder input after 0.3.0 removal", async function () {
    // Open Obsidian settings modal via command palette.
    await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime API
      (app as any).setting.open();
      // Navigate to the plugin's settings tab.
      // @ts-expect-error — runtime API
      (app as any).setting.openTabById("obsidian-task-center");
    });

    // Allow the settings tab to render.
    await browser.pause(500);

    // The "Daily folder" input must NOT exist.
    // In the current (pre-fix) code, the input has placeholder="Daily" and
    // is bound to settings.dailyFolder. After removal there should be no
    // element with that placeholder in the plugin settings tab.
    const dailyFolderInput = await browser.execute(() => {
      // Look for any input with placeholder "Daily" inside the plugin settings tab.
      const settingItems = document.querySelectorAll(".vertical-tab-content .setting-item");
      for (const item of Array.from(settingItems)) {
        const input = item.querySelector<HTMLInputElement>("input[placeholder='Daily']");
        if (input) return { found: true, placeholder: input.placeholder };
      }
      return { found: false };
    });

    // Close settings modal.
    await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime API
      (app as any).setting.close();
    });

    if (dailyFolderInput.found) {
      throw new Error(
        `US-32: Settings panel still renders a "Daily folder" input (placeholder="${dailyFolderInput.placeholder}"). ` +
          "Task #32 removes this setting: the write path now comes from Obsidian's built-in " +
          "Daily Notes plugin config, not a per-plugin folder string.",
      );
    }
  });
});
