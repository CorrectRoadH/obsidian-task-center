import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { mkdir } from "node:fs/promises";

const VAULT = "test/e2e/vaults/simple";

async function fixture(areas?: unknown[], body = "- [ ] closure one [estimate:: 1h]\n- [x] closure two [estimate:: 1h] [actual:: 3h]\n- [ ] closure three\n- [ ] closure four\n- [ ] closure five\n") {
  await browser.executeObsidian(async ({ app }, areas, body) => {
    const plugin = (app as any).plugins.plugins["task-center"];
    const path = "Tasks/closure.md";
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing) await app.vault.modify(existing as any, body);
    else await app.vault.create(path, body);
    await plugin.cache.invalidateFile(path);
    await plugin.__forFlush();
    plugin.settings.queryPresets = [
      { id: "closure-a", name: "Closure A", view: { layout: { dir: "col", children: areas ?? [
        { type: "list", title: "Limited", when: { search: "closure" }, limit: 3 },
        { type: "grid", title: "Other", when: { search: "closure" }, limit: 2 },
      ] } } },
      { id: "closure-b", name: "Closure B", view: { layout: { type: "list", when: { search: "closure" } } } },
    ];
    plugin.settings.lastSavedViewId = "closure-a";
    plugin.settings.defaultSavedViewId = "closure-b";
    await plugin.saveSettings();
    for (const leaf of app.workspace.getLeavesOfType("task-center-board")) leaf.detach();
  }, areas, body);
  await browser.executeObsidianCommand("task-center:open");
  await expect($(".task-center-view")).toExist();
}

