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
 * This file covers the remaining inline editors plus the removed card-title
 * inline edit path. The Quick Add modal case (chunk a) lives in quickadd.e2e.ts
 * to keep its fixture setup adjacent to the other Quick Add v2 cases.
 */
describe("Task Center — IME composition guard (US-413)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-413 chunk b used to cover card-title inline rename. US-168 made source
  // edit shell the single card/title edit path, so no `.bt-title-edit` should
  // be reachable from the card title anymore.
  it("US-168/US-413 chunk b — card title click opens source shell, not inline rename", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Original title ⏳ ${today}\n`);

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    const cardSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });

    await browser.execute((sel: string) => {
      const title = document.querySelector(`${sel} .bt-card-title`) as HTMLElement | null;
      title?.click();
    }, cardSel);

    await expect($(`${cardSel} .bt-title-edit`)).not.toExist();
    const shell = $("[data-source-edit-shell]");
    await shell.waitForExist({ timeout: 5000 });
    await expect(shell).toHaveAttribute("data-source-edit-task-id", "Tasks/Inbox.md:L1");

    await browser.keys("Escape");
    await shell.waitForExist({ timeout: 5000, reverse: true });
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

  // US-413 chunk d — DatePromptModal text input. Found during the
  // vault-wide grep audit (src/dateprompt.ts:45). Opening via the 'd'
  // hotkey on a selected card, dispatching IME composition + Enter
  // must keep the modal open and not change the task's ⏳ date.
  it("US-413 chunk d — DatePrompt Enter during IME composition must not commit", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Date prompt task ⏳ ${today}\n`);

    await browser.executeObsidianCommand("obsidian-task-center:open");
    await forFlush();

    const cardSel = `.task-center-view [data-task-id="Tasks/Inbox.md:L1"]`;
    await $(cardSel).waitForExist({ timeout: 5000 });

    // Select the card and press 'd' to open the date prompt — that's
    // the path the view-level handleKey reaches `openDatePrompt`.
    await browser.execute((sel: string) => {
      const card = document.querySelector(sel) as HTMLElement | null;
      card?.click();
      // Synth a 'd' keydown on contentEl to fire the view-level handler.
      const view = document.querySelector(".task-center-view") as HTMLElement | null;
      view?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true }),
      );
    }, cardSel);

    const promptInput = $(".task-center-date-prompt input");
    await promptInput.waitForExist({ timeout: 3000 });

    await browser.execute(() => {
      const el = document.querySelector(
        ".task-center-date-prompt input",
      ) as HTMLInputElement | null;
      if (!el) return;
      el.value = "tomorrow";
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
    });

    // Assert: modal is still visible (Enter was guarded). Read the file
    // too — ⏳ date must be unchanged.
    await browser.pause(200);
    const stillOpen = await $(".task-center-date-prompt").isExisting();
    expect(stillOpen).toBe(true);

    const content = await readFile("Tasks/Inbox.md");
    expect(content).toContain(`⏳ ${today}`);

    // Cleanup: dismiss the modal so the next test isn't blocked by a
    // lingering modal stack.
    await browser.execute(() => {
      const el = document.querySelector(
        ".task-center-date-prompt input",
      ) as HTMLInputElement | null;
      if (!el) return;
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await browser.pause(100);
  });
});
