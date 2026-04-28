/**
 * US-724: saved views / custom filters.
 *
 * Stable DOM attributes:
 *   data-saved-views                  — saved-view filter toolbar
 *   data-saved-view-filter="tag"      — tag popover trigger (US-109d)
 *   data-saved-view-filter="time-scheduled" — scheduled range popover trigger (US-109e)
 *   data-saved-view-filter="status"   — status popover trigger (US-109h)
 *   data-action="save-current-view"   — save current filters button
 *   data-saved-view-select            — saved view popover trigger
 *   data-saved-view-option            — saved view menu item
 *   data-tag-option="#tag"            — tag checkbox row inside the popover
 *   data-time-option="scheduled:today" — scheduled condition row inside the popover
 *   data-status-option="todo"         — status condition row inside the popover
 *   data-saved-view-name-input        — saved-view naming modal input
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

async function resetSavedViewTestState() {
  await browser.executeObsidian(async ({ app }) => {
    // @ts-expect-error — runtime plugin
    const plugin = (app as any).plugins.plugins["obsidian-task-center"];
    plugin.settings.savedViews = [];
    await plugin.saveSettings();
    await Promise.all(app.workspace.getLeavesOfType("task-center-board").map((leaf) => leaf.detach()));
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
    await resetSavedViewTestState();
  });

  it("US-109d/e/f: filters visible cards by tags/date/status and saves/restores the view", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Fixture alpha beta today #alpha #beta #1象限 ⏳ ${today}`,
        `- [ ] Fixture alpha today #alpha #1象限 ⏳ ${today}`,
        `- [ ] Fixture gamma today #gamma #1象限 ⏳ ${today}`,
        `- [x] Fixture alpha done #alpha #1象限 ✅ ${today}`,
        `- [ ] Fixture alpha other group #alpha #2象限 ⏳ ${today}`,
        `- [ ] Fixture alpha later #alpha #1象限 ⏳ 2099-01-01`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await $('[data-saved-views]').waitForExist({ timeout: 5000 });

    const tagShape = await browser.execute(() => {
      const el = document.querySelector("[data-saved-view-filter='tag']");
      return { tagName: el?.tagName, aria: el?.getAttribute("aria-haspopup") };
    });
    expect(tagShape).toEqual({ tagName: "BUTTON", aria: "listbox" });

    const dateShape = await browser.execute(() => {
      const el = document.querySelector("[data-saved-view-filter='time-scheduled']");
      return { tagName: el?.tagName, aria: el?.getAttribute("aria-haspopup") };
    });
    expect(dateShape).toEqual({ tagName: "BUTTON", aria: "listbox" });

    const statusShape = await browser.execute(() => {
      const el = document.querySelector("[data-saved-view-filter='status']");
      return { tagName: el?.tagName, aria: el?.getAttribute("aria-haspopup") };
    });
    expect(statusShape).toEqual({ tagName: "BUTTON", aria: "listbox" });

    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-tag-option="#alpha"]').click();
    await expect($('[data-tag-option="#alpha"]')).toHaveAttribute("aria-checked", "true");
    await $('[data-tag-option="#beta"]').click();
    await $('[data-saved-view-filter="time-scheduled"]').click();
    await $('[data-time-option="scheduled:today"]').click();
    await $('[data-saved-view-filter="status"]').click();
    await $('[data-status-option="todo"]').click();
    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-tag-option="#1象限"]').click();

    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L3"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L4"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L5"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L6"]')).not.toExist();

    await $('[data-action="save-current-view"]').click();
    await $('[data-saved-view-name-input]').setValue("Alpha Today");
    await $('[data-action="confirm-saved-view-name"]').click();
    await forFlush();
    await expect($('[data-action="update-current-view"]')).toExist();

    // Change filters away, then restore through the saved-view dropdown.
    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-tag-clear]').click();
    await $('[data-tag-option="#gamma"]').click();
    await expect($('[data-action="update-current-view"]')).toExist();
    await $('[data-saved-view-select]').click();
    await $('[data-saved-view-option="Alpha Today"]').click();

    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L6"]')).not.toExist();

    const saved = await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime plugin
      return (app as any).plugins.plugins["obsidian-task-center"].settings.savedViews;
    });
    expect(JSON.stringify(saved)).toContain("Alpha Today");
  });

  it("US-109c: updates the selected saved view instead of prompting for a new name", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Fixture alpha today #alpha ⏳ ${today}`,
        `- [ ] Fixture gamma today #gamma ⏳ ${today}`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();
    await $('[data-saved-views]').waitForExist({ timeout: 5000 });

    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-tag-option="#alpha"]').click();
    await $('[data-action="save-current-view"]').click();
    await $('[data-saved-view-name-input]').setValue("Focus");
    await $('[data-action="confirm-saved-view-name"]').click();
    await forFlush();

    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-tag-clear]').click();
    await $('[data-tag-option="#gamma"]').click();
    await $('[data-action="update-current-view"]').click();
    await forFlush();

    await expect($('[data-saved-view-name-input]')).not.toExist();
    const savedJson = await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime plugin
      return JSON.stringify((app as any).plugins.plugins["obsidian-task-center"].settings.savedViews);
    });
    expect(savedJson).toContain('"name":"Focus"');
    expect(savedJson).toContain('"tag":"#gamma"');
    expect(savedJson).not.toContain('"tag":"#alpha"');
  });

  it("US-109d: tag picker excludes block refs and prose-polluted pseudo tags", async function () {
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        "- [ ] Fixture option source #计划 #安全 [[Spec#Heading]] #^624c3648-bca7-4ee2",
        "- [ ] Fixture punctuation source #第一象限、#第二象限 等。并通过`advance` #示例工具箱",
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();
    await $('[data-saved-views]').waitForExist({ timeout: 5000 });
    await $('[data-saved-view-filter="tag"]').click();

    const options = await browser.execute(() =>
      Array.from(document.querySelectorAll("[data-tag-option]")).map((el) => ({
        value: (el as HTMLElement).dataset.tagOption,
        text: el.textContent,
      })),
    );

    expect(options.map((o) => o.value)).toContain("#计划");
    expect(options.map((o) => o.value)).toContain("#安全");
    expect(options.map((o) => o.value)).toContain("#第一象限");
    expect(options.map((o) => o.value)).toContain("#第二象限");
    expect(options.map((o) => o.value)).toContain("#示例工具箱");
    expect(JSON.stringify(options)).not.toContain("#^624c3648");
    expect(JSON.stringify(options)).not.toContain("并通过");
    expect(JSON.stringify(options)).not.toContain("[[Spec#Heading");
  });
});
