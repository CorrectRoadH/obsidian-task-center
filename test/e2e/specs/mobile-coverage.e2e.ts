import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { setWriteFlavor } from "./_journeys";

/**
 * task #44 (US-501–510): mobile e2e coverage gap-fill.
 *
 * Six mobile-only surfaces reviewer's QA pass called out:
 *   ✅ Week 折叠/展开 (US-503)
 *   ✅ Month inline day schedule (US-504, also covered in mobile-force-layout.e2e.ts)
 *   ✅ Quick Add bottom-sheet styling (US-509)
 *   ✅ 长按 → action sheet (US-506)
 *   ✅ 滑动 done (US-508 left)
 *   ✅ 滑动 drop (US-508 right)
 *   ✅ 移动端无 drag/drop；放弃区不出现在 action bar (US-507)
 *
 * The five gesture / sheet behaviors below are gated on
 * Obsidian core's `Platform.isMobile`. WDIO drives a desktop Chromium
 * instance so that returns false, and the gestures never get attached
 * to the rendered cards. To exercise these paths in the default test
 * runner we use a test-only plugin hook `__setTestForceMobile(true)`
 * that flips a module-level mirror of `Platform.isMobile` consulted
 * by the plugin's own `isMobileMode()` helper. Default value is
 * `false`, so production behavior is unchanged.
 *
 * Each gesture test calls the hook in `before()` (the plugin instance
 * persists across the spec), and resets in `after()` to keep neighbor
 * specs isolated.
 */

const VAULT = "test/e2e/vaults/simple";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Pick a neighbor day guaranteed to fall in the current Mon–Sun week,
 * so the week view always renders both today's column and the target.
 * Sundays use yesterday (Sat) — every other day uses tomorrow.
 * Mirrors the same helper in `drag.e2e.ts`. */
