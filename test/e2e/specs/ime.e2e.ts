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

async function readFile(path: string): Promise<string> {
  return (await browser.executeObsidian(async ({ app }, p: string) => {
    const f = app.vault.getAbstractFileByPath(p);
    if (!f) return "";
    // @ts-expect-error — runtime TFile
    return await app.vault.read(f);
  }, path)) as unknown as string;
}

/**
 * US-413 — vault-wide IME composition guard. While the user is composing
 * (typing pinyin/kana/hangul before candidate selection), Enter only
 * commits the IME selection — it must NOT submit the surrounding form.
 *
 * This file covers the two view.ts inline editors (chunks b + c). The
 * Quick Add modal case (chunk a) lives in quickadd.e2e.ts to keep its
 * fixture setup adjacent to the other Quick Add v2 cases.
 */
describe("Task Center — IME composition guard (US-413)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-413 chunk b — inline rename input. Click the card title to enter
  // edit mode, dispatch IME composition + Enter, assert the file body
  // is NOT renamed (the rename commit() path was suppressed).
  it("US-413 chunk b — inline rename Enter during IME composition must not commit", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Original title ⏳ ${today}\n`);

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    const cardSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });

    // Click title to enter edit mode.
    await browser.execute((sel: string) => {
      const title = document.querySelector(`${sel} .bt-card-title`) as HTMLElement | null;
      title?.click();
    }, cardSel);

    const input = $(`${cardSel} .bt-title-edit`);
    await input.waitForExist({ timeout: 3000 });

    // Type a new value, then dispatch IME composition + Enter.
    await browser.execute((sel: string) => {
      const el = document.querySelector(
        `${sel} .bt-title-edit`,
      ) as HTMLInputElement | null;
      if (!el) return;
      el.value = "Renamed mid-composition";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const evt = new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(evt, "isComposing", { value: true });
      el.dispatchEvent(evt);
    }, cardSel);

    // Settle, then read the file: rename must NOT have happened (commit
    // path was guarded). The file should still hold the original title.
    await browser.pause(200);
    const content = await readFile("Tasks/Inbox.md");
    expect(content).toContain("Original title");
    expect(content).not.toContain("Renamed mid-composition");

    // Cleanup: the input still has "Renamed mid-composition" in its
    // value; without dismissal its blur listener (intentional UX —
    // click-away saves) would async-commit between this test and the
    // next, polluting chunk c's fixture. Esc → commit(save=false) is
    // the explicit cancel path and tears down the editor cleanly.
    await browser.execute((sel: string) => {
      const el = document.querySelector(
        `${sel} .bt-title-edit`,
      ) as HTMLInputElement | null;
      if (!el) return;
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    }, cardSel);
    await browser.pause(100);
  });

  // US-413 chunk c — subtask add input. Open the add-subtask editor,
  // dispatch IME composition + Enter, assert no subtask was created.
  it("US-413 chunk c — subtask add Enter during IME composition must not commit", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Parent task ⏳ ${today}\n`);

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    const parentSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    await $(parentSel).waitForExist({ timeout: 5000 });

    // Click the add-subtask trigger to enter edit mode.
    await browser.execute((sel: string) => {
      const trigger = document.querySelector(
        `${sel} .bt-subtask-add-trigger`,
      ) as HTMLElement | null;
      trigger?.click();
    }, parentSel);

    const input = $(`${parentSel} .bt-subtask-add-input`);
    await input.waitForExist({ timeout: 3000 });

    await browser.execute((sel: string) => {
      const el = document.querySelector(
        `${sel} .bt-subtask-add-input`,
      ) as HTMLInputElement | null;
      if (!el) return;
      el.value = "Subtask mid-composition";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const evt = new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(evt, "isComposing", { value: true });
      el.dispatchEvent(evt);
    }, parentSel);

    await browser.pause(200);
    const content = await readFile("Tasks/Inbox.md");
    expect(content).not.toContain("Subtask mid-composition");
    expect(content).toContain("- [ ] Parent task");

    // Cleanup: subtask add input has the same blur→finish(true) listener
    // (view.ts:1615); dismiss explicitly so async commit doesn't race
    // into the next test's fixture.
    await browser.execute((sel: string) => {
      const el = document.querySelector(
        `${sel} .bt-subtask-add-input`,
      ) as HTMLInputElement | null;
      if (!el) return;
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    }, parentSel);
    await browser.pause(100);
  });
});
