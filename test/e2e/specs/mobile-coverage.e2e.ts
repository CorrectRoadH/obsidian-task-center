import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

/**
 * task #44 (US-501–510): mobile e2e coverage gap-fill.
 *
 * The desktop suite already exercises Week / Month / drag / parent-child
 * etc. Jerry's QA pass found the mobile-only behaviors had no automated
 * coverage at all. We add this spec to surface the coverage situation
 * for each Jerry-named path. Each test either runs against a layer that
 * works in WDIO Chromium (CSS / data-attribute / click), or is `xit`-
 * skipped with a documented limitation + manual-verification note.
 *
 * **Why some tests are skipped:** every behavior gated on Obsidian's
 * `Platform.isMobile` (long-press menu, swipe, mobile pointer-drag,
 * Quick Add bottom-sheet styling) is wired ONLY when Platform.isMobile
 * returns true. The plugin's own `mobileForceLayout` setting flips the
 * CSS data-attribute but does NOT change Platform.isMobile (that comes
 * from Obsidian core). WDIO drives a desktop Chromium instance →
 * Platform.isMobile = false → those gestures never get attached, so a
 * synthetic PointerEvent fires but lands on no listener.
 *
 * Per Leo's task #44 acceptance口径 (msg `aa895ae2`): for paths that
 * cannot be stably automated, document the limitation, the alternative
 * assertion if any, and the manual verification point.
 *
 * Coverage map after this spec:
 *   ✅ Week 折叠/展开 (US-503)         — automated below
 *   ✅ Month bottom sheet (US-504)      — already automated in
 *                                         mobile-force-layout.e2e.ts
 *                                         (uses cell.click() — bypasses
 *                                         Platform.isMobile gate via
 *                                         the click handler in view.ts:
 *                                         renderMonth)
 *   ⏭ Quick Add sheet (US-509)         — gated on Platform.isMobile;
 *                                         skipped + manual verify on
 *                                         iPhone/Android pre-release
 *   ⏭ 长按菜单 (US-506)                — same gate, skipped + manual
 *   ⏭ 滑动 done/drop (US-508)          — same gate, skipped + manual
 *   ⏭ 移动拖拽到日期/垃圾站 (US-507)  — same gate, skipped + manual
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

async function setMobileForceLayout(value: boolean): Promise<void> {
  await browser.executeObsidian(async ({ app }, v: boolean) => {
    // @ts-expect-error — runtime plugin
    const plugin = (app as any).plugins.plugins["obsidian-task-center"];
    plugin.settings.mobileForceLayout = v;
    await plugin.saveSettings();
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
  });

  // US-503: mobile Week is a vertical list; today's row is expanded by
  // default and other days collapse. Tapping a collapsed day-head
  // expands its tasks. The expansion is a JS click handler on the day
  // head (NOT gated on Platform.isMobile — it reads the `expandedDays`
  // state set in the constructor's mobile branch), so this test runs
  // by setting `mobileForceLayout` so the Week renders in mobile shape
  // and then clicking.
  it("US-503: mobile Week — today expanded by default; tapping a collapsed day expands it", async function () {
    const today = todayISO();
    const yest = offsetISO(-1);
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Today task ⏳ ${today}\n- [ ] Yesterday task ⏳ ${yest}\n`,
    );
    await openMobileBoardWeek();

    // Today's task card must be present (proves today's row is expanded
    // by default — the card lives inside the collapsible day column).
    await $(`.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`).waitForExist({
      timeout: 5000,
    });

    // Tap the collapsed yesterday day-head (or column) to expand it.
    const expanded = await browser.execute((iso: string) => {
      const day = document.querySelector<HTMLElement>(
        `.task-center-view [data-date="${iso}"]`,
      );
      if (!day) return false;
      const head = day.querySelector<HTMLElement>(".bt-week-day-head") ?? day;
      head.click();
      return true;
    }, yest);
    expect(expanded).toBe(true);

    await $(`.task-center-view [data-task-id="Tasks/Inbox.md:L2"]`).waitForExist({
      timeout: 5000,
      timeoutMsg:
        "US-503: tapping yesterday's collapsed day-head did not surface its task card",
    });
  });

  // US-504: Month bottom-sheet tap-to-open day-tasks list.
  // Already automated in mobile-force-layout.e2e.ts (task #42 fix shipped
  // in 0.2.6) — the click handler reads `mobileForceLayout` directly so
  // it bypasses the Platform.isMobile gate. We don't duplicate the test
  // here; the original case is enough.
  it("US-504: Month bottom-sheet covered by mobile-force-layout.e2e.ts (task #42 fix)", function () {
    // Documentation-only marker. The real assertion lives in the spec
    // file noted in the title. This test exists to keep the coverage
    // map in this file complete and grep-able.
    expect(true).toBe(true);
  });

  // ───── Skipped: gated on Obsidian core's Platform.isMobile ─────
  //
  // Each of these behaviors gets attached only when Platform.isMobile
  // returns true (see view.ts:1367 `if (!Platform.isMobile)` branch
  // for popovers vs. mobile gestures, and quickadd.ts:45/65 for the
  // bottom-sheet styling on Quick Add). WDIO drives a desktop Chromium
  // instance, so the gesture controllers / sheet classes simply aren't
  // wired. Synthetic PointerEvents land on nothing.
  //
  // Manual verification per release (UX-mobile.md §12 acceptance list):
  //   - On a real iPhone or iPad in Obsidian Mobile, run the plugin
  //     and exercise each path; the existing UX-mobile.md §12 27-item
  //     checklist already covers these. Pre-release: run the checklist.
  //   - On desktop with `mobileForceLayout=true`, the *visual* layout
  //     is mobile but JS gestures don't fire — that is the intended
  //     contract (the setting is a CSS escape hatch only).

  xit("US-509: mobile Quick Add opens with bottom-sheet styling — gated on Platform.isMobile (manual verify on real device)", function () {
    // Source: src/quickadd.ts:45-53 — `if (Platform.isMobile) { ...
    // modalEl.addClass('task-center-bottom-sheet') ... }`. WDIO desktop
    // Chromium → Platform.isMobile = false → class never added.
  });

  xit("US-506: long-press on a card opens the action sheet — gated on Platform.isMobile (manual verify on real device)", function () {
    // Source: src/view.ts:1367-1395 — `attachCardGestures()` is only
    // called inside the `Platform.isMobile` branch. Synthetic
    // pointerdown on the card lands on no long-press listener.
  });

  xit("US-508: swipe-left → done — gated on Platform.isMobile (manual verify on real device)", function () {
    // Same gate as US-506: swipe handler attaches via attachCardGestures
    // only in the mobile branch.
  });

  xit("US-508: swipe-right → drop — gated on Platform.isMobile (manual verify on real device)", function () {
    // Same gate as US-506.
  });

  xit("US-507: mobile pointer-drag to date column / trash — gated on Platform.isMobile (manual verify on real device)", function () {
    // Source: src/view.ts:1394 onDragArmed → mobileDragSession() →
    // src/view/drag-mobile.ts. The drag controller is only attached on
    // mobile. Desktop drag has its own coverage in drag.e2e.ts (which
    // uses HTML5 DnD, not pointer events).
  });
});
