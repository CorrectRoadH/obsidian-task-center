/**
 * task #88: mobile saved-view/filter controls must not dump the full
 * desktop toolbar onto the phone. Mobile keeps one compact entry and moves
 * the full controls into a bottom sheet.
 */
import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import fs from "node:fs/promises";

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

describe("Task Center — mobile filter UI (task #88)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    await setMobileMode(true);
  });

  afterEach(async function () {
    await setMobileMode(false);
  });

  it("task #88: mobile toolbar uses one filter entry and puts saved-view controls in a bottom sheet", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Mobile width task #work #1象限 ⏳ ${today}\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await $(".task-center-view[data-mobile-layout='true']").waitForExist({
      timeout: 5000,
    });
    await $('[data-tab="week"]').click();
    await $('[data-task-id="Tasks/Inbox.md:L1"]').waitForExist({ timeout: 5000 });

    await expect($(".task-center-view .bt-toolbar > [data-saved-views]")).not.toExist();
    await expect($("[data-mobile-action='filters']")).toExist();

    const widthOk = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".task-center-view");
      const body = document.querySelector<HTMLElement>(".task-center-view .bt-body");
      const card = document.querySelector<HTMLElement>(".task-center-view [data-task-id='Tasks/Inbox.md:L1']");
      if (!view || !body || !card) return false;
      const viewWidth = view.getBoundingClientRect().width;
      const bodyWidth = body.getBoundingClientRect().width;
      const cardWidth = card.getBoundingClientRect().width;
      return bodyWidth >= viewWidth * 0.9 && cardWidth >= bodyWidth * 0.85;
    });
    expect(widthOk).toBe(true);

    const safeAreaOk = await browser.execute(() => {
      const bar = document.querySelector<HTMLElement>(".bt-mobile-action-bar");
      if (!bar) return false;
      const paddingBottom = Number.parseFloat(getComputedStyle(bar).paddingBottom);
      return paddingBottom >= 8;
    });
    expect(safeAreaOk).toBe(true);

    await $("[data-mobile-action='filters']").click();
    await $(".task-center-bottom-sheet .bt-mobile-filter-sheet").waitForExist({
      timeout: 3000,
    });
    await expect($(".task-center-bottom-sheet [data-saved-views]")).toExist();
    await expect($(".task-center-bottom-sheet [data-saved-view-select]")).toExist();
    await expect($(".task-center-bottom-sheet [data-saved-view-filter='tag']")).toExist();
    await expect($(".task-center-bottom-sheet [data-saved-view-filter='date']")).toExist();
    await expect($(".task-center-bottom-sheet [data-saved-view-filter='status']")).toExist();
    await expect($(".task-center-bottom-sheet [data-saved-view-filter='grouping']")).toExist();

    await $(".task-center-bottom-sheet [data-saved-view-filter='tag']").setValue("#missing");
    await browser.keys("Enter");
    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).not.toExist();

    await browser.pause(200);
    const png = await browser.takeScreenshot();
    await fs.writeFile("/tmp/task-center-mobile-filter-ui.png", Buffer.from(png, "base64"));
  });
});
