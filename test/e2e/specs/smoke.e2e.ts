import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const VAULT = "test/e2e/vaults/simple";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe("Better Task — smoke", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  it("opens the board view via command", async function () {
    await browser.executeObsidianCommand("obsidian-better-task:open");
    await expect($(".better-task-view")).toExist();
  });

  it("renders a task card scheduled today", async function () {
    const today = todayISO();
    await browser.executeObsidian(
      async ({ app }, body: string) => {
        const f = app.vault.getAbstractFileByPath("Tasks/Inbox.md");
        // @ts-expect-error — runtime type is TFile, serialization drops the class
        await app.vault.modify(f, body);
        // Wait for metadata cache to index; parseVaultTasks skips files that
        // the cache reports as having no list items yet.
        await new Promise<void>((resolve) => {
          const ref = app.metadataCache.on("changed", (file) => {
            if (file.path === "Tasks/Inbox.md") {
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
      `- [ ] E2E smoke task ⏳ ${today}\n`,
    );

    await browser.executeObsidianCommand("obsidian-better-task:open");
    await browser.executeObsidianCommand("obsidian-better-task:reload-tasks");

    // Card is rendered whether on Week or Month tab; data-task-id is stable.
    const card = $(`.better-task-view [data-task-id="Tasks/Inbox.md:L1"]`);
    await card.waitForExist({ timeout: 5000 });
    await expect(card).toExist();
  });

  it("opens the quick-add modal via command", async function () {
    await browser.executeObsidianCommand("obsidian-better-task:quick-add");
    await expect($(".better-task-quick-add")).toExist();
  });
});
