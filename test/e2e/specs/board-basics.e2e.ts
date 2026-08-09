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

/** Write content to a vault file and wait for metadata cache to pick it up. */
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
      // Wait for the metadata cache to index this file before continuing.
      await new Promise<void>((resolve) => {
        // @ts-expect-error — runtime TFile
        const ref = app.metadataCache.on("changed", (file) => {
          if (file.path === p) {
            app.metadataCache.offref(ref);
            resolve();
          }
        });
        // Hard upper-bound so we never stall the test suite.
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

describe("Task Center — 看板基础 (US-101/107/115)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-101: board opens
  it("opens the board view via command", async function () {
    await browser.executeObsidianCommand("task-center:open");
    await expect($(".task-center-view")).toExist();
  });

  // US-101: renders a task card scheduled today
  it("renders a task card scheduled today (data-task-id is stable)", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] E2E smoke task ⏳ ${today}\n`);

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    const card = $(`.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`);
    await card.waitForExist({ timeout: 5000 });
    await expect(card).toExist();
  });

  // US-101 / US-515: wide week keeps its board height; compact week is allowed
  // to shrink to date keys + the selected-day outline.
  it("US-101/US-515: week height follows the active pane presentation", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Week min-height task ⏳ ${today}\n`);

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-tab="week"]').click();
    await $(".task-center-view .bt-week").waitForExist({ timeout: 5000 });

    const metrics = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".task-center-view")!;
      const week = document.querySelector<HTMLElement>(".task-center-view .bt-week")!;
      return {
        paneLayout: view.dataset.paneLayout,
        viewHeight: view.getBoundingClientRect().height,
        weekHeight: week.getBoundingClientRect().height,
      };
    });

    if (metrics.paneLayout === "wide") {
      expect(metrics.weekHeight).toBeGreaterThanOrEqual(Math.floor(metrics.viewHeight / 2));
    } else {
      expect(metrics.weekHeight).toBeGreaterThan(100);
    }
  });

  it("US-514/US-515: compact desktop pane uses date keys and keeps pointer cards draggable", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Compact outline task ⏳ ${today}\n`);

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".task-center-view")!;
      view.style.width = "760px";
      view.style.flex = "0 0 760px";
    });
    await browser.waitUntil(async () => (
      await $(".task-center-view").getAttribute("data-pane-layout")
    ) === "compact");

    await $('[data-tab="week"]').click();
    await $(".bt-week-compact").waitForExist({ timeout: 5000 });
    await expect($(".task-center-view")).toHaveAttribute("data-mobile-layout", "false");
    expect((await $$(".bt-week-compact > .bt-week-col[data-date]")).length).toBe(7);

    const outlineCard = $('.bt-month-day-panel[data-source="week"] [data-task-id="Tasks/Inbox.md:L1"]');
    await outlineCard.waitForExist({ timeout: 5000 });
    await expect(outlineCard).toHaveAttribute("draggable", "true");
  });

  // US-107: tasks with empty title must be silently ignored — no card appears
  it("US-107: ignores blank-title tasks (empty checkbox body)", async function () {
    const today = todayISO();
    // One blank-title task and one real task to confirm the board loaded at all.
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] ⏳ ${today}\n- [ ] Real task ⏳ ${today}\n`,
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    // The real task's card must appear.
    await $(`.task-center-view [data-task-id="Tasks/Inbox.md:L2"]`).waitForExist({
      timeout: 5000,
    });

    // The blank-title task must NOT produce a card (L1).
    const blankCard = $(`.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`);
    await expect(blankCard).not.toExist();
  });

  // US-115: overdue cards get a visual marker (overdue class/attribute)
  it("US-115: overdue task card has overdue visual indicator", async function () {
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Overdue task 📅 2020-01-01\n`,
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    // Find the card — it may live in Unscheduled pool or any view tab.
    // We just need at least one element that carries the overdue marker.
    await browser.waitUntil(
      async () => {
        const count = await browser.execute(() => {
          // Accept either a CSS class or a data-attribute as the marker —
          // the exact implementation is CTO's call.
          return document.querySelectorAll(
            ".task-center-view .bt-overdue, .task-center-view [data-overdue='true']",
          ).length;
        });
        return (count as number) > 0;
      },
      { timeout: 5000, timeoutMsg: "no overdue marker found for a past-deadline task" },
    );
  });

  // US-115: near-deadline (within 3 days) gets its own marker
  it("US-115: near-deadline task card has near-deadline visual indicator", async function () {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    const nearDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Near deadline task 📅 ${nearDate}\n`,
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    await browser.waitUntil(
      async () => {
        const count = await browser.execute(() => {
          return document.querySelectorAll(
            ".task-center-view .bt-near-deadline, .task-center-view [data-near-deadline='true']",
          ).length;
        });
        return (count as number) > 0;
      },
      { timeout: 5000, timeoutMsg: "no near-deadline marker for a task due in 2 days" },
    );
  });

  // US-151: top-level Task Cards show markdown #tags below the title.
  it("US-151: task cards render original tags below the title in week and today views", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Tagged task #alpha #1象限 #alpha ⏳ ${today}\n`,
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    const weekTab = $('[data-tab="week"]');
    await weekTab.waitForExist({ timeout: 5000 });
    await weekTab.click();

    const cardSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });

    const weekCard = await browser.execute((sel: string) => {
      const card = document.querySelector(sel)!;
      const title = card.querySelector(".bt-card-title")!.getBoundingClientRect();
      const tags = card.querySelector(".bt-card-tags")!.getBoundingClientRect();
      return {
        titleText: card.querySelector(".bt-card-title")?.textContent ?? "",
        tags: Array.from(card.querySelectorAll(".bt-card-tags .bt-task-tag")).map((e) => e.textContent),
        tagsAreBelowTitle: tags.top >= title.bottom,
      };
    }, cardSel);
    expect(weekCard.titleText).toBe("Tagged task");
    expect(weekCard.tags).toEqual(["#alpha", "#1象限"]);
    expect(weekCard.tagsAreBelowTitle).toBe(true);

    const todayTab = $('[data-tab="today"]');
    await todayTab.waitForExist({ timeout: 5000 });
    await todayTab.click();
    await $('[data-view="today"]').waitForExist({ timeout: 3000 });

    const todayCard = await browser.execute(() => {
      const card = document.querySelector('[data-view="today"] [data-task-id="Tasks/Inbox.md:L1"]')!;
      const title = card.querySelector(".bt-card-title")!.getBoundingClientRect();
      const tags = card.querySelector(".bt-card-tags")!.getBoundingClientRect();
      return {
        tags: Array.from(card.querySelectorAll(".bt-card-tags .bt-task-tag")).map((e) => e.textContent),
        tagsAreBelowTitle: tags.top >= title.bottom,
      };
    });
    expect(todayCard.tags).toEqual(["#alpha", "#1象限"]);
    expect(todayCard.tagsAreBelowTitle).toBe(true);
  });

  // US-152 / US-153: completing a card in a todo-only view does NOT remove it
  // immediately — it lingers in its done state (muted, ✔, no line-through,
  // data-just-completed) until the view is re-entered, then disappears.
  it("US-153: a just-completed card lingers in place, then disappears on re-enter", async function () {
    const today = todayISO();
    // A dedicated file: earlier tests rewrite Tasks/Inbox.md many times, which
    // accumulates stale path:L1 → hash entries in the cache; resolving this
    // task's ref for the ✔ write must not collide with a prior occupant's hash.
    await writeAndWait("Tasks/US153.md", `- [ ] Linger task ⏳ ${today}\n`);

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    // Land on the Today tab (todo-only, filters out done).
    const todayTab = $('[data-tab="today"]');
    await todayTab.waitForExist({ timeout: 5000 });
    await todayTab.click();
    await $('[data-view="today"]').waitForExist({ timeout: 3000 });

    const cardSel = `[data-view="today"] [data-task-id="Tasks/US153.md:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });

    // Click the ✔ to complete it.
    await $(`${cardSel} .bt-check`).click();
    // US-153: the card is STILL in the list, now in its done state. The click
    // handler writes the file and waits for TaskCache to reparse before the
    // re-render, so wait for the DOM contract itself instead of racing the
    // async handler with a generic plugin flush.
    await browser.waitUntil(async () => {
      const state = await browser.execute((sel: string) => {
        const card = document.querySelector<HTMLElement>(sel);
        if (!card) return null;
        const check = card.querySelector<HTMLElement>(".bt-check");
        return {
          hasDoneClass: card.classList.contains("done"),
          justCompleted: card.dataset.justCompleted === "true",
          checkIcon: check?.textContent ?? "",
          checkIsDone: check?.classList.contains("bt-check-done") ?? false,
        };
      }, cardSel);
      return !!state?.hasDoneClass
        && state.justCompleted
        && state.checkIcon === "✔"
        && state.checkIsDone;
    }, {
      timeout: 5000,
      timeoutMsg: "US-153 card did not settle into just-completed linger state",
    });

    const lingering = await browser.execute((sel: string) => {
      const card = document.querySelector<HTMLElement>(sel);
      if (!card) return null;
      const check = card.querySelector<HTMLElement>(".bt-check");
      const title = card.querySelector<HTMLElement>(".bt-card-title");
      const titleDecoration = title
        ? getComputedStyle(title).textDecorationLine
        : "";
      return {
        present: true,
        hasDoneClass: card.classList.contains("done"),
        justCompleted: card.dataset.justCompleted === "true",
        checkIcon: check?.textContent ?? "",
        checkIsDone: check?.classList.contains("bt-check-done") ?? false,
        // US-152: no strike-through on the title.
        titleStruck: titleDecoration.includes("line-through"),
      };
    }, cardSel);

    expect(lingering).not.toBeNull();
    expect(lingering!.hasDoneClass).toBe(true);
    expect(lingering!.justCompleted).toBe(true);
    expect(lingering!.checkIcon).toBe("✔");
    expect(lingering!.checkIsDone).toBe(true);
    expect(lingering!.titleStruck).toBe(false);

    // Re-enter the view: switch away to Week, then back to Today.
    await $('[data-tab="week"]').click();
    await $(".task-center-view .bt-week").waitForExist({ timeout: 5000 });
    await $('[data-tab="today"]').click();
    await $('[data-view="today"]').waitForExist({ timeout: 3000 });

    // Now the completed card is gone (normal status filter applies).
    await $(cardSel).waitForExist({ reverse: true, timeout: 5000 });
  });

  // quick-add modal
  it("opens the quick-add modal via command", async function () {
    await browser.executeObsidianCommand("task-center:quick-add");
    await expect($(".task-center-quick-add")).toExist();
  });

  // task #41 (US-106 + US-107): the persistent status bar's today/overdue
  // counters must apply the same blank-title filter the board uses. A line
  // like `- [ ] ⏳ today` is a blank-title task that the board silently
  // drops (US-107); the status bar previously counted it anyway, so its
  // number disagreed with the visible card count. Fixture has 1 blank
  // and 1 real task ⏳ today: status bar must read `📋 1 today`, not 2.
  it("task #41: status bar excludes blank-title tasks from today count", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] ⏳ ${today}\n- [ ] Real task ⏳ ${today}\n`,
    );

    // Open the board to prime the cache and ensure the status bar is mounted,
    // then __forFlush() also flushes the status bar's debounce.
    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    // The board confirms the cache saw both lines and applied US-107 to L1.
    await $(`.task-center-view [data-task-id="Tasks/Inbox.md:L2"]`).waitForExist({
      timeout: 5000,
    });

    // Status bar (the Obsidian status-bar item, not inside .task-center-view)
    // must agree with what the board renders: 1 today, no overdue.
    // Locale-agnostic: task #43 routed the text through tr() so the format
    // depends on the current Obsidian language (`📋 1 today` in EN,
    // `📋 今日 1` in ZH). Either form must show the digit 1 and no "·"
    // separator (which would only appear when the overdue clause is added).
    const text = await browser.execute(
      () =>
        document.querySelector<HTMLElement>(".task-center-status")?.textContent ??
        "",
    );
    await expect(text).toMatch(/^📋[^·]*\b1\b[^·]*$/);
    await expect(text).not.toContain("·");
  });
});
