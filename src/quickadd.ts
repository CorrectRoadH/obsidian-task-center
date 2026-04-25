import { App, Modal, Platform, TextComponent } from "obsidian";
import { TaskCenterApi } from "./cli";
import { t as tr } from "./i18n";
import { parseDurationToMinutes } from "./parser";
import { todayISO, addDays, isValidISO } from "./dates";
import type { TaskCenterSettings } from "./types";

export class QuickAddModal extends Modal {
  private input = "";
  private api: TaskCenterApi;
  private onDone?: () => void;
  private settings?: TaskCenterSettings;
  // visualViewport listeners for soft-keyboard avoidance (US-509). Stored so
  // we can detach in onClose; visualViewport is a singleton so leaks would
  // accumulate across modal reopens.
  private vvOnResize: (() => void) | null = null;

  constructor(app: App, api: TaskCenterApi, onDone?: () => void, settings?: TaskCenterSettings) {
    super(app);
    this.api = api;
    this.onDone = onDone;
    this.settings = settings;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    contentEl.addClass("task-center-quick-add");
    if (Platform.isMobile) {
      // US-509: mobile Quick Add is a bottom sheet, not a centered modal.
      // Reuse the BottomSheet visual class so styling stays in one place
      // (styles.css `.task-center-bottom-sheet`).
      modalEl.addClass("task-center-bottom-sheet");
      modalEl.addClass("task-center-quick-add-sheet");
      // Drag handle for affordance — same as BottomSheet primitive.
      const handle = contentEl.createDiv({ cls: "bt-sheet-handle" });
      handle.setAttr("aria-hidden", "true");
    } else {
      // US-167 v2 (desktop): Spotlight-style compact command palette.
      // Shell only — no h3, no visible X (hidden via CSS), gradient bg,
      // 540×~240, anchored at viewport-top 30%, 14px radius. Input/hint
      // bodies arrive in subsequent chunks (b: inline hint, c: chips,
      // d: footer + e2e). UX.md §6.6.
      modalEl.addClass("task-center-quick-add-v2");
    }
    if (Platform.isMobile) {
      // Title kept on mobile (separate redesign track per task split).
      contentEl.createEl("h3", { text: tr("qa.title") });
    }

    const text = new TextComponent(contentEl);
    text.inputEl.addClass("task-center-quick-add-input");
    text.setPlaceholder(tr("qa.placeholder"));
    text.inputEl.style.width = "100%";
    text.onChange((v) => (this.input = v));

    text.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
      if (e.key === "Escape") this.close();
    });

    contentEl.createEl("p", {
      text: tr("qa.hint"),
      cls: "task-center-quick-add-hint",
    });

    if (Platform.isMobile) this.installKeyboardAvoidance(modalEl);

    window.setTimeout(() => text.inputEl.focus(), 10);
  }

  onClose() {
    // Detach visualViewport listeners — failing to do so leaks one closure
    // per modal reopen since visualViewport is a global singleton.
    if (this.vvOnResize && typeof window.visualViewport !== "undefined" && window.visualViewport) {
      window.visualViewport.removeEventListener("resize", this.vvOnResize);
      window.visualViewport.removeEventListener("scroll", this.vvOnResize);
      this.vvOnResize = null;
    }
    super.onClose();
  }

  /**
   * UX-mobile §13 #5 / US-509: when soft keyboard pops up, the inner
   * viewport shrinks — measure the offset between layout viewport
   * (`window.innerHeight`) and visual viewport (`visualViewport.height`)
   * and shift the bottom-sheet up by that delta. Listen on both
   * `resize` (keyboard show/hide) and `scroll` (visualViewport pan).
   */
  private installKeyboardAvoidance(modalEl: HTMLElement): void {
    if (typeof window.visualViewport === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const apply = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      modalEl.style.setProperty("--tc-vv-offset", `${offset}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    this.vvOnResize = apply;
  }

  async submit() {
    const raw = this.input.trim();
    if (!raw) return;
    try {
      const parsed = parseQuickAdd(raw);
      await this.api.add({
        ...parsed,
        stampCreated: this.settings?.stampCreated ?? true,
        inboxFallback: this.settings?.inboxPath,
      });
      this.close();
      if (this.onDone) this.onDone();
    } catch (e) {
      const note = contentErr(e);
      const err = this.contentEl.createDiv({ cls: "task-center-err" });
      err.setText("error: " + note);
    }
  }
}

function contentErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const ZH_DAYS: Record<string, number> = {
  周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 0, 周天: 0,
  星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6, 星期日: 0, 星期天: 0,
};

function resolveRelativeDate(word: string, today: string): string | null {
  const w = word.toLowerCase();
  if (w === "today" || w === "今天" || w === "今日") return today;
  if (w === "tomorrow" || w === "明天" || w === "明日") return addDays(today, 1);
  if (w === "yesterday" || w === "昨天" || w === "昨日") return addDays(today, -1);
  if (w === "next-week" || w === "下周") return addDays(today, 7);
  if (w === "后天") return addDays(today, 2);
  if (word in ZH_DAYS) {
    const target = ZH_DAYS[word];
    const d = new Date(today);
    const cur = d.getDay();
    const diff = (target - cur + 7) % 7 || 7;
    return addDays(today, diff);
  }
  if (isValidISO(word)) return word;
  return null;
}

export interface QuickAddParsed {
  text: string;
  tag?: string[];
  scheduled?: string;
  deadline?: string;
  estimate?: number;
}

export function parseQuickAdd(input: string, today: string = todayISO()): QuickAddParsed {
  let remaining = input;
  const tags: string[] = [];
  let scheduled: string | undefined;
  let deadline: string | undefined;
  let estimate: number | undefined;

  // Extract inline fields [estimate:: Nm]
  remaining = remaining.replace(/\[estimate::\s*([^\]]+)\]/gi, (_, v) => {
    const m = parseDurationToMinutes(v);
    if (m) estimate = m;
    return "";
  });

  // Extract ⏳ word
  remaining = remaining.replace(/⏳\s*(\S+)/g, (_, v) => {
    const r = resolveRelativeDate(v, today);
    if (r) scheduled = r;
    return "";
  });

  // Extract 📅 word
  remaining = remaining.replace(/📅\s*(\S+)/g, (_, v) => {
    const r = resolveRelativeDate(v, today);
    if (r) deadline = r;
    return "";
  });

  // Extract tags
  const tagRe = /#([^\s#\[\]()]+)/g;
  let m;
  while ((m = tagRe.exec(remaining)) !== null) {
    tags.push("#" + m[1]);
  }
  remaining = remaining.replace(tagRe, "");

  // Trailing bare relative-date: "... 周六" "tomorrow"
  const words = remaining.trim().split(/\s+/);
  if (words.length > 1) {
    const last = words[words.length - 1];
    if (!scheduled) {
      const r = resolveRelativeDate(last, today);
      if (r) {
        scheduled = r;
        words.pop();
      }
    }
  }
  const text = words.join(" ").trim();
  return { text, tag: tags, scheduled, deadline, estimate };
}
