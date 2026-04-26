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

async function switchToWeekTab() {
  await browser.execute(() => {
    document.querySelector<HTMLElement>(".task-center-view [data-tab='week']")?.click();
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

async function findInParent(parentSel: string, fragment: string): Promise<boolean> {
  return browser.execute(
    (sel: string, frag: string) => {
      const card = document.querySelector(sel);
      if (!card) return false;
      // Search ALL descendant subcards (subcards + nested grandchild subcards).
      const subs = Array.from(card.querySelectorAll(".bt-subcard"));
      const titles = subs.map(
        (s) => s.querySelector(".bt-subcard-title")?.textContent ?? "",
      );
      return titles.some((t) => t.includes(frag));
    },
    parentSel,
    fragment,
  );
}

/**
 * US-125 / US-148 / US-149 — task #36. ctrdh reported on 0.2.2 that a
 * child task (`买廉价的AI会员` with ➕ + ⏳ same-day stamps) is missing
 * from the parent's card even after the 0.2.1 CRLF fix shipped.
 *
 * Two test layouts based on Leo's analysis (msg `3f563978`):
 *   1. EXACT-SCREENSHOT: 5 direct children, last one has ➕ + ⏳ matching
 *      parent's date. (Wood ran this in earlier sessions and it passed —
 *      retrying on current main HEAD.)
 *   2. GRANDCHILD: Leo's hypothesis — top parent has ⏳, middle child has
 *      NO ⏳, grandchild has ⏳ same as top. renderSubcard's recursive
 *      filter compares grandchild.scheduled to middle-child.scheduled,
 *      so a same-as-top grandchild is dropped as "cross-day" because the
 *      middle child has no scheduled to compare against.
 */
describe("US-125 / US-148 / US-149 — children render under parent (task #36)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // Layout 1 — exact screenshot replay.
  it("EXACT — 5 direct children, last has ➕+⏳ matching parent's ⏳", async function () {
    const today = todayISO();
    const path = "Daily/2026-04-19.md";
    await writeAndWait(
      path,
      [
        `- [ ] AI-Native的人生 ⏳ ${today}`,
        `    - [ ] 由AI告诉我应该去做什么工作与内容`,
        `        - [ ] 搞cron，ai主动对于问题进行分析并处理`,
        `    - [ ] 由AI与我一起计划与组织生活`,
        `    - [x] 由AI告诉我应该看什么，比如Source是 [[Follow|folo]] ✅ 2026-04-24`,
        `    - [ ] 用AI整理笔记、浏览器书签、目录、1password`,
        `    - [ ] 买廉价的AI会员(GPT Plus\\Kimi) ➕ ${today} ⏳ ${today}`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();
    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await switchToWeekTab();

    const parentSel = `.task-center-view [data-date="${today}"] [data-task-id="${path}:L1"]`;
    await $(parentSel).waitForExist({ timeout: 5000 });

    await browser.waitUntil(
      async () => findInParent(parentSel, "买廉价的AI会员"),
      {
        timeout: 2000,
        timeoutMsg:
          "EXACT layout fail — 5th child (买廉价的AI会员) missing from parent's card",
      },
    );
  });

  // Layout 2 — Leo's grandchild hypothesis (msg `3f563978`).
  it("GRANDCHILD — top P (⏳ today) → middle C (no ⏳) → grandchild G (⏳ today) renders under P", async function () {
    const today = todayISO();
    const path = "Tasks/Inbox.md";
    await writeAndWait(
      path,
      [
        `- [ ] Top parent ⏳ ${today}`,
        `    - [ ] Middle child no schedule`,
        `        - [ ] Grandchild same-day-as-top ⏳ ${today}`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();
    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await switchToWeekTab();

    const parentSel = `.task-center-view [data-date="${today}"] [data-task-id="${path}:L1"]`;
    await $(parentSel).waitForExist({ timeout: 5000 });

    await browser.waitUntil(
      async () => findInParent(parentSel, "Grandchild same-day-as-top"),
      {
        timeout: 2000,
        timeoutMsg:
          "GRANDCHILD layout fail — grandchild with ⏳ matching top parent (but middle has no ⏳) was filtered out by renderSubcard recursive cross-day check (Leo hypothesis msg 3f563978)",
      },
    );
  });
});
