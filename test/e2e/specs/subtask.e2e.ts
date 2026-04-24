import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const VAULT = "test/e2e/vaults/simple";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe("Task Center — inline + 子任务", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

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
      const tabs = document.querySelectorAll(".task-center-view .bt-tab");
      for (const t of Array.from(tabs)) {
        if (t.textContent?.includes("本周")) {
          (t as HTMLElement).click();
          return;
        }
      }
    });
    await browser.pause(300);
  }

  async function waitForCache(path: string) {
    await browser.executeObsidian(async ({ app }, p: string) => {
      await new Promise<void>((resolve) => {
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
    }, path);
  }

  async function writeAndWait(path: string, body: string) {
    await browser.executeObsidian(
      async ({ app }, p: string, content: string) => {
        let f = app.vault.getAbstractFileByPath(p);
        if (!f) {
          const folder = p.split("/").slice(0, -1).join("/");
          if (folder) {
            await app.vault.createFolder(folder).catch(() => undefined);
          }
          f = await app.vault.create(p, content);
        } else {
          // @ts-expect-error — runtime TFile
          await app.vault.modify(f, content);
        }
      },
      path,
      body,
    );
    await waitForCache(path);
  }

  it("adds a subtask under a parent task in the inbox", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Parent task ⏳ ${today}\n    - [ ] First child\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await browser.executeObsidianCommand("obsidian-task-center:reload-tasks");

    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await browser.pause(500);
    await switchToWeekTab();

    const parentSel = `.task-center-view .bt-card[data-task-id="Tasks/Inbox.md:L1"]`;
    await $(parentSel).waitForExist({ timeout: 5000 });

    const trigger = $(`${parentSel} .bt-subtask-add-trigger`);
    await trigger.waitForExist({ timeout: 5000 });
    await trigger.click();

    const input = $(`${parentSel} .bt-subtask-add-input`);
    await input.waitForExist({ timeout: 5000 });
    await input.setValue("Newly added subtask");

    const commit = $(`${parentSel} .bt-subtask-add-commit`);
    await commit.click();

    await browser.waitUntil(
      async () => (await readFile("Tasks/Inbox.md")).includes("Newly added subtask"),
      { timeout: 5000, timeoutMsg: "subtask never appeared in file" },
    );

    const content = await readFile("Tasks/Inbox.md");
    await expect(content).toContain("- [ ] Parent task");
    await expect(content).toContain("    - [ ] First child");
    await expect(content).toContain("    - [ ] Newly added subtask");

    // Verify the UI also shows the new subtask (not just the file).
    await browser.waitUntil(
      async () => {
        const texts = await browser.execute(() => {
          const els = document.querySelectorAll(".task-center-view .bt-subcard-title");
          return Array.from(els).map((e) => e.textContent);
        });
        return (texts as string[]).some((t) => t?.includes("Newly added subtask"));
      },
      { timeout: 3000, timeoutMsg: "new subtask never rendered in the UI" },
    );
  });

  it("adds a subtask when navigating to a past week (parent in older daily note)", async function () {
    // Reproduces the user's report: parent is in Daily/2026-04-12.md with
    // ⏳ 2026-04-12. User navigated back to that week (via ◀ button) so the
    // parent renders in that week's column. Clicking "+ 子任务", typing, and
    // clicking ✓ should add the child to the parent's source file.
    const dailyPath = `Daily/2026-04-12.md`;
    await writeAndWait(
      dailyPath,
      `- [ ] 用债务周期分析投资 ⏳ 2026-04-12\n    - [ ] 把cetus还有债务还清\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await browser.executeObsidianCommand("obsidian-task-center:reload-tasks");

    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await browser.pause(500);
    await switchToWeekTab();

    // Navigate back to the 2026-04-12 week by clicking ◀ repeatedly.
    // (Today is 2026-04-24, exactly 2 weeks back.)
    for (let i = 0; i < 2; i++) {
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

    const parentSel = `.task-center-view .bt-card[data-task-id="${dailyPath}:L1"]`;
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

  it("commits on Enter key (not just click) and the subtask is written", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Enter-commit parent ⏳ ${today}\n    - [ ] placeholder\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await browser.executeObsidianCommand("obsidian-task-center:reload-tasks");

    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await browser.pause(500);
    await switchToWeekTab();

    // Reset the week anchor to today (previous test may have navigated back).
    await browser.execute(() => {
      const btns = document.querySelectorAll(".task-center-view .bt-nav button");
      for (const b of Array.from(btns)) {
        if (b.textContent === "今天") {
          (b as HTMLElement).click();
          return;
        }
      }
    });
    await browser.pause(200);

    const parentSel = `.task-center-view .bt-card[data-task-id="Tasks/Inbox.md:L1"]`;
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
      { timeout: 5000, timeoutMsg: "Enter-committed subtask never appeared" },
    );
  });

  it("adds a subtask under a parent task living in a daily note", async function () {
    const today = todayISO();
    const dailyPath = `Daily/${today}.md`;
    await writeAndWait(
      dailyPath,
      `- [ ] Daily parent\n    - [ ] Existing child\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await browser.executeObsidianCommand("obsidian-task-center:reload-tasks");

    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await browser.pause(500);
    await switchToWeekTab();

    const parentSel = `.task-center-view .bt-card[data-task-id="${dailyPath}:L1"]`;
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
