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

/** See parent-child.e2e.ts for the same helper — picks an in-week neighbor. */
function inWeekNeighbor(): string {
  const d = new Date();
  d.setDate(d.getDate() + (d.getDay() === 0 ? -1 : 1));
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

/**
 * Synthetic HTML5 DnD: fires dragstart → dragenter → dragover → drop → dragend
 * using a shared DataTransfer carrying "text/task-id". wdio's built-in
 * dragAndDrop does not reliably trigger Chromium's HTML5 DnD for day columns,
 * but dispatching events directly bypasses the browser's gesture requirements.
 */
async function simulateDrag(srcSel: string, tgtSel: string) {
  await browser.execute(
    (src: string, tgt: string) => {
      const srcEl = document.querySelector<HTMLElement>(src);
      const tgtEl = document.querySelector<HTMLElement>(tgt);
      if (!srcEl || !tgtEl) throw new Error(`simulateDrag: missing ${src} | ${tgt}`);
      const taskId = srcEl.dataset.taskId ?? "";
      const dt = new DataTransfer();
      dt.setData("text/task-id", taskId);
      const mk = (type: string) =>
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      srcEl.dispatchEvent(mk("dragstart"));
      tgtEl.dispatchEvent(mk("dragenter"));
      tgtEl.dispatchEvent(mk("dragover"));
      tgtEl.dispatchEvent(mk("drop"));
      srcEl.dispatchEvent(mk("dragend"));
    },
    srcSel,
    tgtSel,
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

async function openBoardWeekView() {
  await browser.executeObsidianCommand("obsidian-task-center:open");
  await forFlush();
  // Switch to the week tab if not already there.
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

describe("Task Center — 拖拽 (US-121/123)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-121: drag a card to a different day column → ⏳ in the file changes
  it("US-121: dragging a card to another day updates ⏳ scheduled date in markdown", async function () {
    const today = todayISO();
    const tomorrow = inWeekNeighbor();
    const path = "Tasks/Inbox.md";

    await writeAndWait(path, `- [ ] Drag-reschedule task ⏳ ${today}\n`);
    await openBoardWeekView();

    const cardSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    const targetSel = `.task-center-view [data-date="${tomorrow}"]`;

    await $(cardSel).waitForExist({ timeout: 5000 });
    await $(targetSel).waitForExist({ timeout: 5000, timeoutMsg: `day column [data-date="${tomorrow}"] not found` });

    await simulateDrag(cardSel, targetSel);

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

    await simulateDrag(cardSel, trashSel);

    await browser.waitUntil(
      async () => (await readFile(path)).includes("[-]"),
      { timeout: 5000, timeoutMsg: "task was not dropped after dragging to trash" },
    );

    const content = await readFile(path);
    await expect(content).toMatch(/\[-\].*❌/);
  });

  // task #37: drag C onto A's card when A already has child B should nest C as
  // A's direct child (sibling of B), not as B's subtask.
  //
  // Root cause: in real browser DnD the pointer lands on B's bt-subcard element
  // (the deepest DOM node at the cursor position, because B is rendered inside
  // A's card). B's wireCardEvents dragover handler fires stopPropagation, so
  // A's handler never runs. The drop then fires on B, calling api.nest(C, B)
  // instead of api.nest(C, A).
  //
  // This test reproduces the bug by dispatching drop directly to B's subcard
  // element (simulating the browser's hit-test result).
  it("task #37: drag-nest onto parent card with existing child nests as direct child, not grandchild", async function () {
    const today = todayISO();
    const path = "Tasks/Inbox.md";

    // A (parent, has child B) + C as a top-level sibling of A
    await writeAndWait(
      path,
      `- [ ] A ⏳ ${today}\n    - [ ] B\n- [ ] C ⏳ ${today}\n`,
    );
    await openBoardWeekView();

    // A's card and B's subcard (nested inside A)
    const aCardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    const bSubcardSel = `.task-center-view [data-task-id="${path}:L2"]`;
    const cCardSel = `.task-center-view [data-task-id="${path}:L3"]`;

    await $(aCardSel).waitForExist({ timeout: 5000 });
    await $(bSubcardSel).waitForExist({ timeout: 5000 });
    await $(cCardSel).waitForExist({ timeout: 5000 });

    // Simulate the browser's real DnD path: the cursor is over B's subcard
    // (which occupies the lower half of A's visible card area). B's drop handler
    // fires and currently nests C under B instead of A.
    await simulateDrag(cCardSel, bSubcardSel);

    await browser.waitUntil(
      async () => {
        const c = await readFile(path);
        // After fix: C must appear at 4-space indent (direct child of A).
        // Fail-fast: if 8-space indent appears first, the bug is still present.
        return c.includes("    - [ ] C") || c.includes("        - [ ] C");
      },
      { timeout: 5000, timeoutMsg: "C was not nested anywhere after drag" },
    );

    const content = await readFile(path);
    // C must be A's direct child (4-space), sibling of B — not B's subtask (8-space)
    await expect(content).not.toContain("        - [ ] C");
    await expect(content).toContain("    - [ ] C");
  });

  it("task #106: dragging an inline subtask to another day schedules the child, not the parent", async function () {
    const today = todayISO();
    const tomorrow = inWeekNeighbor();
    const path = "Tasks/Inbox.md";

    await writeAndWait(
      path,
      `- [ ] Parent scheduled today ⏳ ${today}\n    - [ ] Child dragged to another day\n`,
    );
    await openBoardWeekView();

    const parentCardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    const childSubcardSel = `.task-center-view [data-task-id="${path}:L2"]`;
    const targetSel = `.task-center-view [data-date="${tomorrow}"]`;

    await $(parentCardSel).waitForExist({ timeout: 5000 });
    await $(childSubcardSel).waitForExist({ timeout: 5000 });
    await $(targetSel).waitForExist({ timeout: 5000, timeoutMsg: `day column [data-date="${tomorrow}"] not found` });

    await simulateDrag(childSubcardSel, targetSel);

    await browser.waitUntil(
      async () => (await readFile(path)).includes(`Child dragged to another day ⏳ ${tomorrow}`),
      { timeout: 5000, timeoutMsg: "child was not scheduled after dragging subtask" },
    );

    const content = await readFile(path);
    await expect(content).toContain(`- [ ] Parent scheduled today ⏳ ${today}`);
    await expect(content).toContain(`    - [ ] Child dragged to another day ⏳ ${tomorrow}`);
    await expect(content).not.toContain(`- [ ] Parent scheduled today ⏳ ${tomorrow}`);
  });

  it("task #106: right-clicking an inline subtask targets the child task only", async function () {
    const today = todayISO();
    const path = "Tasks/Inbox.md";

    await writeAndWait(
      path,
      `- [ ] Parent with child menu ⏳ ${today}\n    - [ ] Child context target\n`,
    );
    await openBoardWeekView();

    const childSubcardSel = `.task-center-view [data-task-id="${path}:L2"]`;
    await $(childSubcardSel).waitForExist({ timeout: 5000 });

    const seen = await browser.execute((sel: string) => {
      const app = (window as unknown as {
        app?: {
          workspace?: {
            getLeavesOfType?: (type: string) => Array<{ view?: unknown }>;
          };
        };
      }).app;
      const leaf = app?.workspace?.getLeavesOfType?.("task-center-board")?.[0];
      const view = leaf?.view as unknown as {
        openContextMenu?: (e: MouseEvent, task: { id: string }) => void;
      };
      if (!view?.openContextMenu) throw new Error("Task Center view/openContextMenu not found");
      const calls: string[] = [];
      const original = view.openContextMenu.bind(view);
      view.openContextMenu = (e: MouseEvent, task: { id: string }) => {
        calls.push(task.id);
        e.preventDefault();
      };
      try {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) throw new Error(`missing subcard ${sel}`);
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
        return calls;
      } finally {
        view.openContextMenu = original;
      }
    }, childSubcardSel);

    await expect(seen).toEqual([`${path}:L2`]);
  });

});
