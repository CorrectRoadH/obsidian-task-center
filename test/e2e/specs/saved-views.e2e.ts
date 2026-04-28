/**
 * US-724: saved views / custom filters.
 *
 * Stable DOM attributes:
 *   data-saved-views                  — saved-view filter toolbar
 *   data-saved-view-filter="tag"      — tag multi-select (US-109d)
 *   data-saved-view-filter="date"     — date condition select (US-109e)
 *   data-saved-view-filter="status"   — status dropdown
 *   data-saved-view-filter="grouping" — grouping dropdown
 *   data-action="save-current-view"   — save current filters button
 *   data-saved-view-select            — saved view selector
 */
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
          if (file.path === p) { app.metadataCache.offref(ref); resolve(); }
        });
        setTimeout(() => { app.metadataCache.offref(ref); resolve(); }, 2000);
      });
    },
    path,
    body,
  );
}

describe("US-724 saved views / custom filters", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  it("US-109d/e: filters visible cards by tag/date/status/grouping and saves/restores the view", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Work writing today #work #writing #1象限 ⏳ ${today}`,
        `- [ ] Work only today #work #1象限 ⏳ ${today}`,
        `- [ ] Life today #life #1象限 ⏳ ${today}`,
        `- [x] Work done #work #1象限 ✅ ${today}`,
        `- [ ] Work other group #work #2象限 ⏳ ${today}`,
        `- [ ] Work later #work #1象限 ⏳ 2099-01-01`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await $('[data-saved-views]').waitForExist({ timeout: 5000 });

    const tagShape = await browser.execute(() => {
      const el = document.querySelector("[data-saved-view-filter='tag']") as HTMLSelectElement | null;
      return { tagName: el?.tagName, multiple: !!el?.multiple };
    });
    expect(tagShape).toEqual({ tagName: "SELECT", multiple: true });

    const dateTagName = await browser.execute(() => {
      const el = document.querySelector("[data-saved-view-filter='date']");
      return el?.tagName;
    });
    expect(dateTagName).toBe("SELECT");

    await $('[data-saved-view-filter="tag"]').selectByAttribute("value", "#work");
    await $('[data-saved-view-filter="tag"]').selectByAttribute("value", "#writing");
    await $('[data-saved-view-filter="date"]').selectByAttribute("value", "today");
    await $('[data-saved-view-filter="status"]').selectByAttribute("value", "todo");
    await $('[data-saved-view-filter="grouping"]').selectByAttribute("value", "#1象限");

    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L3"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L4"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L5"]')).not.toExist();

    await browser.execute(() => {
      window.prompt = () => "Work Today";
    });
    await $('[data-action="save-current-view"]').click();
    await forFlush();

    // Change filters away, then restore through the saved-view dropdown.
    await browser.execute(() => {
      const select = document.querySelector("[data-saved-view-filter='tag']") as HTMLSelectElement;
      for (const option of Array.from(select.options)) option.selected = option.value === "#life";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await $('[data-saved-view-select]').selectByVisibleText("Work Today");

    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).not.toExist();

    const saved = await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime plugin
      return (app as any).plugins.plugins["obsidian-task-center"].settings.savedViews;
    });
    expect(JSON.stringify(saved)).toContain("Work Today");
  });
});
