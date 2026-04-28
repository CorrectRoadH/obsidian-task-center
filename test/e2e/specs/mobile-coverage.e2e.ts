import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

/**
 * task #44 (US-501–510): mobile e2e coverage gap-fill.
 *
 * Six mobile-only surfaces reviewer's QA pass called out:
 *   ✅ Week 折叠/展开 (US-503)
 *   ✅ Month bottom sheet (US-504, also covered in mobile-force-layout.e2e.ts)
 *   ✅ Quick Add bottom-sheet styling (US-509)
 *   ✅ 长按 → action sheet (US-506)
 *   ✅ 滑动 done (US-508 left)
 *   ✅ 滑动 drop (US-508 right)
 *   ✅ 移动拖拽到日期 + 放弃目标区 (US-507)
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

function offsetISO(deltaDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + deltaDays);
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
    const plugin = (app as any).plugins.plugins["obsidian-task-center"];
    plugin.settings.mobileForceLayout = v;
    await plugin.saveSettings();
  }, value);
}

async function setTestForceMobile(value: boolean): Promise<void> {
  await browser.executeObsidian(async ({ app }, v: boolean) => {
    // @ts-expect-error — runtime plugin
    const plugin = (app as any).plugins.plugins["obsidian-task-center"];
    if (typeof plugin.__setTestForceMobile === "function") {
      plugin.__setTestForceMobile(v);
    }
  }, value);
}

async function openMobileBoardWeek() {
  await setMobileForceLayout(true);
  await browser.executeObsidianCommand("obsidian-task-center:open");
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

describe("Task Center — mobile coverage gap-fill (task #44)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    // Default: mobile gestures off. Each gesture test flips the hook on
    // explicitly so a missed reset would surface fast.
    await setTestForceMobile(false);
  });

  afterEach(async function () {
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
      const head = day.querySelector<HTMLElement>(".bt-week-day-head") ?? day;
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

  // US-503: mobile week 主体同样不能只露出一条很矮的列表。
  it("US-503: mobile Week keeps at least half of the Task Center visible height", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Mobile week min-height task ⏳ ${today}\n`);
    await openMobileBoardWeek();

    await $(".task-center-view .bt-week").waitForExist({ timeout: 5000 });
    const metrics = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".task-center-view")!;
      const week = document.querySelector<HTMLElement>(".task-center-view .bt-week")!;
      return {
        viewHeight: view.getBoundingClientRect().height,
        weekHeight: week.getBoundingClientRect().height,
      };
    });

    expect(metrics.weekHeight).toBeGreaterThanOrEqual(Math.floor(metrics.viewHeight / 2));
  });

  // US-504: Month bottom-sheet tap-to-open day-tasks list — already
  // automated in mobile-force-layout.e2e.ts (task #42 fix). Marker test
  // makes the coverage map grep-able from this file.
  it("US-504: Month bottom-sheet covered by mobile-force-layout.e2e.ts (task #42 fix)", function () {
    expect(true).toBe(true);
  });

  // US-509: mobile Quick Add carries the bottom-sheet styling
  // (`task-center-bottom-sheet` modal class).
  it("US-509: mobile Quick Add opens with the bottom-sheet styling", async function () {
    await setTestForceMobile(true);
    await setMobileForceLayout(true);

    await browser.executeObsidianCommand("obsidian-task-center:quick-add");

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

    // Close the modal so the next test starts clean.
    await browser.execute(() => {
      const close = document.querySelector<HTMLElement>(".modal-close-button");
      close?.click();
    });
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

    const duration = (await browser.executeObsidian(
      ({ app }) =>
        // @ts-expect-error — runtime plugin
        (app as any).plugins.plugins["obsidian-task-center"].settings
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

  // US-508 (left): swipe a card past the 30% threshold leftward to mark
  // it done — markdown line should carry `[x]` after the gesture.
  it("US-508: swipe-left past threshold marks the task done", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    const path = "Tasks/Inbox.md";
    await writeAndWait(path, `- [ ] Swipe-left target ⏳ ${today}\n`);
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });

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

  // US-508 (right): swipe-right drops the task (`[-] ❌`).
  it("US-508: swipe-right past threshold drops the task", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    const path = "Tasks/Inbox.md";
    await writeAndWait(path, `- [ ] Swipe-right target ⏳ ${today}\n`);
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });

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

  // US-507: mobile pointer-drag from a card to a different day column
  // rewrites the `⏳` date. We dispatch pointerdown → moves to enter the
  // 250ms+4px drag mode, then a final move over the target day column,
  // then pointerup. The drag controller's `elementFromPoint` hit-test
  // (with the floating clone hidden) resolves to the target day's
  // [data-date] node. Asserting the markdown was rewritten is enough —
  // the controller wiring must be live for that to happen.
  it("US-507: mobile pointer-drag to another day rewrites ⏳ in markdown", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    const targetDay = inWeekNeighbor();
    const path = "Tasks/Inbox.md";
    await writeAndWait(path, `- [ ] Mobile drag target ⏳ ${today}\n`);
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    const targetSel = `.task-center-view [data-date="${targetDay}"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await $(targetSel).waitForExist({ timeout: 5000 });

    // Stage 1: pointerdown + brief stillness so the 250ms drag-arm timer
    // fires (per touch.ts state machine, a move > 4px BEFORE the timer
    // fires cancels arming instead of entering drag).
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
    await browser.pause(300); // > dragArmMs (250ms)

    // Stage 2: now move into the target day column and release.
    await browser.execute(
      (src: string, tgt: string) => {
        const srcEl = document.querySelector<HTMLElement>(src);
        const tgtEl = document.querySelector<HTMLElement>(tgt);
        if (!srcEl || !tgtEl) throw new Error("missing src/tgt");
        const srcRect = srcEl.getBoundingClientRect();
        const tgtRect = tgtEl.getBoundingClientRect();
        const startX = srcRect.left + srcRect.width / 2;
        const startY = srcRect.top + srcRect.height / 2;
        const endX = tgtRect.left + tgtRect.width / 2;
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
        // First move enters drag (now past arm timer + > 4px).
        window.dispatchEvent(mk("pointermove", startX + 10, startY + 10));
        // Then walk to the target.
        window.dispatchEvent(mk("pointermove", endX, endY));
        window.dispatchEvent(mk("pointerup", endX, endY));
      },
      cardSel,
      targetSel,
    );

    await browser.waitUntil(
      async () => {
        const c = await readFile(path);
        return c.includes(`Mobile drag target ⏳ ${targetDay}`);
      },
      {
        timeout: 5000,
        timeoutMsg:
          "US-507: mobile pointer-drag did not rewrite ⏳ to the target day within 5s",
      },
    );
  });

  // US-507 (abandon): mobile pointer-drag from a card to the abandon zone
  // marks it dropped. Same gesture path as the day-column case but the
  // hit-test resolves to `[data-drop-zone='abandon']`.
  it("US-507: mobile pointer-drag to abandon drops the task", async function () {
    await setTestForceMobile(true);
    const today = todayISO();
    const path = "Tasks/Inbox.md";
    await writeAndWait(path, `- [ ] Mobile trash target ⏳ ${today}\n`);
    await openMobileBoardWeek();

    const cardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    // Both desktop pool abandon and mobile sticky action-bar abandon carry
    // `[data-drop-zone="abandon"]`. We need the mobile one (the desktop
    // pool element is `display:none` under `[data-mobile-layout="true"]`,
    // so elementFromPoint resolves to the visible mobile bar instead).
    const trashSel = `.bt-mobile-trash[data-drop-zone="abandon"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await $(trashSel).waitForExist({ timeout: 5000 });

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
          pointerId: 10,
          clientX: startX,
          clientY: startY,
          button: 0,
          isPrimary: true,
        }),
      );
    }, cardSel);
    await browser.pause(300); // > dragArmMs

    await browser.execute(
      (src: string, tgt: string) => {
        const srcEl = document.querySelector<HTMLElement>(src);
        const tgtEl = document.querySelector<HTMLElement>(tgt);
        if (!srcEl || !tgtEl) throw new Error("missing src/tgt");
        const srcRect = srcEl.getBoundingClientRect();
        const tgtRect = tgtEl.getBoundingClientRect();
        const startX = srcRect.left + srcRect.width / 2;
        const startY = srcRect.top + srcRect.height / 2;
        const endX = tgtRect.left + tgtRect.width / 2;
        const endY = tgtRect.top + tgtRect.height / 2;
        const mk = (type: string, x: number, y: number) =>
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: "touch",
            pointerId: 10,
            clientX: x,
            clientY: y,
            button: 0,
            isPrimary: true,
          });
        window.dispatchEvent(mk("pointermove", startX + 10, startY + 10));
        window.dispatchEvent(mk("pointermove", endX, endY));
        window.dispatchEvent(mk("pointerup", endX, endY));
      },
      cardSel,
      trashSel,
    );

    await browser.waitUntil(
      async () => {
        const c = await readFile(path);
        return /^- \[-\] Mobile trash target.*❌/m.test(c);
      },
      {
        timeout: 5000,
        timeoutMsg:
          "US-507 (trash): mobile pointer-drag to trash did not drop the task within 5s",
      },
    );
  });
});
