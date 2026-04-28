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
    await (app as any).plugins.plugins["task-center"].__forFlush();
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

async function readFile(path: string): Promise<string> {
  return (await browser.executeObsidian(async ({ app }, p: string) => {
    const f = app.vault.getAbstractFileByPath(p);
    if (!f) return "";
    // @ts-expect-error — runtime TFile
    return await app.vault.read(f);
  }, path)) as unknown as string;
}

/**
 * US-413 — vault-wide IME composition guard. While the user is composing
 * (typing pinyin/kana/hangul before candidate selection), Enter only
 * commits the IME selection — it must NOT submit the surrounding form.
 *
 * This file covers the remaining inline editors plus removed card-surface edit
 * paths. The Quick Add modal case (chunk a) lives in quickadd.e2e.ts to keep
 * its fixture setup adjacent to the other Quick Add v2 cases.
 */
describe("Task Center — IME composition guard (US-413)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-413 chunk b used to cover card-title inline rename. US-168 made source
  // edit shell the single card/title edit path, so no `.bt-title-edit` should
  // be reachable from the card title anymore.
  it("US-168/US-413 chunk b — card title click opens source shell, not inline rename", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Original title ⏳ ${today}\n`);

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    const cardSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });

    await browser.execute((sel: string) => {
      const title = document.querySelector(`${sel} .bt-card-title`) as HTMLElement | null;
      title?.click();
    }, cardSel);

    await expect($(`${cardSel} .bt-title-edit`)).not.toExist();
    const shell = $("[data-source-edit-shell]");
    await shell.waitForExist({ timeout: 5000 });
    await expect(shell).toHaveAttribute("data-source-edit-task-id", "Tasks/Inbox.md:L1");

    await browser.keys("Escape");
    await shell.waitForExist({ timeout: 5000, reverse: true });
  });

  // UX.md §6.8 removed the old selected-card `D` shortcut. The date prompt
  // may remain as internal code, but this desktop keyboard path must not
  // reopen it without a current USER_STORIES-backed shortcut.
  it("UX §6.8: selected-card D shortcut no longer opens DatePrompt", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Date prompt task ⏳ ${today}\n`);

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    const cardSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });

    // Select the card and press 'd'. The old shortcut path should no-op.
    await browser.execute((sel: string) => {
      const card = document.querySelector(sel) as HTMLElement | null;
      card?.click();
      // Synth a 'd' keydown on contentEl to fire the view-level handler.
      const view = document.querySelector(".task-center-view") as HTMLElement | null;
      view?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true }),
      );
    }, cardSel);

    const promptInput = $(".task-center-date-prompt input");
    await expect(promptInput).not.toExist();

    const content = await readFile("Tasks/Inbox.md");
    expect(content).toContain(`⏳ ${today}`);
  });
});
