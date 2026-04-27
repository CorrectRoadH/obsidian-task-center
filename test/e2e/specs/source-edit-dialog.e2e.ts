/**
 * US-168: source edit panel replaces hover / double-click / open-source paths.
 *
 * Contract for implementation:
 *   data-source-edit-shell            — dialog-like source editor shell
 *   data-source-edit-task-id          — task id currently being edited
 *   data-source-edit-editor="obsidian-markdown-view" — shell hosts a real Obsidian MarkdownView
 *
 * These tests are intentionally red on the pre-US-168 implementation:
 * - clicking a card only selects it instead of opening source edit shell
 * - hover still opens `.bt-ctx-popover`
 * - context menu / Today actions still expose "open source"
 */
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

async function openBoardWithTask(path = "Tasks/Inbox.md", line = "- [ ] Source edit target") {
  const today = todayISO();
  await writeAndWait(
    path,
    [
      `- [ ] Parent context`,
      `    ${line} ⏳ ${today}`,
      `        - [ ] Existing child`,
      "",
    ].join("\n"),
  );
  await browser.executeObsidianCommand("obsidian-task-center:open");
  await forFlush();
  const card = $(`.task-center-view [data-task-id="${path}:L2"] .bt-card-meta`);
  await card.waitForExist({ timeout: 5000 });
  return { card, taskId: `${path}:L2` };
}

describe("US-168 source edit panel replaces old source-preview paths", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  afterEach(async function () {
    await browser.execute(() => {
      document.querySelector<HTMLElement>("[data-source-edit-action='close']")?.click();
      document.querySelector<HTMLElement>("[data-source-edit-shell]")?.remove();
    });
  });

  it("US-168a/b: clicking a normal task card opens a Markdown-backed source edit shell at that task", async function () {
    const { card, taskId } = await openBoardWithTask();
    const beforeViewType = (await browser.executeObsidian(async ({ app }) => {
      return app.workspace.activeLeaf?.view.getViewType() ?? null;
    })) as string | null;

    await card.click();

    const shell = $("[data-source-edit-shell]");
    await shell.waitForExist({ timeout: 5000 });
    await expect(shell).toHaveAttribute("data-source-edit-task-id", taskId);
    await expect(shell).toHaveAttribute("data-source-edit-editor", "obsidian-markdown-view");
    await expect($("[data-source-edit-markdown-view]")).toExist();
    await expect($("[data-source-edit-shell] .markdown-source-view, [data-source-edit-shell] .cm-editor")).toExist();
    await expect($(".task-center-view")).toExist();

    const afterViewType = (await browser.executeObsidian(async ({ app }) => {
      return app.workspace.activeLeaf?.view.getViewType() ?? null;
    })) as string | null;
    expect(beforeViewType).toBe("task-center-board");
    expect(afterViewType).toBe(beforeViewType);

    await browser.executeObsidian(async () => {
      const shell = document.querySelector("[data-source-edit-shell]");
      const editorEl = shell?.querySelector(".cm-editor");
      if (!editorEl) throw new Error("native CodeMirror editor is not rendered inside source shell");
      const view = (shell as unknown as {
        __sourceEditView?: {
          editor?: {
            replaceRange: (
              replacement: string,
              from: { line: number; ch: number },
              to?: { line: number; ch: number },
            ) => void;
          };
          save?: () => Promise<void>;
        };
      }).__sourceEditView;
      if (!view?.editor) throw new Error("native MarkdownView editor missing");
      view.editor.replaceRange(
        " edited in native editor",
        { line: 1, ch: "    - [ ] Source edit target".length },
      );
      await view.save?.();
    });
    await browser.waitUntil(
      async () => {
        const content = await browser.executeObsidian(async ({ app }, p: string) => {
          const f = app.vault.getAbstractFileByPath(p);
          if (!f) return "";
          // @ts-expect-error — runtime TFile
          return await app.vault.read(f);
        }, "Tasks/Inbox.md");
        return String(content).includes("Source edit target edited in native editor");
      },
      { timeout: 5000, timeoutMsg: "source edit dialog did not save markdown back to vault" },
    );

    await card.click();
    await shell.waitForExist({ timeout: 5000 });
    await browser.keys("Escape");
    await shell.waitForExist({ timeout: 5000, reverse: true });
    await expect($(".task-center-view")).toExist();
  });

  it("US-168d: hover popover and context-menu open-source entry are removed", async function () {
    const { card } = await openBoardWithTask();

    await card.moveTo();
    await browser.pause(800);
    await expect($(".bt-ctx-popover")).not.toExist();

    await card.click({ button: "right" });
    const menuTitleEls = await $$(".menu-item-title");
    const menuTitles = [];
    for (const el of menuTitleEls) menuTitles.push(await el.getText());
    expect(menuTitles.join("\n")).not.toMatch(/Open source|打开源文件/);
  });

  it("US-168a/d: Today cards use the same source edit shell and no longer expose open-source action buttons", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Today source edit target ⏳ ${today}\n    - [ ] Today child\n`,
    );

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();
    await $('[data-tab="today"]').click();

    const todayCard = $('[data-view="today"] [data-task-id="Tasks/Inbox.md:L1"]');
    await todayCard.waitForExist({ timeout: 5000 });
    await expect($('[data-view="today"] [data-action="open-source"]')).not.toExist();

    await todayCard.click();

    const shell = $("[data-source-edit-shell]");
    await shell.waitForExist({ timeout: 5000 });
    await expect(shell).toHaveAttribute("data-source-edit-task-id", "Tasks/Inbox.md:L1");
    await expect(shell).toHaveAttribute("data-source-edit-editor", "obsidian-markdown-view");
    await expect($("[data-source-edit-markdown-view]")).toExist();
    await expect($("[data-source-edit-shell] .markdown-source-view, [data-source-edit-shell] .cm-editor")).toExist();
  });
});
