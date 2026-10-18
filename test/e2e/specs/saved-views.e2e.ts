/**
 * US-109x / US-109z2 / US-109h: the area filter model (per-area `when`).
 *
 * Tab-level filtering was removed (US-109z2): there is no shared
 * `preset.filters` and no global filter toolbar with tag/date/status popovers.
 * Filtering a content area == editing that area's `when`, reached from the area
 * head's 编辑区域 button → Area panel → 本区过滤. These specs guard that model;
 * the previous saved-view toolbar specs tested UI that no longer exists.
 *
 * Stable DOM:
 *   [data-action="edit-area"]                   — area head 编辑区域 entry
 *   [data-query-editor][data-query-editor-scope="area"] — area editor sheet root
 *   [data-filter-section="area"]                — 本区过滤 section
 *   [data-area-status="all|todo|done|dropped"]  — status chip (all-first)
 *   [data-area-time-field="scheduled|deadline|completed|created"]
 *   [data-area-scheduled="today|…|all"]         — scheduled quick token chip
 *   .bt-area-tag-trigger / .bt-area-tag-popover / .bt-area-tag-list
 *   [data-area-tag="#tag"]                       — tag row inside the popover
 *   [data-action="save-current-view"]           — save dirty draft as a new tab
 *   [data-saved-view-name-input] / [data-action="confirm-saved-view-name"]
 *   [data-action="update-current-view"]         — update the selected tab (dirty)
 *
 * US-109q (Tab 溢出「更多」) is unrelated to filtering — kept verbatim.
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
    await (app as any).plugins.plugins["task-center"].__forFlush();
  });
}

// US-109z2: filtering is per-area, so the reset only needs builtins back and a
// clean board. Saved tabs live in `queryPresets` (not the removed `savedViews`),
// so wipe + reload recreates the builtin presets from defaults each test.
async function resetSavedViewTestState() {
  await browser.executeObsidian(async ({ app }) => {
    // @ts-expect-error — runtime plugin
    const plugin = (app as any).plugins.plugins["task-center"];
    plugin.settings.queryPresets = [];
    plugin.settings.lastSavedViewId = null;
    plugin.settings.lastTab = null;
    await plugin.saveSettings();
    // Reload recreates the builtin query presets internally.
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

// Open the first content area's filter panel (Area panel → 本区过滤). Every
// list/grid/week/month area shares the same head + 编辑区域 entry (US-109p9).
async function openFirstAreaFilter() {
  const edit = await $('[data-action="edit-area"]');
  await edit.waitForExist({ timeout: 5000 });
  await edit.click();
  await $('[data-query-editor-scope="area"]').waitForExist({ timeout: 5000 });
  await $('[data-filter-section="area"]').waitForExist({ timeout: 5000 });
}

describe("US-109x/z2 area filter model", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    await resetSavedViewTestState();
  });

  // US-109h/z2 open the area-editor sheet (an Obsidian Modal) and may not
  // dismiss it; a leftover full-window `.modal-bg` backdrop would then intercept
  // the next test's first click (the `.bt-area-edit` / overflow-tab "element
  // click intercepted" failures). Press Escape until no modal remains (mirrors
  // the in-test Escape idiom used before the save-as step).
  afterEach(async function () {
    for (let i = 0; i < 5 && (await $(".modal-bg").isExisting()); i++) {
      await browser.keys(["Escape"]);
      await $(".modal-bg").waitForExist({ reverse: true, timeout: 1000 }).catch(() => undefined);
    }
  });

  it("US-109c1 #8/#9: plugin reload keeps saved builtin layout and mixed tab order", async function () {
    // resetVault removes the installed plugin assets while the old instance
    // remains in memory. Reinstall through the service before testing reload.
    await browser.reloadObsidian({ vault: VAULT });
    await resetSavedViewTestState();
    await writeAndWait("Tasks/Inbox.md", "- [ ] Reload persistence task\n");
    const saved = await browser.executeObsidian(async ({ app }) => {
      const plugins = (app as any).plugins;
      const plugin = plugins.plugins["task-center"];
      const today = plugin.settings.queryPresets.find((p: any) => p.id === "preset-today");
      today.view = { layout: { type: "list", title: "Persisted layout", limit: 12 } };
      const custom = { id: "sv-reload", name: "Reload test", builtin: false, hidden: false,
        view: { layout: { type: "list" } } };
      plugin.settings.queryPresets = [custom, today,
        ...plugin.settings.queryPresets.filter((p: any) => p.id !== today.id)];
      plugin.settings.defaultSavedViewId = today.id;
      plugin.settings.lastSavedViewId = today.id;
      await plugin.saveSettings();
      return JSON.parse(JSON.stringify(plugin.settings.queryPresets));
    });
    await obsidianPage.disablePlugin("task-center");
    await obsidianPage.enablePlugin("task-center");
    await browser.waitUntil(async () => browser.executeObsidian(({ app }) =>
      !!(app as any).plugins.plugins["task-center"]), {
      timeout: 10000, timeoutMsg: "Task Center did not finish enabling after reload",
    });
    const reloaded = await browser.executeObsidian(({ app }) =>
      (app as any).plugins.plugins["task-center"].settings.queryPresets);
    expect(reloaded).toEqual(saved);
    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-query-tab-id="preset-today"]').click();
    await expect($(".task-center-view")).toHaveText(expect.stringContaining("Persisted layout"));
    const firstTab = await $(".bt-tabbar [data-query-tab-id]").getAttribute("data-query-tab-id");
    expect(firstTab).toBe("sv-reload");
  });

  it("US-109x: editing an area's `when` (tag) filters its cards and saves into a new tab", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Fixture alpha today #alpha ⏳ ${today}`,
        `- [ ] Fixture beta today #beta ⏳ ${today}`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-saved-views], .task-center-view').waitForExist({ timeout: 5000 });
    await $('[data-task-id="Tasks/Inbox.md:L1"]').waitForExist({ timeout: 5000 });

    await openFirstAreaFilter();

    // Tag select is collapsed until clicked, then filters live behind the sheet.
    await expect($(".bt-area-tag-list")).not.toExist();
    await $(".bt-area-tag-trigger").click();
    await $(".bt-area-tag-list").waitForExist({ timeout: 3000 });
    await $('[data-area-tag="#alpha"]').click();

    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).not.toExist();

    // Editing the area `when` makes the tab dirty → save-as a new tab. Close the
    // editor sheet first so the toolbar action is reachable.
    await browser.keys(["Escape"]);
    await $('[data-action="save-current-view"]').waitForExist({ timeout: 3000 });
    await $('[data-action="save-current-view"]').click();
    await $('[data-saved-view-name-input]').setValue("Alpha Area");
    await $('[data-action="confirm-saved-view-name"]').click();
    await forFlush();

    // The persisted tab carries the area `when`, not a tab-level filter.
    const savedJson = await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime plugin
      return JSON.stringify((app as any).plugins.plugins["task-center"].settings.queryPresets);
    });
    expect(savedJson).toContain("Alpha Area");
    expect(savedJson).toContain("#alpha");
  });

  it("US-109h: area status control is all-first and supports multi-select", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Fixture status todo #status-multi ⏳ ${today}`,
        // The default tab is the week view, which buckets cards by their ⏳ date;
        // the done card needs a scheduled date too, or it never enters the grid.
        `- [x] Fixture status done #status-multi ✅ ${today} ⏳ ${today}`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-saved-views], .task-center-view').waitForExist({ timeout: 5000 });
    await openFirstAreaFilter();

    // The default tab's primary area may already carry a status filter (e.g. the
    // week preset defaults to `todo`); the status control correctly reflects the
    // area's real `when`. Reset to a known "all" base so the all-first /
    // multi-select assertions below start from a clean state.
    await $('[data-area-status="all"]').click();

    // Status chips are fixed order, all-first; after the reset the base is "all".
    const statusOptions = await browser.execute(() =>
      Array.from(document.querySelectorAll("[data-area-status]")).map((el) => ({
        value: (el as HTMLElement).dataset.areaStatus,
        active: el.classList.contains("active"),
      })),
    );
    expect(statusOptions.map((o) => o.value)).toEqual(["all", "todo", "done", "dropped"]);
    expect(statusOptions[0]).toEqual({ value: "all", active: true });

    // Narrow to todo → the done card drops out.
    await $('[data-area-status="todo"]').click();
    await expect($('[data-area-status="todo"]')).toHaveElementClass("active");
    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).not.toExist();

    // Add done → multi-select keeps todo selected and both cards show.
    await $('[data-area-status="done"]').click();
    await expect($('[data-area-status="todo"]')).toHaveElementClass("active");
    await expect($('[data-area-status="done"]')).toHaveElementClass("active");
    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).toExist();
  });

  it("US-109z2: area tag select excludes block refs and prose-polluted pseudo tags", async function () {
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        "- [ ] Fixture option source #计划 #安全 [[Spec#Heading]] #^624c3648-bca7-4ee2",
        "- [ ] Fixture punctuation source #第一象限、#第二象限 等。并通过`advance` #示例工具箱",
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-saved-views], .task-center-view').waitForExist({ timeout: 5000 });
    await openFirstAreaFilter();

    await $(".bt-area-tag-trigger").click();
    await $(".bt-area-tag-list").waitForExist({ timeout: 3000 });

    const options = await browser.execute(() =>
      Array.from(document.querySelectorAll("[data-area-tag]")).map((el) => ({
        value: (el as HTMLElement).dataset.areaTag,
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

  // US-109q: desktop "更多" overflow tabs open an in-place dropdown anchored
  // under the button (not a bottom sheet / modal). Clicking a row switches to
  // that tab and closes; outside click and Esc close it; the toggle re-opens.
  it("US-109q: 更多 opens an in-place dropdown that switches tab and closes", async function () {
    // Seed 12 custom presets with long names so the desktop tab bar overflows
    // by WIDTH (US-109q is width-driven, no fixed count cap) regardless of the
    // CI window size — no realistic panel fits 12 long-named tabs on one row.
    await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime plugin
      const plugin = (app as any).plugins.plugins["task-center"];
      const mk = (n: number) => ({
        id: `ovf-${n}`,
        name: `这是一个比较长的溢出测试视图名称${n}`,
        builtin: false,
        hidden: false,
        filters: {},
        view: { layout: { type: "list" } },
        summary: [],
      });
      plugin.settings.queryPresets = Array.from({ length: 12 }, (_, i) => mk(i + 1));
      plugin.settings.defaultSavedViewId = "ovf-1";
      await plugin.saveSettings();
      await Promise.all(
        app.workspace.getLeavesOfType("task-center-board").map((leaf) => leaf.detach()),
      );
    });

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-tab-id="__overflow__"]').waitForExist({ timeout: 5000 });

    // 1. Click 更多 → an in-place dropdown appears anchored under the button,
    //    and it is NOT a bottom sheet / modal.
    await $('[data-tab-id="__overflow__"]').click();
    await $('.bt-overflow-tabs-menu').waitForExist({ timeout: 2000 });
    const openShape = await browser.execute(() => {
      const menu = document.querySelector<HTMLElement>(".bt-overflow-tabs-menu");
      const anchor = document.querySelector<HTMLElement>(".bt-tab-more");
      const cs = menu ? getComputedStyle(menu) : null;
      return {
        nestedUnderMore: !!menu && !!anchor && anchor.contains(menu),
        position: cs?.position ?? "",
        rowCount: document.querySelectorAll(".bt-overflow-tabs-menu .bt-overflow-tab-row").length,
        draggableRows: document.querySelectorAll(
          '.bt-overflow-tabs-menu .bt-overflow-tab-row[draggable="true"]',
        ).length,
        isBottomSheet: !!document.querySelector(".task-center-bottom-sheet .bt-overflow-tabs-sheet"),
        firstRowTabId: document
          .querySelector<HTMLElement>(".bt-overflow-tabs-menu .bt-overflow-tab-row")
          ?.dataset.queryTabId,
      };
    });
    expect(openShape.nestedUnderMore).toBe(true);
    expect(openShape.position).toBe("absolute");
    expect(openShape.rowCount).toBeGreaterThan(0);
    // No drag-to-reorder inside the narrow dropdown.
    expect(openShape.draggableRows).toBe(0);
    expect(openShape.isBottomSheet).toBe(false);

    // 2. Clicking a row switches to that tab and closes the dropdown.
    const targetId = openShape.firstRowTabId;
    await $(`.bt-overflow-tabs-menu .bt-overflow-tab-row[data-query-tab-id="${targetId}"]`).click();
    await browser.waitUntil(
      async () => !(await $('.bt-overflow-tabs-menu').isExisting()),
      { timeout: 2000 },
    );
    const activeId = await browser.executeObsidian(({ app }) => {
      const leaf = app.workspace.getLeavesOfType("task-center-board")[0];
      return (leaf?.view as any)?.state?.savedViewId as string | undefined;
    });
    expect(activeId).toBe(targetId);

    // 3. Re-open, then an outside click closes it.
    await $('[data-tab-id="__overflow__"]').click();
    await $('.bt-overflow-tabs-menu').waitForExist({ timeout: 2000 });
    await browser.execute(() => {
      document.querySelector<HTMLElement>(".task-center-view")?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, composed: true }),
      );
    });
    await browser.waitUntil(
      async () => !(await $('.bt-overflow-tabs-menu').isExisting()),
      { timeout: 2000 },
    );

    // 4. Re-open, then Esc closes it.
    await $('[data-tab-id="__overflow__"]').click();
    await $('.bt-overflow-tabs-menu').waitForExist({ timeout: 2000 });
    await browser.keys(["Escape"]);
    await browser.waitUntil(
      async () => !(await $('.bt-overflow-tabs-menu').isExisting()),
      { timeout: 2000 },
    );
  });
});
