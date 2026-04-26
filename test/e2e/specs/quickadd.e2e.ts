import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import * as fs from "fs/promises";

const VAULT = "test/e2e/vaults/simple";

/**
 * US-167 — Quick Add v2 Spotlight redesign. Covers chunks 1–4:
 *   1. Layout shell (`.task-center-quick-add-v2`, no h3, hidden X)
 *   2. Single transparent input + inline parse hint (`→ ⏳ MM-DD (Day)`)
 *   3. Quick chips row (Today / Tomorrow / 周六 / Q1~Q4) — click prefills token
 *   4. Footer (`↵ <write target>` / `Esc`) + inline error slot
 *
 * Visual evidence per chunk-by-chunk cadence (Leo / Rally agreed):
 * the last test in this file calls `browser.saveScreenshot()` to
 * `/tmp/m20-chunk-4.png`. This screenshot hook only fires inside the
 * dedicated `US-167 visual evidence` case, never against other specs —
 * keeping CI runs clean.
 */
describe("Task Center — Quick Add v2 (US-167)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    // Close any modal lingering from a prior test (Esc dispatched on
    // body so all open modals receive the cancel signal). Without this
    // chips from two stacked modals collide on click.
    await browser.execute(() => {
      document
        .querySelectorAll(".modal-container")
        .forEach((m) => m.remove());
    });
  });

  // US-167 chunk 1: layout shell. Modal carries the v2 class, no v1 h3,
  // close button hidden via CSS.
  it("US-167 chunk 1 — modal opens with v2 shell (no h3, no visible X)", async function () {
    await browser.executeObsidianCommand("obsidian-task-center:quick-add");
    const modal = $(".modal.task-center-quick-add-v2");
    await modal.waitForExist({ timeout: 3000 });

    // No h3 inside v2 modal.
    const h3Count = await browser.execute(() => {
      return document.querySelectorAll(".task-center-quick-add-v2 h3").length;
    });
    expect(h3Count).toBe(0);

    // X close button is in the DOM (Obsidian renders it) but hidden by CSS.
    const xVisible = await browser.execute(() => {
      const x = document.querySelector(
        ".task-center-quick-add-v2 .modal-close-button",
      ) as HTMLElement | null;
      if (!x) return true; // either fully removed or hidden — both acceptable
      const cs = window.getComputedStyle(x);
      return cs.display !== "none" && cs.visibility !== "hidden";
    });
    expect(xVisible).toBe(false);
  });

  // US-167 chunk 2: inline parse hint updates when input contains a
  // recognized date phrase.
  it("US-167 chunk 2 — typing 'tomorrow' renders inline parse hint", async function () {
    await browser.executeObsidianCommand("obsidian-task-center:quick-add");
    await $(".task-center-quick-add-v2").waitForExist({ timeout: 3000 });

    const input = $(".task-center-quick-add-v2 .task-center-quick-add-input");
    await input.waitForExist({ timeout: 3000 });

    // setValue() in WebDriver doesn't reliably fire the native `input`
    // event under Obsidian's Electron build — assign value + dispatch
    // event manually so refreshHint() runs.
    await browser.execute(() => {
      const el = document.querySelector(
        ".task-center-quick-add-v2 .task-center-quick-add-input",
      ) as HTMLInputElement | null;
      if (!el) return;
      el.value = "buy milk tomorrow";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Wait until the inline hint shows the parsed ⏳ MM-DD (Day) form.
    await browser.waitUntil(
      async () => {
        const text = await browser.execute(() => {
          const el = document.querySelector(
            ".task-center-quick-add-v2 .tc-qa-inline-hint",
          );
          return el ? (el.textContent ?? "") : "";
        });
        return /⏳ \d{2}-\d{2} \([A-Z][a-z]{2}\)/.test(text as string);
      },
      { timeout: 3000, timeoutMsg: "inline parse hint did not render an ⏳ ISO date" },
    );
  });

  // US-167 chunk 3: clicking the Today chip prefills the token at the
  // cursor; subsequent click is idempotent (no duplicate token).
  it("US-167 chunk 3 — clicking Today chip prefills '⏳ today' (idempotent)", async function () {
    await browser.executeObsidianCommand("obsidian-task-center:quick-add");
    await $(".task-center-quick-add-v2").waitForExist({ timeout: 3000 });

    // Seed the input via DOM (avoids the same setValue input-event flake
    // observed in chunk 2) — chip click then operates against this value.
    await browser.execute(() => {
      const el = document.querySelector(
        ".task-center-quick-add-v2 .task-center-quick-add-input",
      ) as HTMLInputElement | null;
      if (!el) return;
      el.value = "buy milk";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Trigger the chip's click handler directly rather than via WebDriver
    // pointer hit-test — Obsidian's modal stack can put a transparent
    // overlay above chips and intercept synthetic clicks.
    const fireChipClick = () => {
      return browser.execute(() => {
        const chip = document.querySelector(
          ".task-center-quick-add-v2 .tc-qa-chip[data-chip='Today']",
        ) as HTMLElement | null;
        if (chip) chip.click();
      });
    };

    await fireChipClick();
    let value = await browser.execute(() => {
      const el = document.querySelector(
        ".task-center-quick-add-v2 .task-center-quick-add-input",
      ) as HTMLInputElement | null;
      return el?.value ?? "";
    });
    expect(value).toContain("⏳ today");

    // Second click: idempotent — token still present exactly once.
    await fireChipClick();
    value = await browser.execute(() => {
      const el = document.querySelector(
        ".task-center-quick-add-v2 .task-center-quick-add-input",
      ) as HTMLInputElement | null;
      return el?.value ?? "";
    });
    const occurrences = (value.match(/⏳ today/g) || []).length;
    expect(occurrences).toBe(1);
  });

  // US-167 chunk 4: footer renders with `↵ <path>` left and `Esc` right.
  // Path comes from settings.dailyFolder + todayISO; default settings
  // give "Daily/<today>.md".
  it("US-167 chunk 4 — footer shows write target path and Esc marker", async function () {
    await browser.executeObsidianCommand("obsidian-task-center:quick-add");
    await $(".task-center-quick-add-v2").waitForExist({ timeout: 3000 });

    const left = await $(".task-center-quick-add-v2 .tc-qa-footer-left").getText();
    const right = await $(".task-center-quick-add-v2 .tc-qa-footer-right").getText();

    // Left: `↵ ` prefix + a path containing today's ISO date.
    expect(left.startsWith("↵ ")).toBe(true);
    const today = (() => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();
    expect(left).toContain(today);

    expect(right).toBe("Esc");
  });

  // US-413 chunk a — IME composition guard on Quick Add input. While the
  // user is composing (e.g. typing Chinese pinyin "周六" before selecting
  // a candidate), the Enter key only commits the IME selection — it must
  // NOT trigger submit. Without the guard the modal would close mid-
  // composition and write a half-formed task.
  it("US-413 chunk a — Quick Add Enter during IME composition must not submit", async function () {
    await browser.executeObsidianCommand("obsidian-task-center:quick-add");
    await $(".task-center-quick-add-v2").waitForExist({ timeout: 3000 });

    // Seed the input with a value so submit() would otherwise proceed.
    await browser.execute(() => {
      const el = document.querySelector(
        ".task-center-quick-add-v2 .task-center-quick-add-input",
      ) as HTMLInputElement | null;
      if (!el) return;
      el.value = "buy milk";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Simulate IME composition: dispatch compositionstart, then Enter
    // with `isComposing: true`. The handler must short-circuit and the
    // modal must remain open.
    await browser.execute(() => {
      const el = document.querySelector(
        ".task-center-quick-add-v2 .task-center-quick-add-input",
      ) as HTMLInputElement | null;
      if (!el) return;
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const evt = new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229, // Legacy IME-active marker
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(evt, "isComposing", { value: true });
      el.dispatchEvent(evt);
    });

    // Modal must still be visible after the IME-Enter — the submit path
    // would have closed it. Brief settle so any stray async submit has
    // a chance to surface.
    await browser.pause(150);
    const modalStillOpen = await $(".task-center-quick-add-v2").isExisting();
    expect(modalStillOpen).toBe(true);
  });

  // US-167 visual evidence — saves a screenshot to /tmp/m20-chunk-4.png
  // for Leo to review. The screenshot hook is intentionally scoped to
  // this single case (per Rally's CI hygiene constraint).
  it("US-167 visual evidence — screenshot to /tmp/m20-chunk-4.png", async function () {
    await browser.executeObsidianCommand("obsidian-task-center:quick-add");
    await $(".task-center-quick-add-v2").waitForExist({ timeout: 3000 });

    // Seed input via DOM (same reason as chunk 2/3 — setValue's input
    // event delivery is flaky in the Electron WebDriver bridge).
    await browser.execute(() => {
      const el = document.querySelector(
        ".task-center-quick-add-v2 .task-center-quick-add-input",
      ) as HTMLInputElement | null;
      if (!el) return;
      el.value = "buy milk tomorrow #3象限 [estimate:: 25m]";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Small settle delay so the hint paints before the screenshot.
    await browser.pause(300);

    const png = await browser.takeScreenshot();
    await fs.writeFile("/tmp/m20-chunk-4.png", Buffer.from(png, "base64"));
  });
});