function inWeekNeighbor(): string {
  const d = new Date();
  d.setDate(d.getDate() + (d.getDay() === 0 ? -1 : 1));
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
        // @ts-expect-error — runtime TFile
        const ref = app.metadataCache.on("changed", (file) => {
          if (file.path === p) {
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
    path,
    body,
  );
  // Rebuild the plugin TaskCache for this path. Many specs in this file rewrite
  // the SAME `Tasks/Inbox.md` with different content; without an invalidate the
  // cache keeps a prior spec's stale `path:Ln→hash` entry, so a later
  // `api.done`/`api.drop`/`api.schedule`/`api.nest` resolveRef reports "not a
  // task line" and silently no-ops (the gesture fires but nothing is written).
  // Same fix as cli.e2e.ts's writeAndWait. See ARCHITECTURE.md "TaskCache".
  await browser.executeObsidian(async ({ app }, p: string) => {
    // @ts-expect-error — runtime plugin
    await (app as any).plugins.plugins["task-center"].cache.invalidateFile(p);
    // @ts-expect-error — runtime plugin
    await (app as any).plugins.plugins["task-center"].__forFlush();
  }, path);
}

async function readFile(path: string): Promise<string> {
  return (await browser.executeObsidian(async ({ app }, p: string) => {
    const f = app.vault.getAbstractFileByPath(p);
    if (!f) return "";
    // @ts-expect-error — runtime TFile
    return await app.vault.read(f);
  }, path)) as unknown as string;
}

async function setMobileForceLayout(value: boolean): Promise<void> {
  await browser.executeObsidian(async ({ app }, v: boolean) => {
    // @ts-expect-error — runtime plugin
    const plugin = (app as any).plugins.plugins["task-center"];
    plugin.settings.mobileForceLayout = v;
    await plugin.saveSettings();
  }, value);
}

async function setTestForceMobile(value: boolean): Promise<void> {
  await browser.executeObsidian(async ({ app }, v: boolean) => {
    // @ts-expect-error — runtime plugin
    const plugin = (app as any).plugins.plugins["task-center"];
    if (typeof plugin.__setTestForceMobile === "function") {
      plugin.__setTestForceMobile(v);
    }
  }, value);
}

async function saveMobileShot(name: string): Promise<void> {
  const dir = process.env.TASK_CENTER_MOBILE_SHOT_DIR;
  if (!dir) return;
  try {
    await browser.cdp("Emulation", "setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
  } catch {
    // Electron-backed WDIO sessions do not always expose all window commands.
    // Screenshot capture is optional local evidence; it must not affect CI.
  }
  await browser.pause(100);
  await browser.saveScreenshot(`${dir}/${name}`);
}

async function openMobileBoardWeek() {
  await setMobileForceLayout(true);
  await browser.executeObsidianCommand("task-center:open");
  await forFlush();
  await browser.execute(() => {
    document
      .querySelector<HTMLElement>(".task-center-view [data-tab='week']")
      ?.click();
  });
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          !!document.querySelector(
            ".task-center-view [data-tab='week'].active, .task-center-view [data-tab='week'][aria-selected='true']",
          ),
      ),
    { timeout: 3000, interval: 100, timeoutMsg: "Week tab did not become active" },
  );
}

// US-511: a view's areas are a single-open accordion whose expanded section is
// remembered in-session (so it also carries across tests in the same Obsidian
// instance). A card a test targets can sit inside a currently-collapsed area
// (e.g. the week area after the accordion test opened the unscheduled tray),
// where it renders with a zero-size box and is not interactable. Expand the
// card's own area first so the test is independent of prior accordion state /
// test order. No-op when the card's area is already open.
async function ensureCardVisible(cardSel: string): Promise<void> {
  await browser.execute((sel: string) => {
    const card = document.querySelector<HTMLElement>(sel);
    const area = card?.closest<HTMLElement>(".bt-area-accordion");
    if (area?.classList.contains("bt-area-collapsed")) {
      area.querySelector<HTMLElement>(".bt-area-head")?.click();
    }
  }, cardSel);
  await $(cardSel).waitForDisplayed({ timeout: 3000 });
}

describe("Task Center — mobile coverage gap-fill (task #44)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    // `resetVault` does NOT reset `.obsidian` plugin settings, so a sibling
    // spec that flips `taskFormatFlavor` to "dataview" (dataview-format /
    // format-matrix run alphabetically earlier) leaks it here — then `done`
    // writes `[completion:: …]` and `drop` writes `[cancelled:: …]` instead
    // of the `✅` / `❌` US-508 asserts. Pin the write flavor to emoji so the
    // gesture assertions are deterministic regardless of leak. See
    // wdio.conf.mts "Test isolation" + _journeys.resetForWriteFlavor.
    await setWriteFlavor("tasks");
    // Default: mobile gestures off. Each gesture test flips the hook on
    // explicitly so a missed reset would surface fast.
    await setTestForceMobile(false);
  });

  afterEach(async function () {
    // Obsidian 1.13 can leave a modal mounted briefly after its close button is
    // clicked. Escape + disappearance wait prevents one sheet from intercepting
    // every card click in the following example.
    for (let i = 0; i < 4 && (await $(".modal-bg").isExisting()); i++) {
      await browser.keys(["Escape"]);
      await $(".modal-bg").waitForExist({ reverse: true, timeout: 1000 }).catch(() => undefined);
    }
    // Reset the test hook so a stray failure can't poison the next spec.
    await setTestForceMobile(false);
  });

  // US-503: mobile Week is a vertical list; today's row is expanded by
  // default and other days collapse. Tapping a collapsed day-head
  // expands its tasks. The collapse/expand state machine reads
  // `expandedDays` set in the constructor's mobile branch — running the
  // board with `mobileForceLayout=true` is enough to trip that path
  // without needing the test hook.
  it("US-503: mobile Week — today expanded by default; tapping a collapsed day expands it", async function () {
    const today = todayISO();
    const targetDay = inWeekNeighbor();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Today task ⏳ ${today}\n- [ ] Neighbor task ⏳ ${targetDay}\n`,
    );
    await openMobileBoardWeek();

    await $(`.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`).waitForExist({
      timeout: 5000,
    });

    const expanded = await browser.execute((iso: string) => {
      const day = document.querySelector<HTMLElement>(
        `.task-center-view [data-date="${iso}"]`,
      );
      if (!day) return false;
      const head = day.querySelector<HTMLElement>(".bt-week-head") ?? day;
      head.click();
      return true;
    }, targetDay);
    expect(expanded).toBe(true);

    await $(`.task-center-view [data-task-id="Tasks/Inbox.md:L2"]`).waitForExist({
      timeout: 5000,
      timeoutMsg:
        "US-503: tapping yesterday's collapsed day-head did not surface its task card",
    });
  });

  // US-503: mobile week 的折叠/展开不能制造空白大块；统计数字也必须留在 header。
  it("US-503: mobile Week keeps stats in the row header and empty expanded rows compact", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Mobile week min-height task ⏳ ${today}\n`);
    await openMobileBoardWeek();

    await $(".task-center-view .bt-week").waitForExist({ timeout: 5000 });
    const metrics = await browser.execute((iso: string) => {
      const todayRow = document.querySelector<HTMLElement>(`.task-center-view [data-date="${iso}"]`)!;
      const head = todayRow.querySelector<HTMLElement>(".bt-week-head")!;
      const stats = todayRow.querySelector<HTMLElement>(".bt-week-stats")!;
      const emptyRow = Array.from(document.querySelectorAll<HTMLElement>(".task-center-view .bt-week-col"))
        .find((row) => row.dataset.date !== iso && !row.querySelector(".bt-card"))!;
      const emptyHead = emptyRow.querySelector<HTMLElement>(".bt-week-head")!;
      return {
        statsParentIsHead: stats.parentElement === head,
        emptyRowHeight: emptyRow.getBoundingClientRect().height,
        emptyHeadHeight: emptyHead.getBoundingClientRect().height,
      };
    }, today);

    expect(metrics.statsParentIsHead).toBe(true);
    expect(metrics.emptyRowHeight).toBeLessThanOrEqual(metrics.emptyHeadHeight + 4);
  });

  // US-511: a view's content areas are a single-open accordion. Week (the
  // first content area) is expanded by default; opening another area's head
  // collapses the rest.
  it("US-511: mobile areas are a single-open accordion (week open by default; opening another collapses it)", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Scheduled today ⏳ ${today}\n- [ ] No schedule task\n`,
    );
    await openMobileBoardWeek();

    await $(".task-center-view .bt-area-accordion").waitForExist({ timeout: 5000 });

    // Default: exactly the first accordion area (week) is expanded.
    const initial = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".task-center-view .bt-area-accordion"))
        .map((a) => a.classList.contains("bt-area-collapsed")),
    );
    expect(initial.length).toBeGreaterThanOrEqual(2);
    expect(initial[0]).toBe(false);
    expect(initial.slice(1).every(Boolean)).toBe(true);

    // Tapping the second area's head opens it and collapses the first.
    await browser.execute(() => {
      const areas = Array.from(
        document.querySelectorAll<HTMLElement>(".task-center-view .bt-area-accordion"),
      );
      areas[1]?.querySelector<HTMLElement>(".bt-area-head")?.click();
    });
    const after = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".task-center-view .bt-area-accordion"))
        .map((a) => a.classList.contains("bt-area-collapsed")),
    );
    expect(after[0]).toBe(true);
    expect(after[1]).toBe(false);
  });

  it("US-505: mobile task check circles align with the first title line", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Alignment parent task ⏳ ${today}\n    - [ ] Alignment child task\n`,
    );
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await ensureCardVisible(cardSel);

    const metrics = await browser.execute((sel: string) => {
      const card = document.querySelector<HTMLElement>(sel)!;
      const check = card.querySelector<HTMLElement>(".bt-check")!;
      const title = card.querySelector<HTMLElement>(".bt-card-title")!;
      const sub = card.querySelector<HTMLElement>(".bt-subcard")!;
      const subCheck = sub.querySelector<HTMLElement>(".bt-sub-check")!;
      const subTitle = sub.querySelector<HTMLElement>(".bt-subcard-title")!;
      const titleFirstLineCenter = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const lineHeight = Number.parseFloat(style.lineHeight);
        const paddingTop = Number.parseFloat(style.paddingTop);
        return rect.top + paddingTop + lineHeight / 2;
      };
      const center = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        return rect.top + rect.height / 2;
      };
      return {
        cardDiff: Math.abs(center(check) - titleFirstLineCenter(title)),
        subDiff: Math.abs(center(subCheck) - titleFirstLineCenter(subTitle)),
      };
    }, cardSel);

    expect(metrics.cardDiff).toBeLessThanOrEqual(2);
    expect(metrics.subDiff).toBeLessThanOrEqual(2);
  });

  // US-504: Month tap-to-select inline day schedule — already
  // automated in mobile-force-layout.e2e.ts (task #42 fix). Marker test
  // makes the coverage map grep-able from this file.
  it("US-504: Month inline day panel covered by mobile-force-layout.e2e.ts (task #42 fix)", function () {
    expect(true).toBe(true);
  });

  // US-509: mobile Quick Add carries the bottom-sheet styling
  // (`task-center-bottom-sheet` modal class).
  it("US-509: mobile Quick Add opens with the bottom-sheet styling", async function () {
    await setTestForceMobile(true);
    await setMobileForceLayout(true);

    await browser.executeObsidianCommand("task-center:quick-add");

    const opened = await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.querySelector(
              ".modal.task-center-bottom-sheet, .task-center-bottom-sheet",
            ),
        ),
      {
        timeout: 3000,
        timeoutMsg: "US-509: Quick Add did not open with bottom-sheet class",
      },
    );
    expect(opened).toBe(true);

    // Close the modal and prove it is gone before the next test starts.
    await browser.keys(["Escape"]);
    await $(".modal-bg").waitForExist({ reverse: true, timeout: 3000 });
  });

  it("US-506a/US-507a: tapping a mobile card opens details, and scheduling uses tap-only dates", async function () {
    await setTestForceMobile(true);
    const target = inWeekNeighbor();
    const path = "Tasks/Inbox.md";
    await writeAndWait(path, "- [ ] Mobile detail target\n");
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await ensureCardVisible(cardSel);
    await $(cardSel).click();

    await $(".task-center-bottom-sheet .bt-mobile-task-detail").waitForExist({
      timeout: 3000,
      timeoutMsg: "US-506a: tapping mobile card did not open task detail sheet",
    });
    await expect($(".task-center-bottom-sheet [data-mobile-detail-action='source']")).toExist();
    await expect($("[data-source-edit-shell]")).not.toExist();

    await $(".task-center-bottom-sheet [data-mobile-detail-action='schedule']").click();
    await $(".task-center-bottom-sheet .bt-mobile-date-sheet").waitForExist({
      timeout: 3000,
      timeoutMsg: "US-507a: schedule did not open tap-only date sheet",
    });
    await expect($(".task-center-bottom-sheet .bt-mobile-date-sheet input")).not.toExist();
    const dateSheetMetrics = await browser.execute(() => {
      const sheet = document.querySelector<HTMLElement>(".task-center-bottom-sheet .bt-mobile-date-sheet")!;
      const grid = sheet.querySelector<HTMLElement>(".bt-date-calendar-grid")!;
      const sheetRect = sheet.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      return {
        gridDisplay: getComputedStyle(grid).display,
        gridColumns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
        gridFitsSheet: gridRect.left >= sheetRect.left && gridRect.right <= sheetRect.right + 1,
      };
    });
    expect(dateSheetMetrics.gridDisplay).toBe("grid");
    expect(dateSheetMetrics.gridColumns).toBe(7);
    expect(dateSheetMetrics.gridFitsSheet).toBe(true);
    await $(`.task-center-bottom-sheet [data-date-choice="${target}"]`).click();

    await browser.waitUntil(
      async () => (await readFile(path)).includes(`⏳ ${target}`),
      {
        timeout: 5000,
        timeoutMsg: "US-507a: tapping a date choice did not write scheduled date",
      },
    );
  });

  it("US-168g/US-506: mobile source action opens Obsidian's native Markdown editor at the task line", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    const path = "Tasks/Mobile Source.md";
    await writeAndWait(
      path,
      [`# Native source`, ``, `- [ ] Mobile native source target ⏳ ${today}`, ``].join("\n"),
    );
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="${path}:L3"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await ensureCardVisible(cardSel);
    await $(cardSel).click();
    await $(".task-center-bottom-sheet .bt-mobile-task-detail").waitForExist({ timeout: 3000 });
    await $(".task-center-bottom-sheet [data-mobile-detail-action='source']").click();

    const opened = await browser.waitUntil(
      async () => {
        const state = (await browser.executeObsidian(({ app }) => {
          const view = app.workspace.activeLeaf?.view as unknown as {
            getViewType?: () => string;
            file?: { path?: string };
            editor?: { getCursor: () => { line: number } };
          } | null;
          return {
            path: view?.file?.path,
            viewType: view?.getViewType?.(),
            line: view?.editor?.getCursor?.().line,
            hasSourceShell: !!document.querySelector("[data-source-edit-shell]"),
          };
        })) as unknown as { path?: string; viewType?: string; line?: number; hasSourceShell: boolean };
        return state.path === path && state.viewType === "markdown" && state.line === 2 && !state.hasSourceShell;
      },
      {
        timeout: 5000,
        interval: 100,
        timeoutMsg: "US-168g: mobile source action did not open native MarkdownView at the task line",
      },
    );
    expect(opened).toBe(true);
    await saveMobileShot("mobile-source-native.png");
  });

  it("US-506b: mobile tag editor manages current, suggested, and typed tags without a raw-only input", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    const path = "Tasks/Mobile Tags.md";
    await writeAndWait(
      path,
      [
        `- [ ] Mobile tag target #old ⏳ ${today}`,
        `- [ ] Suggestion source #next ⏳ ${today}`,
        ``,
      ].join("\n"),
    );
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await ensureCardVisible(cardSel);
    await $(cardSel).click();
    await $(".task-center-bottom-sheet .bt-mobile-task-detail").waitForExist({ timeout: 3000 });
    await $(".task-center-bottom-sheet [data-mobile-detail-action='tag']").click();

    await $(".task-center-bottom-sheet .bt-mobile-tag-sheet").waitForExist({
      timeout: 3000,
      timeoutMsg: "US-506b: tag action did not open the tag management sheet",
    });
    await expect($(`.task-center-bottom-sheet [data-tag-chip="#old"]`)).toExist();
    await expect($(`.task-center-bottom-sheet [data-tag-suggestion="#next"]`)).toExist();
    await saveMobileShot("mobile-tag-editor.png");

    await $(`.task-center-bottom-sheet [data-tag-chip="#old"]`).click();
    await $(`.task-center-bottom-sheet [data-tag-suggestion="#next"]`).click();
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(".task-center-bottom-sheet .bt-tag-editor-input");
      if (!input) throw new Error("tag input missing");
      input.value = "newtag";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      document.querySelector<HTMLElement>(".task-center-bottom-sheet .bt-tag-editor-add")?.click();
    });
    await $(".task-center-bottom-sheet .bt-tag-editor-save").click();

    await browser.waitUntil(
      async () => {
        const firstLine = (await readFile(path)).split("\n")[0] ?? "";
        return firstLine.includes("#next") && firstLine.includes("#newtag") && !firstLine.includes("#old");
      },
      {
        timeout: 5000,
        timeoutMsg: "US-506b: saving tag sheet did not apply add/remove tag diff",
      },
    );
  });

  it("US-507b: mobile parent picker shows context, requires confirmation, and nests with undoable writer semantics", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    const path = "Tasks/Mobile Nest.md";
    await writeAndWait(
      path,
      [
        `- [ ] Mobile parent candidate #parent ⏳ ${today}`,
        `    - [ ] Existing child under parent`,
        `- [ ] Mobile child target #child ⏳ ${today}`,
        ``,
      ].join("\n"),
    );
    await openMobileBoardWeek();

    const childId = `${path}:L3`;
    const parentId = `${path}:L1`;
    await $(`.task-center-view [data-task-id="${childId}"]`).waitForExist({ timeout: 5000 });
    await ensureCardVisible(`.task-center-view [data-task-id="${childId}"]`);
    await $(`.task-center-view [data-task-id="${childId}"]`).click();
    await $(".task-center-bottom-sheet .bt-mobile-task-detail").waitForExist({ timeout: 3000 });
    await $(".task-center-bottom-sheet [data-mobile-detail-action='nest']").click();

    await $(".task-center-bottom-sheet [data-parent-picker='true']").waitForExist({
      timeout: 3000,
      timeoutMsg: "US-507b: nest action did not open the parent picker",
    });
    await expect($(".task-center-bottom-sheet [data-parent-confirm='true']")).toBeDisabled();

    const pickerState = await browser.execute((selfId: string, candidateId: string) => {
      const picker = document.querySelector<HTMLElement>(".task-center-bottom-sheet [data-parent-picker='true']");
      const search = picker?.querySelector<HTMLInputElement>(".bt-parent-picker-search");
      const self = picker?.querySelector<HTMLButtonElement>(`[data-parent-candidate-id="${selfId}"]`);
      const candidate = picker?.querySelector<HTMLElement>(`[data-parent-candidate-id="${candidateId}"]`);
      const groups = Array.from(picker?.querySelectorAll<HTMLElement>(".bt-parent-picker-group-title") ?? [])
        .map((el) => el.textContent ?? "");
      return {
        searchIsNotAutoFocused: document.activeElement !== search,
        selfDisabled: self?.disabled ?? false,
        candidateText: candidate?.textContent ?? "",
        groups,
      };
    }, childId, parentId);
    expect(pickerState.searchIsNotAutoFocused).toBe(true);
    expect(pickerState.selfDisabled).toBe(true);
    expect(pickerState.candidateText).toContain("Mobile parent candidate");
    expect(pickerState.candidateText).toContain("Mobile Nest.md:L1");
    expect(pickerState.candidateText).toContain("#parent");
    expect(pickerState.groups.length).toBeGreaterThan(0);

    await $(`.task-center-bottom-sheet [data-parent-candidate-id="${parentId}"]`).click();
    await expect($(".task-center-bottom-sheet [data-parent-confirm='true']")).toBeEnabled();
    await $(".task-center-bottom-sheet [data-parent-confirm='true']").click();

    await browser.waitUntil(
      async () => {
        const content = await readFile(path);
        return content.includes("    - [ ] Mobile child target #child") && !content.includes("Mobile child target #child ⏳");
      },
      {
        timeout: 5000,
        timeoutMsg: "US-507b: confirming parent picker did not nest and clear the child's own schedule",
      },
    );
  });

  // US-506: long-press on a card opens the action sheet
  // (`.task-center-bottom-sheet`). The plugin's settings define the
  // duration; we read it at runtime so the test stays honest after
  // a tweak.
  it("US-506: long-press on a card opens the bottom-sheet action menu", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Long-press target ⏳ ${today}\n`);
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await ensureCardVisible(cardSel);

    const duration = (await browser.executeObsidian(
      ({ app }) =>
        // @ts-expect-error — runtime plugin
        (app as any).plugins.plugins["task-center"].settings
          .mobileLongPressMs ?? 500,
    )) as unknown as number;

    await browser.execute((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) throw new Error("card not found");
      const rect = el.getBoundingClientRect();
      const ev = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
        pointerId: 1,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
        isPrimary: true,
      });
      el.dispatchEvent(ev);
    }, cardSel);

    await browser.pause(duration + 150);
    await $(".task-center-bottom-sheet").waitForExist({
      timeout: 1500,
      timeoutMsg: "US-506: long-press did not open the action sheet",
    });

    await browser.execute(() => {
      window.dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 1, isPrimary: true }),
      );
      const close = document.querySelector<HTMLElement>(".modal-close-button");
      close?.click();
    });
  });

  it("US-508: swipe feedback appears only after half-card threshold and can be cancelled", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    const path = "Tasks/Inbox.md";
    await writeAndWait(path, `- [ ] Swipe-threshold target ⏳ ${today}\n`);
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await ensureCardVisible(cardSel);

    const states = await browser.execute((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) throw new Error("card not found");
      const rect = el.getBoundingClientRect();
      const startX = rect.left + rect.width * 0.85;
      const startY = rect.top + rect.height / 2;
      const mk = (type: string, x: number, y: number) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
          pointerId: 6,
          clientX: x,
          clientY: y,
          button: 0,
          isPrimary: true,
        });
      el.dispatchEvent(mk("pointerdown", startX, startY));
      window.dispatchEvent(mk("pointermove", startX - rect.width * 0.4, startY));
      const beforeHalf = el.dataset.swipeReady ?? "";
      window.dispatchEvent(mk("pointermove", startX - rect.width * 0.55, startY));
      const afterHalf = el.dataset.swipeReady ?? "";
      const label = el.dataset.swipeLabel ?? "";
      window.dispatchEvent(mk("pointermove", startX - rect.width * 0.1, startY));
      const afterReturn = el.dataset.swipeReady ?? "";
      window.dispatchEvent(mk("pointerup", startX - rect.width * 0.1, startY));
      return { beforeHalf, afterHalf, afterReturn, label };
    }, cardSel);

    expect(states.beforeHalf).toBe("");
    expect(states.afterHalf).toBe("true");
    expect(states.label).toContain("Done");
    expect(states.afterReturn).toBe("");
    const content = await readFile(path);
    expect(content).toContain("- [ ] Swipe-threshold target");
    expect(content).not.toMatch(/^- \[x\] Swipe-threshold target/m);
  });

  // US-508 (left): swipe a card past the 50% threshold leftward to mark
  // it done — markdown line should carry `[x]` after the gesture.
  it("US-508: swipe-left past threshold marks the task done", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    const path = "Tasks/Inbox.md";
    await writeAndWait(path, `- [ ] Swipe-left target ⏳ ${today}\n`);
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await ensureCardVisible(cardSel);

    await browser.execute((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) throw new Error("card not found");
      const rect = el.getBoundingClientRect();
      const startX = rect.left + rect.width * 0.85;
      const startY = rect.top + rect.height / 2;
      const endX = rect.left + rect.width * 0.05;
      const mk = (type: string, x: number, y: number) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
          pointerId: 7,
          clientX: x,
          clientY: y,
          button: 0,
          isPrimary: true,
        });
      el.dispatchEvent(mk("pointerdown", startX, startY));
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const x = startX + ((endX - startX) * i) / steps;
        window.dispatchEvent(mk("pointermove", x, startY));
      }
      window.dispatchEvent(mk("pointerup", endX, startY));
    }, cardSel);

    await browser.waitUntil(
      async () => {
        const c = await readFile(path);
        return /^- \[x\] Swipe-left target/m.test(c);
      },
      {
        timeout: 5000,
        timeoutMsg: "US-508 (left): swipe did not mark the task done within 5s",
      },
    );
  });

  // US-508 (right): swipe-right past the 50% threshold drops the task (`[-] ❌`).
  it("US-508: swipe-right past threshold drops the task", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    const path = "Tasks/Inbox.md";
    await writeAndWait(path, `- [ ] Swipe-right target ⏳ ${today}\n`);
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await ensureCardVisible(cardSel);

    await browser.execute((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) throw new Error("card not found");
      const rect = el.getBoundingClientRect();
      const startX = rect.left + rect.width * 0.05;
      const startY = rect.top + rect.height / 2;
      const endX = rect.left + rect.width * 0.95;
      const mk = (type: string, x: number, y: number) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
          pointerId: 8,
          clientX: x,
          clientY: y,
          button: 0,
          isPrimary: true,
        });
      el.dispatchEvent(mk("pointerdown", startX, startY));
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const x = startX + ((endX - startX) * i) / steps;
        window.dispatchEvent(mk("pointermove", x, startY));
      }
      window.dispatchEvent(mk("pointerup", endX, startY));
    }, cardSel);

    await browser.waitUntil(
      async () => {
        const c = await readFile(path);
        return /^- \[-\] Swipe-right target.*❌/m.test(c);
      },
      {
        timeout: 5000,
        timeoutMsg: "US-508 (right): swipe did not drop the task within 5s",
      },
    );
  });

  // US-507: mobile deliberately has no task drag/drop. Holding a card and
  // moving over another day should cancel long-press / allow scroll, not
  // reschedule. The mobile action bar must not expose an abandon drop zone.
  it("US-507: mobile has no drag/drop or abandon drop zone", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    const targetDay = inWeekNeighbor();
    const path = "Tasks/Inbox.md";
    await writeAndWait(path, `- [ ] Mobile no-drag target ⏳ ${today}\n`);
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    const targetSel = `.task-center-view [data-date="${targetDay}"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await ensureCardVisible(cardSel);
    await $(targetSel).waitForExist({ timeout: 5000 });
    await expect($(`.bt-mobile-trash[data-drop-zone="abandon"]`)).not.toExist();
    await expect($(cardSel)).not.toHaveAttribute("draggable", "true");

    await browser.execute((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) throw new Error("card not found");
      const rect = el.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;
      el.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
          pointerId: 9,
          clientX: startX,
          clientY: startY,
          button: 0,
          isPrimary: true,
        }),
      );
    }, cardSel);
    await browser.pause(300);

    await browser.execute(
      (src: string, tgt: string) => {
        const srcEl = document.querySelector<HTMLElement>(src);
        const tgtEl = document.querySelector<HTMLElement>(tgt);
        if (!srcEl || !tgtEl) throw new Error("missing src/tgt");
        const srcRect = srcEl.getBoundingClientRect();
        const tgtRect = tgtEl.getBoundingClientRect();
        const startX = srcRect.left + srcRect.width / 2;
        const startY = srcRect.top + srcRect.height / 2;
        const endX = startX;
        const endY = tgtRect.top + tgtRect.height / 2;
        const mk = (type: string, x: number, y: number) =>
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: "touch",
            pointerId: 9,
            clientX: x,
            clientY: y,
            button: 0,
            isPrimary: true,
          });
        window.dispatchEvent(mk("pointermove", endX, endY));
        window.dispatchEvent(mk("pointerup", endX, endY));
      },
      cardSel,
      targetSel,
    );

    await browser.pause(500);
    const content = await readFile(path);
    expect(content).toContain(`Mobile no-drag target ⏳ ${today}`);
    expect(content).not.toContain(targetDay);
    expect(content).not.toMatch(/^- \[-\] Mobile no-drag target.*❌/m);
    const cloneCount = await browser.execute(
      () => document.querySelectorAll(".bt-mobile-drag-clone, .tc-mobile-drag-clone").length,
    );
    expect(cloneCount).toBe(0);
  });
});
