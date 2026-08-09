/**
 * Modal title layout — verifies that .modal-title in task-center modals is
 * left-aligned and does not overlap the close button.
 *
 * Regression for: title was right-aligned due to align-items:flex-end on
 * .task-center-bottom-sheet.modal (mobile CSS leaking into desktop layout).
 */
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const VAULT = "test/e2e/vaults/simple";

describe("Task Center — modal title layout", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    await browser.execute(() => {
      document.querySelectorAll(".modal-container").forEach((m) => m.remove());
    });
  });

  it("manage-tabs modal: title is left-aligned and not overlapping close button", async function () {
    // Open the board first so there is a task-center-board leaf to drive.
    await browser.executeObsidianCommand("task-center:open");
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !!(window as unknown as { app: any }).app.workspace.getLeavesOfType("task-center-board")[0],
        ),
      { timeout: 5000, interval: 100, timeoutMsg: "board leaf did not open" },
    );

    // Open the manage tabs sheet via the plugin API.
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["task-center"];
      // Find the open TaskCenterView leaf and open the manage-tabs sheet. The
      // public method is `openManageTabs()` (it delegates to openManageTabsSheet
      // in view/manage-tabs.ts); the old `view.openManageTabsSheet` never existed
      // on the view, so the optional call silently no-op'd and the modal never opened.
      const leaf = app.workspace.getLeavesOfType("task-center-board")[0];
      if (!leaf) return;
      const view = leaf.view as any;
      view.openManageTabs?.();
    });

    // Wait for the modal to appear.
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !!document.querySelector(".task-center-bottom-sheet .modal-title"),
        ),
      { timeout: 3000, interval: 100 },
    );

    // Check that the title element's right edge does not reach the close button.
    const result = await browser.execute(() => {
      const title = document.querySelector(
        ".task-center-bottom-sheet .modal-title",
      ) as HTMLElement | null;
      const modal = title?.closest(".modal") as HTMLElement | null;
      // Obsidian 1.13 moved the close button outside `.modal`; beforeEach
      // guarantees this is the only open modal container in this scenario.
      const closeBtn = document.querySelector(".modal-close-button") as HTMLElement | null;
      if (!modal || !title) {
        return { ok: false, reason: "elements missing" };
      }

      const titleRect = title.getBoundingClientRect();
      const modalRect = modal.getBoundingClientRect();
      // Title left edge should be near the VISIBLE sheet's left edge. The sheet
      // (.modal-content, ~560px) is centered inside the full-width outer .modal,
      // so the title is left-aligned WITHIN the sheet — measure against the
      // sheet, not the outer modal (which would falsely report the centering gap).
      const content = modal.querySelector(".modal-content") as HTMLElement | null;
      const sheetRect = (content ?? modal).getBoundingClientRect();
      const leftOffset = titleRect.left - sheetRect.left;

      // Obsidian 1.13 may omit the close button entirely. In that case there
      // is nothing for the title to overlap; Esc/outside click still dismiss.
      if (!closeBtn) {
        return { ok: true, gap: null, leftOffset, titleWidth: titleRect.width, modalWidth: modalRect.width, reason: "close button omitted" };
      }

      const closeBtnRect = closeBtn.getBoundingClientRect();
      // Title right edge should be clearly to the left of close button left edge.
      const gap = closeBtnRect.left - titleRect.right;

      return {
        ok: gap >= 0,
        gap,
        leftOffset,
        titleWidth: titleRect.width,
        modalWidth: modalRect.width,
        reason: gap < 0 ? `title overlaps close button by ${-gap}px` : "ok",
      };
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    // Title should be left-aligned — left offset should be close to the modal padding.
    expect(result.leftOffset).toBeLessThan(40);
  });
});
