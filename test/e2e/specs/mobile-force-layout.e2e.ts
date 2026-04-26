import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const VAULT = "test/e2e/vaults/simple";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function forFlush() {
  await browser.executeObsidian(async ({ app }) => {
    // @ts-expect-error — runtime plugin
    await (app as any).plugins.plugins["obsidian-task-center"].__forFlush();
  });
}

async function writeAndWait(path: string, body: string) {
  await browser.executeObsidian(
    async ({ app }, p: string, content: string) => {
      let f = app.vault.getAbstractFileByPath(p);
      if (!f) {
        const folder = p.split("/").slice(0, -1).join("/");
        if (folder) await app.vault.createFolder(folder).catch(() => undefined);
        f = await app.vault.create(p, content);
      } else {
        // @ts-expect-error — runtime TFile
        await app.vault.modify(f, content);
      }
      await new Promise<void>((resolve) => {
        // @ts-expect-error — runtime TFile
        const ref = app.metadataCache.on("changed", (file) => {
          if (file.path === p) {
            app.metadataCache.offref(ref);
            resolve();
          }
        });
        setTimeout(() => {
          app.metadataCache.offref(ref);
          resolve();
        }, 2000);
      });
    },
    path,
    body,
  );
}

async function setMobileForceLayout(value: boolean): Promise<void> {
  await browser.executeObsidian(async ({ app }, v: boolean) => {
    // @ts-expect-error — runtime plugin
    const plugin = (app as any).plugins.plugins["obsidian-task-center"];
    plugin.settings.mobileForceLayout = v;
    await plugin.saveSettings();
  }, value);
}

/**
 * task #42 (US-502 / US-504): when the user has flipped
 * `mobileForceLayout` on (e.g. iPad / split-screen escape hatch), the
 * Month tab's tap-day-to-open-bottom-sheet behavior MUST follow that
 * setting — the previous code only consulted `window.innerWidth < 600`,
 * so on a wide screen the click silently no-op'd and the user could
 * never reach the day's task list. Mobile layout is mode, viewport is
 * one of two triggers; this case covers the other trigger.
 */
describe("Task Center — mobileForceLayout (task #42)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  it("task #42: wide-screen Month cell tap opens bottom sheet when mobileForceLayout=true", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Smoke task ⏳ ${today}\n`);

    // Force-mobile is the user's intent regardless of viewport width.
    await setMobileForceLayout(true);

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    // Switch to the Month tab.
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>(".task-center-view [data-tab='month']")
        ?.click();
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.querySelector(
              ".task-center-view [data-tab='month'].active, .task-center-view [data-tab='month'][aria-selected='true']",
            ),
        ),
      { timeout: 3000, interval: 100, timeoutMsg: "Month tab did not become active" },
    );

    // Tap today's calendar cell. The chip is also inside the cell, so click
    // the cell's HEAD (the day-number row) to avoid the chip-select branch.
    await browser.execute((iso: string) => {
      const cell = document.querySelector<HTMLElement>(
        `.task-center-view .bt-month-cell[data-date="${iso}"]`,
      );
      cell?.click();
    }, today);

    // The bottom sheet uses the `task-center-bottom-sheet` modal class.
    // It must appear. On the buggy code path the click no-ops on a wide
    // viewport regardless of `mobileForceLayout`, so the sheet stays
    // closed and this assertion times out.
    await $(".task-center-bottom-sheet").waitForExist({
      timeout: 3000,
      timeoutMsg:
        "task #42 still red — Month cell tap did not open bottom sheet despite mobileForceLayout=true",
    });
  });
});
