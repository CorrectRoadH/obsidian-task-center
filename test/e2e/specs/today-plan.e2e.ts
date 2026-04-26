/**
 * US-721: Today planning mode (task #64)
 *
 * The "unscheduled" pool has no workflow to help users decide which tasks
 * to do today. US-721 adds a planning mode where users can quickly schedule
 * unscheduled tasks to today/tomorrow/this week.
 *
 * Note: US-721 shares data with US-720 (today view). Implementations may
 * co-locate in the same tab/component, but these tests focus specifically on
 * the planning-mode UI elements and the schedule-to-date actions.
 *
 * Stable DOM attributes:
 *   data-view="plan-today"              — plan-today panel/container
 *   data-action="open-plan-today"       — entry button to planning mode
 *   data-plan-candidate                 — each unscheduled task row
 *   data-plan-action="schedule-today"   — schedule to today button
 *   data-plan-action="schedule-tomorrow"— schedule to tomorrow button
 *   data-plan-action="schedule-week"    — schedule to end of this week button
 *   data-plan-total-est                 — estimated total time display
 *   data-plan-overload                  — overload warning element
 *
 * All tests currently FAIL — none of these elements exist yet.
 */
import { browser, expect, $, $$ } from "@wdio/globals";
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
}

async function openPlanTodayView() {
  await browser.executeObsidianCommand("obsidian-task-center:open");
  const entryBtn = $('[data-action="open-plan-today"]');
  await entryBtn.waitForExist({ timeout: 5000 });
  await entryBtn.click();
  await $('[data-view="plan-today"]').waitForExist({ timeout: 3000 });
}

describe("US-721 today planning mode (task #64)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-721a: planning mode entry point must exist in the board.
  // FAIL until: board renders data-action="open-plan-today" button.
  it("US-721a: plan-today entry button exists in the board", async function () {
    await browser.executeObsidianCommand("obsidian-task-center:open");
    await expect($(".task-center-view")).toExist();

    // BUG: no plan-today entry exists — FAILS.
    await expect($('[data-action="open-plan-today"]')).toExist();
  });

  // US-721b: unscheduled tasks appear as plan candidates.
  // FAIL until: plan-today view lists data-plan-candidate elements.
  it("US-721b: unscheduled tasks shown as plan candidates", async function () {
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Unscheduled A`,
        `- [ ] Unscheduled B ⏱️ 30m`,
      ].join("\n") + "\n",
    );

    await openPlanTodayView();

    // Both unscheduled tasks must appear as candidates.
    const candidates = await $$('[data-plan-candidate]');
    await expect(candidates.length).toBeGreaterThanOrEqual(2);
  });

  // US-721c: estimated total time shown (no overload for small total).
  // Requires tasks with ⏱️ time estimates.
  // FAIL until: plan-today renders data-plan-total-est.
  it("US-721c: estimated total time is displayed for tasks with est", async function () {
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Task A ⏱️ 60m`,
        `- [ ] Task B ⏱️ 30m`,
      ].join("\n") + "\n",
    );

    await openPlanTodayView();

    // BUG: no total-est element — FAILS.
    await expect($('[data-plan-total-est]')).toExist();
    // No overload for 90m total (< 8h default capacity).
    await expect($('[data-plan-overload]')).not.toExist();
  });

  // US-721d: schedule-to-today writes ⏳ today into the task file.
  // FAIL until: schedule-today action calls the writer with today's date.
  it("US-721d: schedule-today writes today's date to the task file", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Plan me today\n`,
    );

    await openPlanTodayView();

    const scheduleBtn = $('[data-plan-candidate] [data-plan-action="schedule-today"]');
    await scheduleBtn.waitForExist({ timeout: 3000 });
    await scheduleBtn.click();
    await forFlush();

    const content = await browser.executeObsidian(
      async ({ app }, p: string) => {
        const f = app.vault.getAbstractFileByPath(p);
        if (!f) return null;
        // @ts-expect-error — runtime TFile
        return await app.vault.cachedRead(f);
      },
      "Tasks/Inbox.md",
    );
    expect(content).toContain(`⏳ ${today}`);
  });

  // US-721d (tomorrow variant): schedule-to-tomorrow writes ⏳ tomorrow.
  it("US-721d: schedule-tomorrow writes tomorrow's date to the task file", async function () {
    const tomorrow = tomorrowISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Plan me tomorrow\n`,
    );

    await openPlanTodayView();

    const scheduleBtn = $('[data-plan-candidate] [data-plan-action="schedule-tomorrow"]');
    await scheduleBtn.waitForExist({ timeout: 3000 });
    await scheduleBtn.click();
    await forFlush();

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
  });
});
