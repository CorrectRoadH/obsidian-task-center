import { App, Modal, Platform, TextComponent } from "obsidian";
import { TaskCenterApi } from "./cli";
import { t as tr } from "./i18n";
import { parseDurationToMinutes } from "./parser";
import { todayISO, addDays, isValidISO, fromISO } from "./dates";
import type { TaskCenterSettings } from "./types";

// US-167-3: prefill chips. Token strings must match parseQuickAdd's
// existing recognizers (resolveRelativeDate / tagRe). Quadrant tokens
// follow the established `#N象限` form used in the v1 placeholder.
const QUICK_CHIPS: ReadonlyArray<{ label: string; token: string }> = [
  { label: "Today", token: "⏳ today" },
  { label: "Tomorrow", token: "⏳ tomorrow" },
  { label: "周六", token: "⏳ 周六" },
  { label: "Q1", token: "#1象限" },
  { label: "Q2", token: "#2象限" },
  { label: "Q3", token: "#3象限" },
  { label: "Q4", token: "#4象限" },
];

export class QuickAddModal extends Modal {
  private input = "";
  private api: TaskCenterApi;
  private onDone?: () => void;
  private settings?: TaskCenterSettings;
  // visualViewport listeners for soft-keyboard avoidance (US-509). Stored so
  // we can detach in onClose; visualViewport is a singleton so leaks would
  // accumulate across modal reopens.
  private vvOnResize: (() => void) | null = null;
  // US-167-4 inline error slot. Reused across retries so we don't stack
  // ⚠ lines on repeated failures. Only created on desktop v2.
  private errorEl: HTMLElement | null = null;

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

    // Desktop v2 wraps input + inline parse hint in a single flex row so
    // the hint sits to the right of the input on the same baseline.
    // Mobile keeps the simple inline TextComponent placement (US-509
    // bottom-sheet styling does the layout there).
    const inputHost = !Platform.isMobile
      ? contentEl.createDiv({ cls: "tc-qa-input-row" })
      : contentEl;

    const text = new TextComponent(inputHost);
    text.inputEl.addClass("task-center-quick-add-input");
    text.setPlaceholder(tr("qa.placeholder"));
    text.inputEl.style.width = "100%";
    text.onChange((v) => (this.input = v));

    // Inline parse hint (US-167-2, desktop only). Updates each keystroke;
    // shows the resolved ⏳ / 📅 ISO date in `→ ⏳ MM-DD (Day)` form.
    // Tags and [estimate::] tokens are intentionally NOT echoed — they
    // already appear verbatim in the input, repeating them is noise.
    let inlineHint: HTMLElement | null = null;
    if (!Platform.isMobile) {
      inlineHint = inputHost.createSpan({ cls: "tc-qa-inline-hint" });
    }

    const refreshHint = () => {
      if (!inlineHint) return;
      const raw = text.inputEl.value;
      if (!raw.trim()) {
        inlineHint.setText("");
        return;
      }
      try {
        const parsed = parseQuickAdd(raw);
        const parts: string[] = [];
        if (parsed.scheduled) parts.push(`⏳ ${formatHintDate(parsed.scheduled)}`);
        if (parsed.deadline) parts.push(`📅 ${formatHintDate(parsed.deadline)}`);
        inlineHint.setText(parts.length ? `→ ${parts.join("  ")}` : "");
      } catch {
        inlineHint.setText("");
      }
    };

