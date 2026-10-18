import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { mkdir } from "node:fs/promises";

// US-109z2: the area filter editor (per-area `when`). Guards the click-to-open
// tag select and the time-field controls — regressions here previously shipped
// because there was no e2e exercising the editor's interactions.

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
        // @ts-expect-error — runtime metadataCache
        const ref = app.metadataCache.on("changed", (file) => {
          if (file.path === p) {
            app.metadataCache.offref(ref);
            resolve();
          }
        });
        window.setTimeout(resolve, 1500);
      });
    },
    path,
    body,
  );
}

describe("US-109z2 area filter editor", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  it("opens the Area panel filter, the tag select toggles, and time fields are progressive", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Alpha task #alpha ⏳ ${today}`,
        `- [ ] Beta task #beta ⏳ ${today}`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $("[data-saved-views], .task-center-view").waitForExist({ timeout: 5000 });

    // Open an area's editor from its head → Area panel, filter tab.
    const areaEdit = await $('[data-action="edit-area"]');
    await areaEdit.waitForExist({ timeout: 5000 });
    await areaEdit.click();

    await $('[data-query-editor-scope="area"]').waitForExist({ timeout: 5000 });
    // Filter tab renders the area `when` controls.
    await expect($('[data-filter-section="area"]')).toExist();
    // Scheduled (primary) shows by default; secondary fields are progressive.
    await expect($('[data-area-time-field="scheduled"]')).toExist();
    await expect($('[data-area-time-field="deadline"]')).not.toExist();
    await expect($('[data-action="add-time-field"][data-time-field="deadline"]')).toExist();

    // The tag select is collapsed until clicked (no list yet).
    await expect($(".bt-area-tag-list")).not.toExist();
    await $(".bt-area-tag-trigger").click();
    await expect($(".bt-area-tag-list")).toExist();
    await expect($(".bt-area-tag-row")).toExist();
    // Close the floating tag popover so it no longer overlays the controls below
    // it (it's position:fixed and would otherwise intercept the click).
    await $(".bt-area-tag-trigger").click();
    await expect($(".bt-area-tag-list")).not.toExist();

    // Adding a date field reveals it.
    await $('[data-action="add-time-field"][data-time-field="deadline"]').click();
    await expect($('[data-area-time-field="deadline"]')).toExist();
    // US-109i: abandoned-on is a first-class progressive date field.
    await $('[data-action="add-time-field"][data-time-field="dropped"]').click();
    await expect($('[data-area-time-field="dropped"]')).toExist();
    // US-109d4: live errors use character locations and keep the invalid edit local.
    const expression = await $('[data-area-tag-expr]');
    expect(await expression.getAttribute("placeholder")).toBe("#a and (#b or #c) and not #d");
    await expression.setValue("#long #b");
    await expect($(".bt-area-tag-expr-error.is-visible")).toHaveText(expect.stringContaining("7"));
    await browser.keys("Escape");
    await expect($('[data-query-editor-scope="area"]')).not.toExist();
  });

  it("US-109t/US-109z2/US-109p9: calendar weekday overrides and title-only abandon head", async () => {
    await writeAndWait("Tasks/Inbox.md", "- [ ] Calendar sample ⏳ 2026-05-03\n");
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["task-center"];
      plugin.settings.weekStartsOn = 1;
      plugin.settings.queryPresets = [{ id: "calendar-override", name: "Calendar override", view: { layout: { dir: "col", children: [
        { type: "week", title: "Sunday week", firstDayOfWeek: "sunday" },
        { type: "month", title: "Sunday month", firstDayOfWeek: "sunday" },
        { type: "drop", title: "Abandon here", onDrop: { setStatus: "dropped" } },
      ] } } }];
      plugin.settings.lastSavedViewId = "calendar-override";
      await plugin.saveSettings();
      for (const leaf of app.workspace.getLeavesOfType("task-center-board")) leaf.detach();
    });
    await browser.executeObsidianCommand("task-center:open");
    await browser.executeObsidian(({ app }) => {
      const view = app.workspace.getLeavesOfType("task-center-board")[0].view as any;
      view.state.anchorISO = "2026-05-04";
      view.render();
    });
    await expect($(".bt-week-col[data-date='2026-05-03']")).toExist();
    await expect($(".bt-area-drop .bt-area-head-title")).toHaveText(/Abandon here/i);
    await expect($(".bt-area-drop [data-action=edit-area]")).not.toExist();
    const firstDays = await browser.execute(() => ({
      week: (document.querySelector(".bt-week-col") as HTMLElement)?.dataset.date,
      month: (document.querySelector(".bt-month-cell") as HTMLElement)?.dataset.date,
    }));
    expect(firstDays).toEqual({ week: "2026-05-03", month: "2026-04-26" });
    await mkdir("test/e2e/screenshots", { recursive: true });
    await browser.saveScreenshot("test/e2e/screenshots/dsl-calendar-first-day.png");
    await browser.execute(() => document.querySelector(".bt-area-drop")?.scrollIntoView());
    await browser.saveScreenshot("test/e2e/screenshots/dsl-calendar-drop.png");
  });

});
