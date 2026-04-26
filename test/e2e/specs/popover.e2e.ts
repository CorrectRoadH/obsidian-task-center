/**
 * US-165: Hover preview lifecycle — task #68 regression
 *
 * Bug: switching tabs (or any re-render path) calls render() → el.empty(),
 * which removes card DOM nodes without calling contextPopover.close().
 * The popover is mounted on document.body so it survives el.empty() and
 * floats orphaned. mouseleave never fires because the anchor card is gone.
 *
 * Fix expected: render() must call this.contextPopover.close() before
 * clearing the DOM.
 */
import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const VAULT = "test/e2e/vaults/simple";
const VIEW_TYPE = "task-center-board";

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
          if (file.path === p) { app.metadataCache.offref(ref); resolve(); }
        });
        setTimeout(() => { app.metadataCache.offref(ref); resolve(); }, 2000);
      });
    },
    path,
    body,
  );
}

describe("US-165 hover preview lifecycle (task #68)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // task #68: popover must not survive a tab switch.
  //
  // Failure mode: setTab() → render() → el.empty() removes the anchor card
  // from the DOM but never calls contextPopover.close(). The popover lives on
  // document.body and stays visible. This test fails until render() calls close().
  it("task #68: hover popover closes when switching tabs without moving mouse", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Hover popover regression test ⏳ ${today}\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    // Wait for the week-tab card to appear.
    const card = $(`.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`);
    await card.waitForExist({ timeout: 5000 });

    // Move mouse over the card and hold — triggers mouseenter which schedules
    // the 350ms hover timer, then async open() reads vault + renders markdown.
    await card.moveTo();
    await browser.pause(800); // 350ms delay + vault read + markdown render + margin

    // Popover must now exist — if it doesn't appear, the test environment
    // doesn't support real hover events; fail fast with a clear message.
    await expect($(".bt-ctx-popover")).toExist();

    // Switch tabs by calling setTab() directly — no mouse movement, so
    // mouseleave never fires on the card. This is the exact scenario that
    // leaves the popover orphaned.
    await browser.executeObsidian(async ({ app }, vt: string) => {
      const leaves = app.workspace.getLeavesOfType(vt);
      if (leaves.length > 0) {
        (leaves[0].view as any).setTab("unscheduled");
      }
    }, VIEW_TYPE);

    // Give render() one tick to flush.
    await browser.pause(200);

    // BUG: popover is still attached to document.body because render() never
    // calls contextPopover.close(). This assertion currently FAILS.
    await expect($(".bt-ctx-popover")).not.toExist();
  });
});
