/**
 * US-720: Today execution view (task #63)
 *
 * The existing board does not have a "today" focused entry point that
 * aggregates overdue, today, and unscheduled-recommendation in one place.
 * US-720 adds a dedicated today tab/view with quick actions.
 *
 * Stable DOM attributes (contract with implementation):
 *   data-tab="today"             — today tab button
 *   data-view="today"            — today view container
 *   data-today-group="overdue"   — overdue section
 *   data-today-group="today"     — today's tasks section
 *   data-today-group="unscheduled-rec" — unscheduled recommendation
 *   data-action="reschedule-tomorrow"  — reschedule button per card
 *   data-today-empty             — empty-state element
 *
 * All tests currently FAIL — none of these elements exist yet.
 */
import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const VAULT = "test/e2e/vaults/simple";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
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
  await browser.executeObsidian(async ({ app }, p: string) => {
    // @ts-expect-error — runtime plugin test hook
    await app.plugins.plugins["obsidian-task-center"].cache.invalidateFile(p);
    // @ts-expect-error — runtime plugin test hook
    await app.plugins.plugins["obsidian-task-center"].__forFlush();
  }, path);
}

async function resetTaskCacheForTest() {
  await browser.executeObsidian(async ({ app }) => {
    // resetVault() mutates the fixture below Obsidian and may not emit delete
    // events for files created by earlier specs. Clear the runtime cache so
    // this spec's "empty vault" assertion is based on the current fixture.
    // @ts-expect-error — runtime plugin test hook
    const cache = app.plugins.plugins["obsidian-task-center"].cache as any;
    cache.byPath?.clear?.();
    cache.byHash?.clear?.();
    cache.pending?.clear?.();
    cache.allLoaded = false;
    cache.allLoadingPromise = null;
    // @ts-expect-error — runtime plugin test hook
    const plugin = app.plugins.plugins["obsidian-task-center"];
    await plugin.refreshOpenViews();
    await plugin.__forFlush();
  });
}

describe("US-720 today execution view (task #63)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-720a: today tab entry point must exist in the board.
  // FAIL until: board renders a [data-tab="today"] button.
  it("US-720a: today tab entry point exists in the board", async function () {
    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await expect($(".task-center-view")).toExist();

    // BUG: no today tab exists — FAILS.
    await expect($('[data-tab="today"]')).toExist();
  });

  // US-720b: today view shows three groups when tasks are present.
  // Fixture: 1 overdue, 1 today, 1 unscheduled task.
  // FAIL until: today view renders the three group containers.
  it("US-720b: today view renders overdue/today/unscheduled-rec groups", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Overdue task 📅 2020-01-01`,
        `- [ ] Today task ⏳ ${today}`,
        `- [ ] Unscheduled task`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    // Switch to today tab.
    const todayTab = $('[data-tab="today"]');
    await todayTab.waitForExist({ timeout: 5000 });
    await todayTab.click();

    const todayView = $('[data-view="today"]');
    await todayView.waitForExist({ timeout: 3000 });

    // All three groups must be present.
    await expect($('[data-today-group="overdue"]')).toExist();
    await expect($('[data-today-group="today"]')).toExist();
    await expect($('[data-today-group="unscheduled-rec"]')).toExist();
  });

  // US-720c: "reschedule to tomorrow" writes ⏳ tomorrow into the file.
  // FAIL until: reschedule-tomorrow action exists and calls writer correctly.
  it("US-720c: reschedule-tomorrow writes tomorrow date to file", async function () {
    const today = todayISO();
    const tomorrow = tomorrowISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Today task ⏳ ${today}\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    const todayTab = $('[data-tab="today"]');
    await todayTab.waitForExist({ timeout: 5000 });
    await todayTab.click();

    // Find and click the reschedule-tomorrow button on the today task.
    const rescheduleBtn = $(
      `[data-today-group="today"] [data-action="reschedule-tomorrow"]`,
    );
    await rescheduleBtn.waitForExist({ timeout: 3000 });
    await rescheduleBtn.click();
    await forFlush();

    // Verify the file was updated with tomorrow's date.
    const content = await browser.executeObsidian(
      async ({ app }, p: string) => {
        const f = app.vault.getAbstractFileByPath(p);
        if (!f) return null;
        // @ts-expect-error — runtime TFile
        return await app.vault.cachedRead(f);
      },
      "Tasks/Inbox.md",
    );
    expect(content).toContain(`⏳ ${tomorrow}`);
    expect(content).not.toContain(`⏳ ${today}`);
  });

  // US-720d: empty state element shown when no tasks in any group.
  // FAIL until: today view renders data-today-empty when all groups are empty.
  it("US-720d: empty state shown when no tasks exist", async function () {
    // Force this spec's task source empty instead of relying on runner reset state.
    await writeAndWait("Tasks/Inbox.md", "");
    await resetTaskCacheForTest();

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    const todayTab = $('[data-tab="today"]');
    await todayTab.waitForExist({ timeout: 5000 });
    await todayTab.click();

    await expect($('[data-today-empty]')).toExist();
  });
});
