/**
 * US-145: completing / dropping a parent auto-propagates to todo children
 * US-148: subtask with own ⏳ ≠ parent ⏳ renders as standalone card on its own day
 * US-149: when a subtask's ⏳ differs from parent, show ⏳ MM-DD badge on the subcard
 * US-407: rename / reschedule must not eat Obsidian Tasks extension fields
 *         (🛫 start, 🔁 recurrence, ⏫🔺🔼🔽⏬ priority, [id::] inline fields)
 *
 * All assertions are against the markdown file content — no CSS class coupling.
 * The only DOM coupling is `data-task-id` (stable identifier agreed with CTO).
 */
import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

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

/**
 * Return today + 1 day if today is Mon-Sat, today - 1 day if today is
 * Sunday. The week tab renders Mon-Sun (default `weekStartsOn: 1`); a
 * naive `offsetISO(1)` falls into next week's view on Sundays and the
 * `[data-date="<tomorrow>"]` column doesn't exist there. This helper
 * keeps the chosen day inside the visible week regardless of weekday.
 */
function inWeekNeighbor(): string {
  const d = new Date();
  d.setDate(d.getDate() + (d.getDay() === 0 ? -1 : 1));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function switchToWeekTab() {
  await browser.execute(() => {
    document.querySelector<HTMLElement>(".task-center-view [data-tab='week']")?.click();
  });
  await browser.waitUntil(
    () => browser.execute(() =>
      !!document.querySelector(
        ".task-center-view [data-tab='week'].active, .task-center-view [data-tab='week'][aria-selected='true']",
      ),
    ),
    { timeout: 3000, interval: 100, timeoutMsg: "Week tab did not become active" },
  );
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

async function forFlush() {
  await browser.executeObsidian(async ({ app }) => {
    // @ts-expect-error — runtime plugin
    await (app as any).plugins.plugins["task-center"].__forFlush();
  });
}

async function readFile(path: string): Promise<string> {
  return (await browser.executeObsidian(async ({ app }, p: string) => {
    const f = app.vault.getAbstractFileByPath(p);
    if (!f) return "";
    // @ts-expect-error — runtime TFile
    return await app.vault.read(f);
  }, path)) as unknown as string;
}

/**
 * Call TaskCenterApi inside Obsidian and return the serialisable result.
 * Uses the plugin's registered API so tests are agnostic to internal refactors.
 */
async function callApi<T>(
  fn: (api: { done(id: string): Promise<unknown>; drop(id: string): Promise<unknown> }) => Promise<T>,
): Promise<T> {
  return (await browser.executeObsidian(async ({ app }, fnSrc: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = (app as any).plugins?.getPlugin?.("task-center");
    if (!plugin?.api) throw new Error("plugin api not found");
    // Reconstruct the callable from serialised source — WDIO passes args by value.
    // eslint-disable-next-line no-new-func
    const callable = new Function("api", `return (${fnSrc})(api)`);
    return await callable(plugin.api);
  }, fn.toString())) as T;
}

describe("Task Center — 父子任务状态继承 (US-145/124/407)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-145: marking parent done auto-completes todo children; done children unchanged
  it("US-145: completing parent marks todo children done, leaves already-done children", async function () {
    const today = todayISO();
    const path = "Tasks/Inbox.md";
    await writeAndWait(
      path,
      [
        `- [ ] Parent ⏳ ${today}`,
        `    - [ ] Child A`,
        `    - [x] Child B ✅ 2026-01-01`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    // Mark parent done via the API (UI-agnostic).
    await callApi((api) => api.done("Tasks/Inbox.md:L1"));

    await browser.waitUntil(
      async () => {
        const c = await readFile(path);
        return c.includes("[x]") && c.includes("✅");
      },
      { timeout: 5000, timeoutMsg: "parent was not marked done" },
    );

    const content = await readFile(path);
    // Parent: completed
    await expect(content).toMatch(/\[x\] Parent.*✅/);
    // Child A (was todo): also completed
    await expect(content).toMatch(/\[x\] Child A.*✅/);
    // Child B (was already done with a date): date must be preserved, not overwritten
    await expect(content).toContain("[x] Child B ✅ 2026-01-01");
  });

  // US-124: dropping parent drops todo children; done children preserved
  it("US-124: dropping parent drops todo children, preserves done children", async function () {
    const today = todayISO();
    const path = "Tasks/Inbox.md";
    await writeAndWait(
      path,
      [
        `- [ ] Parent ⏳ ${today}`,
        `    - [ ] Child A`,
        `    - [x] Child B ✅ 2026-01-01`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    await callApi((api) => api.drop("Tasks/Inbox.md:L1"));

    await browser.waitUntil(
      async () => (await readFile(path)).includes("[-]"),
      { timeout: 5000, timeoutMsg: "parent was not dropped" },
    );

    const content = await readFile(path);
    // Parent: dropped
    await expect(content).toMatch(/\[-\] Parent.*❌/);
    // Child A (was todo): also dropped
    await expect(content).toMatch(/\[-\] Child A.*❌/);
    // Child B (was done): untouched — US-124
    await expect(content).toContain("[x] Child B ✅ 2026-01-01");
  });

  // US-407: rename must not eat Obsidian Tasks extension fields
  it("US-407: rename preserves 🛫 start, 🔁 recurrence, ⏫ priority and [id::] inline field", async function () {
    const path = "Tasks/Inbox.md";
    // A task that uses all the extension fields this plugin does not render.
    await writeAndWait(
      path,
      `- [ ] Original title 🛫 2026-04-20 🔁 every week ⏫ [id:: abc-123]\n`,
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    // Rename via API — the UI rename path should also be tested separately,
    // but the file-level invariant is what matters here.
    await browser.executeObsidian(
      async ({ app }, p: string) => {
        // @ts-expect-error — runtime plugin access
        const plugin = (app as any).plugins?.getPlugin?.("task-center");
        await plugin?.api?.rename("Tasks/Inbox.md:L1", "Renamed title");
      },
      path,
    );

    await browser.waitUntil(
      async () => (await readFile(path)).includes("Renamed title"),
      { timeout: 5000, timeoutMsg: "rename never written to file" },
    );

    const content = await readFile(path);
    // New title present
    await expect(content).toContain("Renamed title");
    // All extension fields must survive byte-for-byte
    await expect(content).toContain("🛫 2026-04-20");
    await expect(content).toContain("🔁 every week");
    await expect(content).toContain("⏫");
    await expect(content).toContain("[id:: abc-123]");
  });

  // US-148/149: subtask with own ⏳ ≠ parent ⏳ renders standalone on its own day
  it("US-148/149: cross-day subtask appears as standalone card on its own day, not nested in parent", async function () {
    const today = todayISO();
    // "tomorrow" semantically — pick whichever neighbor day is in the
    // current week view (offsetISO(1) breaks on Sundays).
    const tomorrow = inWeekNeighbor();
    const path = "Tasks/Inbox.md";

    // Parent ⏳ today; A-2 inherits (no own ⏳); A-3 has explicit ⏳ tomorrow.
    await writeAndWait(
      path,
      [
        `- [ ] Parent ⏳ ${today}`,
        `    - [ ] Same-day child`,
        `    - [ ] Cross-day child ⏳ ${tomorrow}`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await switchToWeekTab();

    // Parent card must appear in today's column.
    const parentSel = `.task-center-view [data-date="${today}"] [data-task-id="${path}:L1"]`;
    await $(parentSel).waitForExist({ timeout: 5000, timeoutMsg: "parent card not found in today's column" });

    // US-148: cross-day child (L3) must NOT be nested inside parent card in today's column.
    const crossDayNested = `.task-center-view [data-date="${today}"] [data-task-id="${path}:L1"] [data-task-id="${path}:L3"]`;
    await expect(await browser.$(crossDayNested).isExisting()).toBe(
      false,
      "cross-day subtask should not be nested inside parent's card",
    );

    // US-148: same-day child (L2) IS still nested inside parent's card.
    const sameDayNested = `.task-center-view [data-date="${today}"] [data-task-id="${path}:L1"] [data-task-id="${path}:L2"]`;
    await $(sameDayNested).waitForExist({ timeout: 3000, timeoutMsg: "same-day subtask not found nested in parent" });

    // US-148: cross-day child must appear as a top-level card in tomorrow's column.
    const standaloneSel = `.task-center-view [data-date="${tomorrow}"] [data-task-id="${path}:L3"]`;
    await $(standaloneSel).waitForExist({
      timeout: 3000,
      timeoutMsg: "cross-day subtask not found as standalone card in tomorrow's column",
    });
  });

  it("task #104: completed child appears on its completed day even when parent is scheduled later", async function () {
    const today = todayISO();
    const tomorrow = inWeekNeighbor();
    const path = "Tasks/Inbox.md";

    await writeAndWait(
      path,
      [
        `- [ ] 与 HelloGithub站长相关工作 ⏳ ${tomorrow}`,
        `\t- [x] 写简历 ✅ ${today} ⏳ ${today}`,
        `\t- [ ] 写稿子`,
        `\t\t-  多动症与时间管理`,
        `\t\t- 被投诉需要什么`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await switchToWeekTab();

    const parentSel = `.task-center-view [data-date="${tomorrow}"] [data-task-id="${path}:L1"]`;
    const completedChildSel = `.task-center-view [data-date="${today}"] [data-task-id="${path}:L2"]`;
    const childNestedUnderParent = `${parentSel} [data-task-id="${path}:L2"]`;

    await $(parentSel).waitForExist({ timeout: 5000, timeoutMsg: "parent card not found on its scheduled day" });
    await $(completedChildSel).waitForExist({
      timeout: 5000,
      timeoutMsg: "completed child did not appear on its completed day",
    });
    await expect(await browser.$(childNestedUnderParent).isExisting()).toBe(
      false,
      "completed cross-day child should not be swallowed by the later parent card",
    );
  });

  // US-407: reschedule (set ⏳) must not eat other fields
  it("US-407: setting ⏳ scheduled date preserves all other extension fields", async function () {
    const path = "Tasks/Inbox.md";
    await writeAndWait(
      path,
      `- [ ] Task with extras 🛫 2026-04-20 📅 2026-05-01 ⏫ [estimate:: 30m]\n`,
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime plugin access
      const plugin = (app as any).plugins?.getPlugin?.("task-center");
      await plugin?.api?.schedule("Tasks/Inbox.md:L1", "2026-04-28");
    });

    await browser.waitUntil(
      async () => (await readFile(path)).includes("⏳ 2026-04-28"),
      { timeout: 5000, timeoutMsg: "scheduled date was not written" },
    );

    const content = await readFile(path);
    await expect(content).toContain("⏳ 2026-04-28");
    await expect(content).toContain("🛫 2026-04-20");
    await expect(content).toContain("📅 2026-05-01");
    await expect(content).toContain("⏫");
    await expect(content).toContain("[estimate:: 30m]");
  });

  // US-150: ⏳ badge hidden when top-level card is in its own scheduled day column
  it("US-150: ⏳ badge not shown when card is rendered in its own scheduled day column", async function () {
    const today = todayISO();
    const tomorrow = inWeekNeighbor();
    const path = "Tasks/Inbox.md";

    await writeAndWait(
      path,
      [
        `- [ ] Task today ⏳ ${today}`,
        `- [ ] Task tomorrow ⏳ ${tomorrow}`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await switchToWeekTab();

    const todayCardSel = `.task-center-view [data-date="${today}"] [data-task-id="${path}:L1"]`;
    const tomorrowCardSel = `.task-center-view [data-date="${tomorrow}"] [data-task-id="${path}:L2"]`;
    await $(todayCardSel).waitForExist({ timeout: 5000, timeoutMsg: "today's task card not found" });
    await $(tomorrowCardSel).waitForExist({ timeout: 5000, timeoutMsg: "tomorrow's task card not found" });

    // US-150: column header already implies the date — badge must not appear
    await expect(await browser.$(`${todayCardSel} .bt-meta-sched`).isExisting()).toBe(
      false,
      "⏳ badge must not show for a task in its own scheduled day column (today)",
    );
    await expect(await browser.$(`${tomorrowCardSel} .bt-meta-sched`).isExisting()).toBe(
      false,
      "⏳ badge must not show for a task in its own scheduled day column (tomorrow)",
    );
  });

  // US-105: tab counter must equal the count of top-level cards rendered
  // when the user switches to that tab. Without dedup the badge would
  // include children that ride with a visible parent and never appear as
  // their own card (the reported "tab count vs body count" mismatch).
  it("US-105: tab counter equals visible top-level card count post-dedup", async function () {
    const path = "Tasks/Inbox.md";
    // 1 unscheduled parent with 3 unscheduled children. Children ride
    // with the parent and don't appear as their own cards in the
    // Unscheduled tab — only the parent does.
    await writeAndWait(
      path,
      [
        `- [ ] Parent unscheduled`,
        `    - [ ] Child A`,
        `    - [ ] Child B`,
        `    - [ ] Child C`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    // Read the Unscheduled tab badge count.
    const badgeCount = await browser.execute(() => {
      const tab = document.querySelector(
        ".task-center-view [data-tab='unscheduled'] .bt-tab-count",
      );
      return tab ? parseInt(tab.textContent || "0", 10) : 0;
    });

    // Switch to Unscheduled tab and count actual top-level cards.
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>(".task-center-view [data-tab='unscheduled']")
        ?.click();
    });
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          !!document.querySelector(
            ".task-center-view [data-tab='unscheduled'].active",
          ),
        ),
      { timeout: 3000, interval: 100, timeoutMsg: "Unscheduled tab did not become active" },
    );

    // Count top-level `.bt-card` (skip nested `.bt-card-children .bt-card`
    // — though the unscheduled view doesn't have those, this guard keeps
    // the assertion robust if rendering changes).
    const visibleTopLevelCount = await browser.execute(() => {
      const root = document.querySelector(".task-center-view .bt-body");
      if (!root) return -1;
      // Top-level cards = `.bt-card` whose closest `.bt-card` ancestor is
      // itself (i.e. not nested under another card).
      let count = 0;
      for (const card of Array.from(root.querySelectorAll(".bt-card"))) {
        const ancestor = card.parentElement?.closest(".bt-card");
        if (!ancestor) count++;
      }
      return count;
    });

    await expect(badgeCount).toBe(visibleTopLevelCount);
    // Concretely: 1 parent → 1 visible card, badge should read "1".
    await expect(badgeCount).toBe(1);
  });
});
