/**
 * US-711: mobile explicit entry points (task #62)
 *
 * Mobile users should not have to discover desktop-only commands before
 * Task Center feels usable. The mobile layout must expose a thumb-reachable
 * Task Center return/home button, a Quick Add entry, and a first-use empty
 * state that does not mention desktop shortcuts.
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

async function setMobileMode(value: boolean): Promise<void> {
  await browser.executeObsidian(async ({ app }, v: boolean) => {
    // @ts-expect-error — runtime plugin
    const plugin = (app as any).plugins.plugins["obsidian-task-center"];
    if (typeof plugin.__setTestForceMobile === "function") {
      plugin.__setTestForceMobile(v);
    }
    plugin.settings.mobileForceLayout = v;
    plugin.settings.lastTab = "today";
    await plugin.saveSettings();
  }, value);
}

describe("Task Center — mobile explicit entry points (US-711)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    await setMobileMode(true);
  });

  afterEach(async function () {
    await setMobileMode(false);
  });

  it("US-711: mobile layout exposes Task Center, Quick Add, and first-use empty state", async function () {
    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await $(".task-center-view[data-mobile-layout='true']").waitForExist({
      timeout: 5000,
    });

    const empty = $(".bt-onboarding[data-mobile-empty-state='true']");
    await expect(empty).toExist();
    expect(await empty.getText()).not.toContain("Cmd/Ctrl");
    await expect($("[data-mobile-action='empty-quick-add']")).toExist();

    const mobileEntry = $("[data-mobile-entry='true']");
    await expect(mobileEntry).toExist();
    await expect($("[data-mobile-action='open-task-center']")).toExist();
    await expect($("[data-mobile-action='quick-add']")).toExist();

    await $("[data-mobile-action='quick-add']").click();
    await $(".task-center-bottom-sheet").waitForExist({
      timeout: 3000,
      timeoutMsg: "US-711: mobile Quick Add entry did not open the bottom sheet",
    });
    await browser.execute(() => {
      document.querySelector<HTMLElement>(".modal-close-button")?.click();
    });

    await $("[data-tab='week']").click();
    await $('[data-tab="week"].active').waitForExist({ timeout: 3000 });
    await $("[data-mobile-action='open-task-center']").click();
    await $('[data-tab="today"].active').waitForExist({
      timeout: 3000,
      timeoutMsg: "US-711: mobile Task Center entry did not return to Today",
    });
    await expect($(".bt-onboarding[data-mobile-empty-state='true']")).toExist();
  });
});