describe("Board closure regressions", () => {
  beforeEach(async () => {
    await browser.keys("Escape");
    await obsidianPage.resetVault(VAULT);
  });

  it("US-720b / US-303: expands only this area and shows totals before limiting", async () => {
    await fixture();
    await expect($('[data-area-more="0"]')).toHaveText(/2/);
    await expect($('[data-area-more="1"]')).toHaveText(/3/);
    await expect($('[data-area-head="0"] .bt-area-summary')).toHaveText(/5.*2h.*3h.*300%/);
    await $('[data-area-more="0"]').click();
    await expect($('[data-area-more="0"]')).not.toExist();
    await expect($('[data-area-more="1"]')).toExist();
    await mkdir("test/e2e/screenshots", { recursive: true });
    await browser.saveScreenshot("test/e2e/screenshots/board-closure-expanded.png");
  });

  it("US-166: slash opens first filterable area and focuses its search; Ctrl+2 switches tabs", async () => {
    await fixture([{ type: "drop" }, { type: "grid", when: { search: "closure" } }]);
    await browser.execute(() => { (document.querySelector(".task-center-view") as HTMLElement).focus(); });
    await browser.keys("/");
    await expect($("[data-query-editor-scope='area'] .bt-area-search")).toBeFocused();
    await browser.keys("Escape");
    await expect($("[data-query-editor-scope='area']")).not.toExist();
    await browser.execute(() => { (document.querySelector(".task-center-view") as HTMLElement).focus(); });
    await browser.keys(["Control", "2"]);
    const id = await browser.executeObsidian(({ app }) => (app.workspace.getLeavesOfType("task-center-board")[0].view as any).state.savedViewId);
    expect(id).toBe("closure-b");
  });

  it("US-405 / US-120: missing remembered tab falls back to default, then first visible", async () => {
    await fixture();
    const ids = await browser.executeObsidian(({ app }) => {
      const view = app.workspace.getLeavesOfType("task-center-board")[0].view as any;
      view.plugin.settings.lastSavedViewId = "deleted";
      const fallback = view.initialSavedViewFromSettings().id;
      view.plugin.settings.queryPresets[1].hidden = true;
      return [fallback, view.initialSavedViewFromSettings().id];
    });
    expect(ids).toEqual(["closure-b", "closure-a"]);
  });

  it("US-109s: desktop tab draft survives switching but not board close or plugin reload", async () => {
    // resetVault removes installed assets; reinstall before exercising plugin reload.
    await browser.reloadObsidian({ vault: VAULT });
    await fixture();
    await browser.executeObsidian(({ app }) => {
      const view = app.workspace.getLeavesOfType("task-center-board")[0].view as any;
      view.setAreaWhen(0, { search: "closure one" });
    });
    await $('[data-query-tab-id="closure-b"]').click();
    await $(".bt-confirm-row button:nth-child(2)").click();
    expect(await browser.executeObsidian(({ app }) => (app.workspace.getLeavesOfType("task-center-board")[0].view as any).state.savedViewId)).toBe("closure-b");
    await $('[data-query-tab-id="closure-a"]').click();
    const draft = await browser.executeObsidian(({ app }) => (app.workspace.getLeavesOfType("task-center-board")[0].view as any).currentQueryPresetViewConfig().layout.children[0].when.search);
    expect(draft).toBe("closure one");
    await browser.executeObsidian(({ app }) => { app.workspace.getLeavesOfType("task-center-board")[0].detach(); });
    await browser.executeObsidianCommand("task-center:open");
    expect(await browser.executeObsidian(({ app }) => (app.workspace.getLeavesOfType("task-center-board")[0].view as any).tabDrafts.size)).toBe(0);
    await browser.executeObsidian(async ({ app }) => {
      const view = app.workspace.getLeavesOfType("task-center-board")[0].view as any;
      view.setAreaWhen(0, { search: "temporary" });
      await (app as any).plugins.disablePlugin("task-center");
      await (app as any).plugins.enablePlugin("task-center");
    });
    await browser.executeObsidianCommand("task-center:open");
    expect(await browser.executeObsidian(({ app }) => (app.workspace.getLeavesOfType("task-center-board")[0].view as any).tabDrafts.size)).toBe(0);
  });

  it("US-109b: emptyText overrides built-in empty list, grid and tray messages", async () => {
    await fixture([
      { type: "list", when: { search: "no-match" }, emptyText: "Custom list" },
      { type: "grid", when: { search: "no-match" }, emptyText: "Custom grid" },
      { type: "list", when: { search: "no-match" }, onDrop: { clearScheduled: true }, emptyText: "Custom tray" },
    ]);
    const text = await $(".task-center-view").getText();
    expect(text).toContain("Custom list");
    expect(text).toContain("Custom grid");
    expect(text).toContain("Custom tray");
  });

  it("US-128: checkbox completion and cancellation each undo through the board stack", async () => {
    await fixture();
    const result = await browser.executeObsidian(async ({ app }) => {
      const view = app.workspace.getLeavesOfType("task-center-board")[0].view as any;
      const task = view.getEffectiveTasks().find((t: any) => t.path === "Tasks/closure.md" && t.line === 0);
      await view.toggleDone(task);
      const size = view.undoStack.size();
      await view.undoStack.pop();
      const file = app.vault.getAbstractFileByPath(task.path) as any;
      const text = await app.vault.read(file);
      const done = view.getEffectiveTasks().find((t: any) => t.path === task.path && t.line === 1);
      await view.toggleDone(done);
      const cancellationSize = view.undoStack.size();
      const cancelled = await app.vault.read(file);
      await view.undoStack.pop();
      return { size, text, cancellationSize, cancelled, restored: await app.vault.read(file) };
    });
    expect(result.size).toBe(1);
    expect(result.text.startsWith("- [ ] closure one")).toBe(true);
    expect(result.cancellationSize).toBe(1);
    expect(result.cancelled).toContain("- [ ] closure two");
    expect(result.restored).toBe(result.text);
  });
  it("US-128: tag edits and nesting restore their original Markdown", async () => {
    await fixture(undefined, "- [ ] closure parent #old\n- [ ] closure child\n");
    const result = await browser.executeObsidian(async ({ app }) => {
      const view = app.workspace.getLeavesOfType("task-center-board")[0].view as any;
      const path = "Tasks/closure.md";
      const file = app.vault.getAbstractFileByPath(path) as any;
      const before = await app.vault.read(file);
      const parent = view.getEffectiveTasks().find((t: any) => t.path === path && t.line === 0);
      await view.applyTagEditResult(parent, { remove: ["#old"], add: ["#new"] });
      const tagged = await app.vault.read(file);
      await view.undoStack.pop();
      const restoredTags = await app.vault.read(file);
      await view.plugin.cache.invalidateFile(path);
      await view.reloadTasks();
      const child = view.getEffectiveTasks().find((t: any) => t.path === path && t.line === 1);
      await view.nestFromMobile(child, parent.id);
      const nested = await app.vault.read(file);
      await view.undoStack.pop();
      return { before, tagged, restoredTags, nested, restoredNest: await app.vault.read(file) };
    });
    expect(result.tagged).toContain("#new");
    expect(result.restoredTags).toBe(result.before);
    expect(result.nested).not.toBe(result.before);
    expect(result.restoredNest).toBe(result.before);
  });

  it("US-128: real drop listeners record schedule and abandon writes for undo", async () => {
    await fixture([{ type: "list", when: { search: "closure" } }, { type: "drop" }]);
    const result = await browser.executeObsidian(async ({ app }) => {
      const view = app.workspace.getLeavesOfType("task-center-board")[0].view as any;
      const path = "Tasks/closure.md";
      const file = app.vault.getAbstractFileByPath(path) as any;
      const before = await app.vault.read(file);
      const task = view.getEffectiveTasks().find((t: any) => t.path === path && t.line === 0);
      const target = view.contentEl.createDiv();
      view.makeDropZone(target, "2099-01-01");
      const data = new DataTransfer(); data.setData("text/task-id", task.id);
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true }));
      for (let i = 0; i < 100 && !view.undoStack.size(); i++) await new Promise(r => setTimeout(r, 25));
      const scheduled = await app.vault.read(file);
      await view.undoStack.pop();
      const restoredSchedule = await app.vault.read(file);
      await view.plugin.cache.invalidateFile(path);
      await view.reloadTasks();
      const trash = view.contentEl.querySelector('[data-drop-zone="abandon"]');
      trash.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true }));
      for (let i = 0; i < 100 && !view.undoStack.size(); i++) await new Promise(r => setTimeout(r, 25));
      const dropped = await app.vault.read(file);
      await view.undoStack.pop();
      return { before, scheduled, restoredSchedule, dropped, restoredDrop: await app.vault.read(file) };
    });
    expect(result.scheduled).toContain("2099-01-01");
    expect(result.restoredSchedule).toBe(result.before);
    expect(result.dropped).toContain("[-]");
    expect(result.restoredDrop).toBe(result.before);
  });

  it("US-128: Quick Add records only its board-created line for undo", async () => {
    await fixture();
    await browser.executeObsidian(async ({ app }) => {
      const dn = (app as any).internalPlugins.plugins["daily-notes"];
      if (!dn.enabled) await dn.enable();
      dn.instance.options.folder = "Daily";
      dn.instance.options.format = "YYYY-MM-DD";
      if (!app.vault.getAbstractFileByPath("Daily")) await app.vault.createFolder("Daily");
    });
    await browser.waitUntil(async () => !(await $(".notice-container .notice").isExisting()), { timeout: 15000 });
    await $(".bt-add-btn").click();
    await $(".task-center-quick-add-input").setValue("closure quick add undo");
    await browser.keys("Enter");
    await expect($(".task-center-quick-add-input")).not.toExist();
    const result = await browser.executeObsidian(async ({ app }) => {
      const view = app.workspace.getLeavesOfType("task-center-board")[0].view as any;
      const size = view.undoStack.size();
      const files = app.vault.getMarkdownFiles().filter(f => f.path.startsWith("Daily/"));
      const before = await Promise.all(files.map(f => app.vault.read(f)));
      await view.undoStack.pop();
      const after = await Promise.all(files.map(f => app.vault.read(f)));
      return { size, before: before.join("\n"), after: after.join("\n") };
    });
    expect(result.size).toBe(1);
    expect(result.before).toContain("closure quick add undo");
    expect(result.after).not.toContain("closure quick add undo");
  });

  it("US-701d/e/f: warning links to community settings and clears without a layout event", async () => {
    await fixture();
    const result = await browser.executeObsidian(async ({ app }) => {
      const plugins = (app as any).plugins;
      const ids = ["dataview", "obsidian-tasks-plugin"];
      const original = ids.map(id => ({ id, manifest: plugins.manifests[id], plugin: plugins.plugins[id] }));
      const delay = () => new Promise(r => setTimeout(r, 1100));
      try {
        for (const id of ids) { delete plugins.manifests[id]; delete plugins.plugins[id]; }
        await delay();
        const missing = document.querySelector<HTMLElement>('[data-dep-warning="task-format-companion-missing"]');
        missing?.click();
        const settingsTab = (app as any).setting.activeTab?.id;
        (app as any).setting.close();
        plugins.manifests.dataview = { id: "dataview" };
        await delay();
        const disabled = !!document.querySelector('[data-dep-warning="task-format-companion-disabled"]');
        plugins.plugins.dataview = {};
        await delay();
        const cleared = !document.querySelector('[data-dep-warning^="task-format-"]');
        return { missing: !!missing, settingsTab, disabled, cleared };
      } finally {
        for (const { id, manifest, plugin } of original) {
          if (manifest) plugins.manifests[id] = manifest; else delete plugins.manifests[id];
          if (plugin) plugins.plugins[id] = plugin; else delete plugins.plugins[id];
        }
      }
    });
    expect(result).toEqual({ missing: true, settingsTab: "community-plugins", disabled: true, cleared: true });
  });

});
