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

async function forFlush() {
  await browser.executeObsidian(async ({ app }) => {
    // @ts-expect-error - runtime plugin
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
        // @ts-expect-error - runtime TFile
        await app.vault.modify(f, content);
      }
      await new Promise<void>((resolve) => {
        // @ts-expect-error - runtime TFile
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
    // @ts-expect-error - runtime TFile
    return await app.vault.read(f);
  }, path)) as unknown as string;
}

async function switchToWeekTab() {
  await browser.execute(() => {
    const tab = document.querySelector<HTMLElement>(".task-center-view [data-tab='week']");
    tab?.click();
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

async function openBoardToTask(taskId: string) {
  await browser.executeObsidianCommand("obsidian-task-center:open");
  await forFlush();
  await $(".task-center-view").waitForExist({ timeout: 5000 });
  await switchToWeekTab();
  const card = $(`.task-center-view [data-task-id="${taskId}"]`);
  await card.waitForExist({ timeout: 5000 });
  await expect($(".task-center-view .bt-subtask-add-trigger")).not.toExist();
  await expect($(".task-center-view .bt-subtask-add-input")).not.toExist();
  return card;
}

async function editSourceAtLine(taskId: string, line: number, text: string) {
  const card = await openBoardToTask(taskId);
  await card.click();
  const shell = $("[data-source-edit-shell]");
  await shell.waitForExist({ timeout: 5000 });
  await browser.executeObsidian(
    async (_ctx, taskLine: number, childText: string) => {
      const shell = document.querySelector("[data-source-edit-shell]");
      const view = (shell as unknown as {
        __sourceEditView?: {
          editor?: {
            getLine: (line: number) => string;
            replaceRange: (replacement: string, from: { line: number; ch: number }) => void;
          };
          save?: () => Promise<void>;
        };
      })?.__sourceEditView;
      if (!view?.editor) throw new Error("source edit MarkdownView editor missing");
      const parentLine = view.editor.getLine(taskLine);
      view.editor.replaceRange(`\n    - [ ] ${childText}`, { line: taskLine, ch: parentLine.length });
      await view.save?.();
    },
    line,
    text,
  );
  await browser.keys("Escape");
  await shell.waitForExist({ timeout: 5000, reverse: true });
  await forFlush();
}

describe("Task Center - subtasks via source edit (US-141/162/168)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  it("adds a subtask under a parent task in the inbox through source edit", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Parent task ⏳ ${today}\n    - [ ] First child\n`);

    await editSourceAtLine("Tasks/Inbox.md:L1", 0, "Newly added subtask");

    const content = await readFile("Tasks/Inbox.md");
    await expect(content).toContain("- [ ] Parent task");
    await expect(content).toContain("    - [ ] First child");
    await expect(content).toContain("    - [ ] Newly added subtask");
    await browser.waitUntil(
      async () => {
        const texts = await browser.execute(() =>
          Array.from(document.querySelectorAll(".task-center-view .bt-subcard-title")).map((e) => e.textContent),
        );
        return (texts as string[]).some((t) => t?.includes("Newly added subtask"));
      },
      { timeout: 3000, timeoutMsg: "new source-edited subtask never rendered in the UI" },
    );
  });

  it("US-142a keeps subtask rows draggable while the status circle is a separate control", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Parent task ⏳ ${today}\n    - [ ] Child one\n`);

    await openBoardToTask("Tasks/Inbox.md:L1");

    const subcardSel = `.task-center-view .bt-subcard[data-task-id="Tasks/Inbox.md:L2"]`;
    await $(subcardSel).waitForExist({ timeout: 5000 });
    const shape = (await browser.execute((selector: string) => {
      const subcard = document.querySelector<HTMLElement>(selector);
      const check = subcard?.querySelector<HTMLElement>(".bt-sub-check");
      if (!subcard || !check) return null;
      return {
        draggable: subcard.draggable,
        rowCursor: getComputedStyle(subcard).cursor,
        checkTag: check.tagName,
        checkCursor: getComputedStyle(check).cursor,
        checkAction: check.dataset.cardAction,
        checkLabel: check.getAttribute("aria-label"),
      };
    }, subcardSel)) as {
      draggable: boolean;
      rowCursor: string;
      checkTag: string;
      checkCursor: string;
      checkAction?: string;
      checkLabel: string | null;
    } | null;

    expect(shape).not.toBeNull();
    expect(shape?.draggable).toBe(true);
    expect(["grab", "grabbing"]).not.toContain(shape?.rowCursor);
    expect(shape?.checkTag).toBe("BUTTON");
    expect(shape?.checkCursor).toBe("pointer");
    expect(shape?.checkAction).toBe("done");
    expect(shape?.checkLabel).toBeTruthy();

    await $(`${subcardSel} .bt-sub-check`).click();
    await forFlush();
    await expect($("[data-source-edit-shell]")).not.toExist();
    await browser.waitUntil(
      async () => (await readFile("Tasks/Inbox.md")).includes("    - [x] Child one"),
      { timeout: 3000, timeoutMsg: "subtask status circle did not toggle the child task" },
    );
  });

  it("adds a subtask when parent is in a past week's daily note through source edit", async function () {
    const pastDate = offsetISO(-14);
    const dailyPath = `Daily/${pastDate}.md`;
    await writeAndWait(dailyPath, `- [ ] 用债务周期分析投资 ⏳ ${pastDate}\n    - [ ] 把cetus还有债务还清\n`);

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();
    await $(".task-center-view").waitForExist({ timeout: 5000 });
    await switchToWeekTab();
    for (let i = 0; i < 2; i++) {
      await browser.execute(() => {
        document.querySelector<HTMLElement>(".task-center-view [data-action='nav-prev']")?.click();
      });
    }
    await $(`.task-center-view [data-date='${pastDate}']`).waitForExist({
      timeout: 3000,
      timeoutMsg: `week containing ${pastDate} did not appear after navigating back`,
    });

    const card = $(`.task-center-view [data-task-id="${dailyPath}:L1"]`);
    await card.waitForExist({ timeout: 5000 });
    await expect($(".task-center-view .bt-subtask-add-trigger")).not.toExist();
    await card.click();
    const shell = $("[data-source-edit-shell]");
    await shell.waitForExist({ timeout: 5000 });
    await browser.executeObsidian(async () => {
      const shell = document.querySelector("[data-source-edit-shell]");
      const view = (shell as unknown as {
        __sourceEditView?: {
          editor?: {
            getLine: (line: number) => string;
            replaceRange: (replacement: string, from: { line: number; ch: number }) => void;
          };
          save?: () => Promise<void>;
        };
      })?.__sourceEditView;
      if (!view?.editor) throw new Error("source edit MarkdownView editor missing");
      const parentLine = view.editor.getLine(0);
      view.editor.replaceRange("\n    - [ ] 新子任务", { line: 0, ch: parentLine.length });
      await view.save?.();
    });
    await browser.keys("Escape");
    await shell.waitForExist({ timeout: 5000, reverse: true });
    await forFlush();

    const content = await readFile(dailyPath);
    await expect(content).toContain("    - [ ] 新子任务");
  });

  it("adds a subtask to a parent living in a daily note through source edit", async function () {
    const today = todayISO();
    const dailyPath = `Daily/${today}.md`;
    await writeAndWait(dailyPath, "- [ ] Daily parent\n    - [ ] Existing child\n");

    await editSourceAtLine(`${dailyPath}:L1`, 0, "Daily note subtask");

    const content = await readFile(dailyPath);
    await expect(content).toContain("- [ ] Daily parent");
    await expect(content).toContain("    - [ ] Existing child");
    await expect(content).toContain("    - [ ] Daily note subtask");
  });
});
