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

/** Write content to a vault file and wait for metadata cache to pick it up. */
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
      // Wait for the metadata cache to index this file before continuing.
      await new Promise<void>((resolve) => {
        // @ts-expect-error — runtime TFile
        const ref = app.metadataCache.on("changed", (file) => {
          if (file.path === p) {
            app.metadataCache.offref(ref);
            resolve();
          }
        });
        // Hard upper-bound so we never stall the test suite.
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

describe("Task Center — 看板基础 (US-101/107/115)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-101: board opens
  it("opens the board view via command", async function () {
    await browser.executeObsidianCommand("obsidian-task-center:open");
    await expect($(".task-center-view")).toExist();
  });

  // US-101: renders a task card scheduled today
  it("renders a task card scheduled today (data-task-id is stable)", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] E2E smoke task ⏳ ${today}\n`);

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    const card = $(`.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`);
    await card.waitForExist({ timeout: 5000 });
    await expect(card).toExist();
  });

  // US-107: tasks with empty title must be silently ignored — no card appears
  it("US-107: ignores blank-title tasks (empty checkbox body)", async function () {
    const today = todayISO();
    // One blank-title task and one real task to confirm the board loaded at all.
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] ⏳ ${today}\n- [ ] Real task ⏳ ${today}\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    // The real task's card must appear.
    await $(`.task-center-view [data-task-id="Tasks/Inbox.md:L2"]`).waitForExist({
      timeout: 5000,
    });

    // The blank-title task must NOT produce a card (L1).
    const blankCard = $(`.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`);
    await expect(blankCard).not.toExist();
  });

  // US-115: overdue cards get a visual marker (overdue class/attribute)
  it("US-115: overdue task card has overdue visual indicator", async function () {
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Overdue task 📅 2020-01-01\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    // Find the card — it may live in Unscheduled pool or any view tab.
    // We just need at least one element that carries the overdue marker.
    await browser.waitUntil(
      async () => {
        const count = await browser.execute(() => {
          // Accept either a CSS class or a data-attribute as the marker —
          // the exact implementation is Tiger's call.
          return document.querySelectorAll(
            ".task-center-view .bt-overdue, .task-center-view [data-overdue='true']",
          ).length;
        });
        return (count as number) > 0;
      },
      { timeout: 5000, timeoutMsg: "no overdue marker found for a past-deadline task" },
    );
  });

  // US-115: near-deadline (within 3 days) gets its own marker
  it("US-115: near-deadline task card has near-deadline visual indicator", async function () {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    const nearDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Near deadline task 📅 ${nearDate}\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await browser.waitUntil(
      async () => {
        const count = await browser.execute(() => {
          return document.querySelectorAll(
            ".task-center-view .bt-near-deadline, .task-center-view [data-near-deadline='true']",
          ).length;
        });
        return (count as number) > 0;
      },
      { timeout: 5000, timeoutMsg: "no near-deadline marker for a task due in 2 days" },
    );
  });

  // quick-add modal
  it("opens the quick-add modal via command", async function () {
    await browser.executeObsidianCommand("obsidian-task-center:quick-add");
    await expect($(".task-center-quick-add")).toExist();
  });
});
