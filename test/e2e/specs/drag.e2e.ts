/**
 * US-121: Dragging a card to a different day column rewrites ⏳ in the markdown file.
 * US-123: Dragging a card to the trash zone marks it dropped ([-] ❌) in the markdown file.
 *
 * DOM coupling is limited to stable data-attributes agreed with Tiger:
 *   [data-task-id="path:LN"]    — task card stable identifier
 *   [data-date="YYYY-MM-DD"]    — day-column drop target
 *   [data-drop-zone="trash"]    — trash area drop target
 *
 * All final assertions are against markdown file content, not CSS classes.
 */
import { browser, expect } from "@wdio/globals";
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
    await (app as any).plugins.plugins["obsidian-task-center"].__forFlush();
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

async function openBoardWeekView() {
  await browser.executeObsidianCommand("obsidian-task-center:open");
  await forFlush();
  // Switch to the week tab if not already there.
  await browser.execute(() => {
    const tabs = document.querySelectorAll(".task-center-view [role='tab'], .task-center-view .bt-tab");
    for (const t of Array.from(tabs)) {
      if (t.textContent?.includes("本周") || t.textContent?.includes("Week")) {
        (t as HTMLElement).click();
        return;
      }
    }
  });
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

describe("Task Center — 拖拽 (US-121/123)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-121: drag a card to a different day column → ⏳ in the file changes
  it("US-121: dragging a card to another day updates ⏳ scheduled date in markdown", async function () {
    const today = todayISO();
    const tomorrow = offsetISO(1);
    const path = "Tasks/Inbox.md";

    await writeAndWait(path, `- [ ] Drag-reschedule task ⏳ ${today}\n`);
    await openBoardWeekView();

    const cardSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    const targetSel = `.task-center-view [data-date="${tomorrow}"]`;

    await $(cardSel).waitForExist({ timeout: 5000 });
    await $(targetSel).waitForExist({ timeout: 5000, timeoutMsg: `day column [data-date="${tomorrow}"] not found` });

    await $(cardSel).dragAndDrop($(targetSel));

    await browser.waitUntil(
      async () => (await readFile(path)).includes(`⏳ ${tomorrow}`),
      { timeout: 5000, timeoutMsg: "⏳ date was not updated after drag" },
    );

    const content = await readFile(path);
    await expect(content).toContain(`⏳ ${tomorrow}`);
    await expect(content).not.toContain(`⏳ ${today}`);
  });

  // US-123: drag a card to the trash → markdown becomes [-] ❌
  it("US-123: dragging a card to the trash marks it dropped in markdown", async function () {
    const today = todayISO();
    const path = "Tasks/Inbox.md";

    await writeAndWait(path, `- [ ] Trash-drop task ⏳ ${today}\n`);
    await openBoardWeekView();

    const cardSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    const trashSel = `.task-center-view [data-drop-zone="trash"]`;

    await $(cardSel).waitForExist({ timeout: 5000 });
    await $(trashSel).waitForExist({ timeout: 5000, timeoutMsg: `trash zone [data-drop-zone="trash"] not found` });

    await $(cardSel).dragAndDrop($(trashSel));

    await browser.waitUntil(
      async () => (await readFile(path)).includes("[-]"),
      { timeout: 5000, timeoutMsg: "task was not dropped after dragging to trash" },
    );

    const content = await readFile(path);
    await expect(content).toMatch(/\[-\].*❌/);
  });
});
