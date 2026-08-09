/**
 * US-720d2 / US-122a: empty-state rendering must not swallow structure.
 *
 * Reproduces two reported bugs:
 *   1. 四象限 (nested col[row[list,list],row[list,list]]) where all four quadrants
 *      are empty used to collapse into ONE centered view-level empty state — the
 *      user saw "只显示一个" instead of four labeled quadrant boxes. US-720d2: each
 *      area renders its own empty state; the four quadrants stay visible.
 *   2. The unscheduled tray, when empty, used to render nothing at all (early
 *      `if (area.onDrop) return`). US-122a: an empty tray shows「没有未排期任务」
 *      and stays a visible drop target.
 *
 * Stable DOM:
 *   .bt-area.bt-area-list                 — a list/grid area box
 *   [data-empty-state="area"]             — per-area empty state
 *   [data-empty-state="view"]             — (removed) old collapsed view-level empty
 *   .bt-tray-empty                        — empty unscheduled tray placeholder
 */
import { browser, expect, $, $$ } from "@wdio/globals";
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

async function resetSavedViewTestState() {
  await browser.executeObsidian(async ({ app }) => {
    // @ts-expect-error — runtime plugin
    const plugin = (app as any).plugins.plugins["task-center"];
    plugin.settings.queryPresets = [];
    plugin.settings.lastSavedViewId = null;
    plugin.settings.lastTab = null;
    await plugin.saveSettings();
    await plugin.loadSettings();
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

describe("US-720d2/US-122a empty-state rendering", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    await resetSavedViewTestState();
  });

  afterEach(async function () {
    for (let i = 0; i < 5 && (await $(".modal-bg").isExisting()); i++) {
      await browser.keys(["Escape"]);
      await $(".modal-bg").waitForExist({ reverse: true, timeout: 1000 }).catch(() => undefined);
    }
  });

  // US-720d2: a four-quadrant view whose four quadrants are all empty must still
  // render four area boxes (each with its own empty state), NOT one collapsed
  // centered view-level empty state.
  it("US-720d2: all-empty four-quadrant keeps four area boxes, not one collapsed empty", async function () {
    // A vault task that matches NONE of the quadrant tags → every quadrant is
    // empty, but the board is non-empty so each area shows its own empty state.
    await writeAndWait("Tasks/Inbox.md", `- [ ] Unquadranted task ⏳ ${todayISO()}\n`);

    await browser.executeObsidian(async ({ app }, layout: unknown) => {
      // @ts-expect-error — runtime plugin
      const plugin = (app as any).plugins.plugins["task-center"];
      // Single preset → exactly one tab, no overflow, auto-active.
      plugin.settings.queryPresets = [{
        id: "preset-matrix-test",
        name: "四象限",
        builtin: false,
        hidden: false,
        view: { layout },
      }];
      plugin.settings.defaultSavedViewId = "preset-matrix-test";
      await plugin.saveSettings();
      await Promise.all(app.workspace.getLeavesOfType("task-center-board").map((leaf) => leaf.detach()));
    }, {
      dir: "col",
      children: [
        { dir: "row", children: [
          { title: "① 紧急 & 重要", type: "list", when: { tags: { expr: "#1象限" }, status: ["todo"] }, emptyText: "无" },
          { title: "② 重要 不紧急", type: "list", when: { tags: { expr: "#2象限" }, status: ["todo"] }, emptyText: "无" },
        ] },
        { dir: "row", children: [
          { title: "③ 紧急 不重要", type: "list", when: { tags: { expr: "#3象限" }, status: ["todo"] }, emptyText: "无" },
          { title: "④ 不紧急 不重要", type: "list", when: { tags: { expr: "#4象限" }, status: ["todo"] }, emptyText: "无" },
        ] },
      ],
    });

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-tab-id="preset-matrix-test"]').waitForExist({ timeout: 5000 });
    await $('[data-tab-id="preset-matrix-test"]').click();
    await forFlush();

    // Four quadrant boxes are rendered (layout not flattened to one area).
    await $(".task-center-view .bt-area.bt-area-list").waitForExist({ timeout: 5000 });
    const areas = await $$(".task-center-view .bt-area.bt-area-list");
    expect(areas.length).toBe(4);

    // Each quadrant shows its OWN empty state; no collapsed view-level empty.
    const perAreaEmpties = await $$('.task-center-view .bt-area-list [data-empty-state="area"]');
    expect(perAreaEmpties.length).toBe(4);
    await expect($('[data-empty-state="view"]')).not.toExist();
    await expect($(".bt-area-empty button")).not.toExist();
    await expect($(".bt-area-empty-icon")).not.toExist();

    // The two row stacks survived normalization (genuine 2D matrix structure).
    const rowStacks = await $$(".task-center-view .bt-stack-col > .bt-stack-row");
    expect(rowStacks.length).toBe(2);
  });

  // US-122a: the unscheduled tray, when there are no unscheduled tasks, must show
  // 「没有未排期任务」 and stay a visible drop zone — not vanish entirely.
  it("US-122a: empty unscheduled tray shows the placeholder instead of vanishing", async function () {
    // Every task is scheduled → the tray (scheduled is empty) projects to zero.
    await writeAndWait("Tasks/Inbox.md", `- [ ] Scheduled only ⏳ ${todayISO()}\n`);

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    const weekTab = $('[data-tab="week"]');
    await weekTab.waitForExist({ timeout: 5000 });
    await weekTab.click();
    await forFlush();

    const tray = $('[data-drop-zone="unscheduled-tray"]');
    await tray.waitForExist({ timeout: 5000 });
    // The empty tray renders a visible placeholder (no longer vanishes). Assert
    // the element exists with non-empty text — locale-agnostic (CI runs in EN:
    // "No unscheduled tasks."; the ZH string is「没有未排期任务」).
    const placeholder = $(".bt-tray-empty");
    await placeholder.waitForExist({ timeout: 5000 });
    expect((await placeholder.getText()).trim().length).toBeGreaterThan(0);
  });
});
