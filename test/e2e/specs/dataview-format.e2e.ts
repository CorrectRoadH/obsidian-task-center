/**
 * US-111: Dataview flavor must support the same user journeys as Tasks emoji.
 *
 * Coverage mirrors the existing Tasks journeys:
 *   - board read path: Dataview [scheduled::] tasks render on the board
 *   - drag path: reschedule / unschedule write Dataview fields
 *   - CLI API path: schedule / done / drop / add write Dataview fields
 *
 * Assertions inspect markdown content so the contract stays format-level,
 * independent of visual styling.
 */
import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const VAULT = "test/e2e/vaults/simple";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function inWeekNeighbor(): string {
  const d = new Date();
  d.setDate(d.getDate() + (d.getDay() === 0 ? -1 : 1));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function writeAndWait(path: string, body: string) {
  await browser.reloadObsidian({ vault: VAULT });
  await setDataviewFlavor();
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
  await browser.executeObsidian(async ({ app }, p: string) => {
    // @ts-expect-error — runtime plugin test hook
    await app.plugins.plugins["task-center"].cache.invalidateFile(p);
    // @ts-expect-error — runtime plugin test hook
    await app.plugins.plugins["task-center"].__forFlush();
  }, path);
}

async function readFile(path: string): Promise<string> {
  return (await browser.executeObsidian(async ({ app }, p: string) => {
    const f = app.vault.getAbstractFileByPath(p);
    if (!f) return "";
    // @ts-expect-error — runtime TFile
    return await app.vault.read(f);
  }, path)) as unknown as string;
}

async function forFlush() {
  await browser.executeObsidian(async ({ app }) => {
    // @ts-expect-error — runtime plugin
    await (app as any).plugins.plugins["task-center"].__forFlush();
  });
}

async function setDataviewFlavor() {
  await browser.executeObsidian(async ({ app }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = (app as any).plugins.plugins["task-center"];
    plugin.settings.taskFormatFlavor = "dataview";
    await plugin.saveSettings();
  });
}

async function openBoardWeekView() {
  await browser.executeObsidianCommand("task-center:open");
  await forFlush();
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

async function callApi<T>(
  fn: (api: {
    add(opts: {
      text: string;
      to?: string;
      scheduled?: string;
      stampCreated?: boolean;
    }): Promise<{ path: string; line: number; created: string }>;
    done(id: string): Promise<{ before: string; after: string; unchanged: boolean }>;
    drop(id: string): Promise<{ before: string; after: string; unchanged: boolean }>;
    schedule(id: string, date: string | null): Promise<{ before: string; after: string; unchanged: boolean }>;
  }) => Promise<T>,
): Promise<T> {
  return (await browser.executeObsidian(async ({ app }, fnSrc: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = (app as any).plugins?.getPlugin?.("task-center");
    if (!plugin?.api) throw new Error("plugin api not found");
    // eslint-disable-next-line no-new-func
    const callable = new Function("api", `return (${fnSrc})(api)`);
    return await callable(plugin.api);
  }, fn.toString())) as T;
}

describe("Task Center — Dataview task format flavor (US-111)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    await setDataviewFlavor();
  });

  it("US-111: board renders Dataview scheduled tasks", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Dataview board task [scheduled:: ${today}]\n`);

    await openBoardWeekView();

    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
  });

  it("US-111/US-121/US-122a: drag reschedule and unschedule use Dataview scheduled field", async function () {
    const today = todayISO();
    const tomorrow = inWeekNeighbor();
    const path = "Tasks/Inbox.md";
    await writeAndWait(path, `- [ ] Dataview drag task [scheduled:: ${today}]\n`);
    await openBoardWeekView();

    const cardSel = `.task-center-view [data-task-id="${path}:L1"]`;
    const targetSel = `.task-center-view [data-date="${tomorrow}"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });
    await $(targetSel).waitForExist({ timeout: 5000 });

    await simulateDrag(cardSel, targetSel);
    await browser.waitUntil(
      async () => (await readFile(path)).includes(`[scheduled:: ${tomorrow}]`),
      { timeout: 5000, timeoutMsg: "Dataview scheduled field was not updated after drag" },
    );

    let content = await readFile(path);
    await expect(content).toContain(`[scheduled:: ${tomorrow}]`);
    await expect(content).not.toContain(`[scheduled:: ${today}]`);
    await expect(content).not.toContain("⏳");

    const traySel = `.task-center-view [data-drop-zone="unscheduled-tray"]`;
    await $(traySel).waitForExist({ timeout: 5000 });
    await simulateDrag(cardSel, traySel);

    await browser.waitUntil(
      async () => !(await readFile(path)).includes("[scheduled::"),
      { timeout: 5000, timeoutMsg: "Dataview scheduled field was not cleared after tray drag" },
    );

    content = await readFile(path);
    await expect(content).toContain("- [ ] Dataview drag task");
    await expect(content).not.toContain("[scheduled::");
    await expect(content).not.toContain("⏳");
  });

  it("US-111/US-203/US-204: CLI mutations use Dataview fields for schedule, done, and drop", async function () {
    const today = todayISO();
    const path = "Tasks/Inbox.md";
    await writeAndWait(
      path,
      `- [ ] Dataview schedule task [scheduled:: ${today}]\n- [ ] Dataview done task [scheduled:: ${today}]\n- [ ] Dataview drop task [scheduled:: ${today}]\n`,
    );
    await forFlush();

    const scheduled = await callApi((api) => api.schedule("Tasks/Inbox.md:L1", "2099-12-31"));
    await expect(scheduled.after).toContain("[scheduled:: 2099-12-31]");
    await expect(scheduled.after).not.toContain("⏳");

    await forFlush();

    const done = await callApi((api) => api.done("Tasks/Inbox.md:L2"));
    await expect(done.after).toContain("[x]");
    await expect(done.after).toMatch(/\[completion:: \d{4}-\d{2}-\d{2}\]/);
    await expect(done.after).not.toContain("✅");

    await forFlush();

    const dropped = await callApi((api) => api.drop("Tasks/Inbox.md:L3"));
    await expect(dropped.after).toContain("[-]");
    await expect(dropped.after).toMatch(/\[cancelled:: \d{4}-\d{2}-\d{2}\]/);
    await expect(dropped.after).not.toContain("❌");

    const content = await readFile(path);
    await expect(content).toContain("[scheduled:: 2099-12-31]");
    await expect(content).toMatch(/Dataview done task.*\[completion:: \d{4}-\d{2}-\d{2}\]/);
    await expect(content).toMatch(/Dataview drop task.*\[cancelled:: \d{4}-\d{2}-\d{2}\]/);
    await expect(content).not.toContain("⏳");
    await expect(content).not.toContain("✅");
    await expect(content).not.toContain("❌");
  });

  it("US-111: CLI add writes new task metadata in Dataview flavor", async function () {
    await callApi((api) =>
      api.add({
        text: "Dataview add task",
        to: "Tasks/Inbox.md",
        scheduled: "2099-12-31",
        stampCreated: true,
      }),
    );

    const content = await readFile("Tasks/Inbox.md");
    await expect(content).toContain("- [ ] Dataview add task");
    await expect(content).toContain("[scheduled:: 2099-12-31]");
    await expect(content).toMatch(/\[created:: \d{4}-\d{2}-\d{2}\]/);
    await expect(content).not.toContain("⏳");
    await expect(content).not.toContain("➕");
  });
});
