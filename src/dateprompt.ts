import { App, Modal, TextComponent } from "obsidian";
import { todayISO, addDays, isValidISO } from "./dates";
import { t as tr } from "./i18n";

/**
 * Small modal that accepts a date as YYYY-MM-DD or a natural-language hint
 * (today / tomorrow / 明天 / 周六 / etc.) and resolves it to an ISO date.
 * Enter commits, Escape closes without saving, blank string signals "clear".
 */
export class DatePromptModal extends Modal {
  private value: string;
  private onResolve: (iso: string | null | undefined) => void;
  private title: string;
  private initialValue: string;

  constructor(
    app: App,
    title: string,
    initialValue: string,
    onResolve: (iso: string | null | undefined) => void,
  ) {
    super(app);
    this.title = title;
    this.initialValue = initialValue;
    this.value = initialValue;
    this.onResolve = onResolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("task-center-date-prompt");
    contentEl.createEl("h3", { text: this.title });

    const input = new TextComponent(contentEl);
    input.inputEl.style.width = "100%";
    input.setValue(this.initialValue);
    input.onChange((v) => (this.value = v));

    // task #43: route the hint text through tr() so a Chinese session
    // shows the CN form ("YYYY-MM-DD · 今天 · 明天 · ...") instead of
    // the bilingual EN baseline. Input parsing in `resolveDateInput`
    // still accepts both languages either way.
    contentEl.createEl("p", {
      text: tr("prompt.dateHint"),
      cls: "task-center-date-hint",
    });

    input.inputEl.addEventListener("keydown", (e) => {
      // US-413: skip the Enter commit while IME composition is active —
      // see src/quickadd.ts for the same pattern.
      if (e.key === "Enter" && !(e.isComposing || e.keyCode === 229)) {
        e.preventDefault();
        const resolved = resolveDateInput(this.value);
        // resolved: string (ISO) | null (blank → clear) | undefined (invalid → reject)
        if (resolved !== undefined) {
          this.onResolve(resolved);
          this.close();
        } else {
          input.inputEl.style.borderColor = "var(--color-red)";
        }
      } else if (e.key === "Escape") {
        this.close();
      }
    });

    window.setTimeout(() => {
      input.inputEl.focus();
      input.inputEl.select();
    }, 10);
  }
}

const ZH_DAYS: Record<string, number> = {
  周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 0, 周天: 0,
  星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6, 星期日: 0, 星期天: 0,
};

/** Returns an ISO string, or null for blank, or undefined for invalid input. */
export function resolveDateInput(raw: string): string | null | undefined {
  const s = raw.trim();
  if (s === "") return null;
  const lc = s.toLowerCase();
  const today = todayISO();
  if (lc === "today" || s === "今天" || s === "今日") return today;
  if (lc === "tomorrow" || s === "明天" || s === "明日") return addDays(today, 1);
  if (lc === "yesterday" || s === "昨天" || s === "昨日") return addDays(today, -1);
  if (s === "后天") return addDays(today, 2);
  if (lc === "next-week" || s === "下周") return addDays(today, 7);
  if (s in ZH_DAYS) {
    const target = ZH_DAYS[s];
    const d = new Date(today);
    const cur = d.getDay();
    const diff = (target - cur + 7) % 7 || 7;
    return addDays(today, diff);
  }
  if (isValidISO(s)) return s;
  return undefined;
}
