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

/** Write file content and wait for cache, then poll until file matches expected content. */
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

async function switchToWeekTab() {
  await browser.execute(() => {
    const tabs = document.querySelectorAll(".task-center-view [role='tab'], .task-center-view .bt-tab");
    for (const t of Array.from(tabs)) {
      if (t.textContent?.includes("本周") || t.textContent?.includes("Week")) {
        (t as HTMLElement).click();
        return;
      }
    }
  });
  // Use waitUntil instead of a fixed pause — cheaper and more reliable.
  await browser.waitUntil(
    async () => {
      const active = await browser.execute(() => {
        const el = document.querySelector(
          ".task-center-view [role='tab'][aria-selected='true'], .task-center-view .bt-tab.active",
        );
        return el?.textContent ?? "";
      });
      return String(active).includes("本周") || String(active).includes("Week");
    },
    { timeout: 3000, interval: 100, timeoutMsg: "Week tab did not become active" },
  );
}

describe("Task Center — 子任务 (US-141/162)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-141/162: add a subtask via the UI button
  it("adds a subtask under a parent task in the inbox", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Parent task ⏳ ${today}\n    - [ ] First child\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await switchToWeekTab();

    const parentSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    await $(parentSel).waitForExist({ timeout: 5000 });

    // Click the add-subtask trigger (semantic: any button/element with subtask-add role or class)
    const trigger = $(`${parentSel} .bt-subtask-add-trigger`);
    await trigger.waitForExist({ timeout: 5000 });
    await trigger.click();

    const input = $(`${parentSel} .bt-subtask-add-input`);
    await input.waitForExist({ timeout: 5000 });
    await input.setValue("Newly added subtask");

    const commit = $(`${parentSel} .bt-subtask-add-commit`);
    await commit.click();

    // Primary assertion: the markdown file was updated correctly.
    await browser.waitUntil(
      async () => (await readFile("Tasks/Inbox.md")).includes("Newly added subtask"),
      { timeout: 5000, timeoutMsg: "subtask never appeared in file" },
    );

    const content = await readFile("Tasks/Inbox.md");
    await expect(content).toContain("- [ ] Parent task");
    await expect(content).toContain("    - [ ] First child");
    await expect(content).toContain("    - [ ] Newly added subtask");

    // Secondary: UI also shows the new subtask.
    await browser.waitUntil(
      async () => {
        const texts = await browser.execute(() =>
          Array.from(document.querySelectorAll(".task-center-view .bt-subcard-title")).map(
            (e) => e.textContent,
          ),
        );
        return (texts as string[]).some((t) => t?.includes("Newly added subtask"));
      },
      { timeout: 3000, timeoutMsg: "new subtask never rendered in the UI" },
    );
  });

  // US-141: subtask added to a past-week parent (regression for daily-note + week navigation)
  it("adds a subtask when parent is in a past week's daily note", async function () {
    const dailyPath = `Daily/2026-04-12.md`;
    await writeAndWait(
      dailyPath,
      `- [ ] 用债务周期分析投资 ⏳ 2026-04-12\n    - [ ] 把cetus还有债务还清\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await switchToWeekTab();

    // Navigate back until the 2026-04-12 week is visible.
    for (let i = 0; i < 3; i++) {
      await browser.execute(() => {
        const btns = document.querySelectorAll(".task-center-view .bt-nav button");
        for (const b of Array.from(btns)) {
          if (b.textContent === "◀") {
            (b as HTMLElement).click();
            return;
          }
        }
      });
      await browser.pause(150);
    }

    const parentSel = `.task-center-view [data-task-id="${dailyPath}:L1"]`;
    await $(parentSel).waitForExist({ timeout: 5000 });

    const trigger = $(`${parentSel} .bt-subtask-add-trigger`);
    await trigger.waitForExist({ timeout: 5000 });
    await trigger.click();

    const input = $(`${parentSel} .bt-subtask-add-input`);
    await input.waitForExist({ timeout: 5000 });
    await input.setValue("新子任务");

    const commit = $(`${parentSel} .bt-subtask-add-commit`);
    await commit.click();

    await browser.waitUntil(
      async () => (await readFile(dailyPath)).includes("新子任务"),
      { timeout: 5000, timeoutMsg: "past-week subtask never appeared in file" },
    );

    const content = await readFile(dailyPath);
    await expect(content).toContain("    - [ ] 新子任务");
  });

  // US-162: Enter key commits the new subtask
  it("commits subtask on Enter key press", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Enter-commit parent ⏳ ${today}\n    - [ ] placeholder\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await switchToWeekTab();

    // Reset to current week in case a previous test navigated away.
    await browser.execute(() => {
      const btns = document.querySelectorAll(".task-center-view .bt-nav button");
      for (const b of Array.from(btns)) {
        if (b.textContent === "今天" || b.textContent === "Today") {
          (b as HTMLElement).click();
          return;
        }
      }
    });
    await browser.pause(150);

    const parentSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    await $(parentSel).waitForExist({ timeout: 5000 });

    const trigger = $(`${parentSel} .bt-subtask-add-trigger`);
    await trigger.waitForExist({ timeout: 5000 });
    await trigger.click();

    const input = $(`${parentSel} .bt-subtask-add-input`);
    await input.waitForExist({ timeout: 5000 });
    await input.click();
    await browser.keys("Enter-commit child".split(""));
    await browser.keys(["Enter"]);

    await browser.waitUntil(
      async () => (await readFile("Tasks/Inbox.md")).includes("Enter-commit child"),
      { timeout: 5000, timeoutMsg: "Enter-committed subtask never appeared in file" },
    );
  });

  // US-141/162: subtask added to a parent in a daily note (no ⏳ on parent)
  it("adds a subtask to a parent living in a daily note (no scheduled date)", async function () {
    const today = todayISO();
    const dailyPath = `Daily/${today}.md`;
    await writeAndWait(
      dailyPath,
      `- [ ] Daily parent\n    - [ ] Existing child\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await switchToWeekTab();

    const parentSel = `.task-center-view [data-task-id="${dailyPath}:L1"]`;
    await $(parentSel).waitForExist({ timeout: 5000 });

    const trigger = $(`${parentSel} .bt-subtask-add-trigger`);
    await trigger.waitForExist({ timeout: 5000 });
    await trigger.click();

    const input = $(`${parentSel} .bt-subtask-add-input`);
    await input.waitForExist({ timeout: 5000 });
    await input.setValue("Daily note subtask");

    const commit = $(`${parentSel} .bt-subtask-add-commit`);
    await commit.click();

    await browser.waitUntil(
      async () => (await readFile(dailyPath)).includes("Daily note subtask"),
      { timeout: 5000, timeoutMsg: "daily-note subtask never appeared in file" },
    );

    const content = await readFile(dailyPath);
    await expect(content).toContain("- [ ] Daily parent");
    await expect(content).toContain("    - [ ] Existing child");
    await expect(content).toContain("    - [ ] Daily note subtask");
  });
});