    text.inputEl.addEventListener("input", refreshHint);
    text.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
      if (e.key === "Escape") this.close();
    });

    if (!Platform.isMobile) {
      // US-167-3: quick chips row replaces the v1 prose hint. Click =
      // append token at cursor (idempotent — already-present tokens are
      // not duplicated). 7 chips chosen from spec list (Today/Tomorrow/
      // 周六/Q1~Q4); Inbox + 下周 omitted: Inbox token semantics are not
      // defined in parser.ts, 下周 is rarer than 周六.
      const chipsRow = contentEl.createDiv({ cls: "tc-qa-chips" });
      for (const c of QUICK_CHIPS) {
        const chip = chipsRow.createSpan({ cls: "tc-qa-chip", text: c.label });
        chip.setAttr("role", "button");
        chip.setAttr("tabindex", "0");
        chip.setAttr("data-chip", c.label);
        const fire = () => {
          this.insertChipToken(text.inputEl, c.token);
          refreshHint();
        };
        chip.addEventListener("click", fire);
        chip.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fire();
          }
        });
      }

      // US-167-4 error slot — pre-rendered empty so submit() can fill in
      // place rather than appending fresh nodes on each failure (which
      // would stack ⚠ lines if the user retried).
      this.errorEl = contentEl.createDiv({ cls: "tc-qa-error" });
      this.errorEl.setAttr("role", "alert");
      this.errorEl.hide();

      // US-167-4 footer: `↵ <write target path>` left, `Esc` right.
      // Static — write target is determined by settings.dailyFolder +
      // todayISO at modal open and doesn't change with input. Spec
      // UX.md §6.6 explicitly: "按 settings.dailyFolder + todayISO 计算；
      // 无 daily 走 inbox 路径".
      const footer = contentEl.createDiv({ cls: "tc-qa-footer" });
      footer.createSpan({
        cls: "tc-qa-footer-left",
        text: `↵ ${computeWriteTarget(this.settings)}`,
      });
      footer.createSpan({ cls: "tc-qa-footer-right", text: "Esc" });
    } else {
      // Mobile keeps the v1 prose hint (separate redesign track).
      contentEl.createEl("p", {
        text: tr("qa.hint"),
        cls: "task-center-quick-add-hint",
      });
    }

    if (Platform.isMobile) this.installKeyboardAvoidance(modalEl);

    window.setTimeout(() => text.inputEl.focus(), 10);
  }

  /**
   * US-167-3 chip click: append `token` at cursor (or end). Idempotent —
   * if `token` already appears in the input, do nothing. Adds a leading
   * space when the prior char isn't whitespace so the parser can split
   * tokens cleanly.
   */
  private insertChipToken(inputEl: HTMLInputElement, token: string): void {
    const current = inputEl.value;
    if (current.includes(token)) {
      inputEl.focus();
      return;
    }
    const pos = inputEl.selectionStart ?? current.length;
    const before = current.slice(0, pos);
    const after = current.slice(pos);
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needsLeadingSpace ? " " : "") + token;
    const next = before + insert + after;
    inputEl.value = next;
    this.input = next;
    const newPos = (before + insert).length;
    inputEl.setSelectionRange(newPos, newPos);
    inputEl.focus();
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
      // Prefer the v2 inline error slot (rendered above the footer) so
      // failed submits don't stack ⚠ lines. Fall back to the legacy
      // append-on-failure path on mobile (which still renders v1).
      if (this.errorEl) {
        this.errorEl.setText(`⚠ ${note}`);
        this.errorEl.show();
      } else {
        const err = this.contentEl.createDiv({ cls: "task-center-err" });
        err.setText("error: " + note);
      }
    }
  }
}

function contentErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// US-167-2: format an ISO date as `MM-DD (Day)` for the inline parse hint.
// Year is omitted because the user typed a relative-near phrase
// (today/tomorrow/周六) — month-day is enough disambiguation, year would
// be visual noise.
function formatHintDate(iso: string): string {
  const d = fromISO(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd} (${WEEKDAY_SHORT[d.getDay()]})`;
}

// US-167-4: compute the file path the new task will be appended to, for
// the footer's `↵ <path>` preview. Spec UX.md §6.6: dailyFolder +
// todayISO when set, inbox fallback otherwise. Note this preview is a
// best-effort approximation of writer.ts's actual target resolution
// (which also consults Obsidian's daily-notes internal plugin); the
// preview matches the spec wording exactly while the writer remains the
// authority on actual write location.
function computeWriteTarget(settings?: TaskCenterSettings): string {
  const dailyFolder = settings?.dailyFolder?.trim();
  if (dailyFolder) return `${dailyFolder}/${todayISO()}.md`;
  return settings?.inboxPath ?? "Tasks/Inbox.md";
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
