import { App, TextComponent } from "obsidian";
import { resolveDateInput } from "./dates";
export { resolveDateInput } from "./dates";
import { t as tr } from "./i18n";
import { TcBaseModal } from "./view/tc-modal";

/**
 * Small modal that accepts a date as YYYY-MM-DD or a natural-language hint
 * (today / tomorrow / 明天 / 周六 / etc.) and resolves it to an ISO date.
 * Enter commits, Escape closes without saving, blank string signals "clear".
 */
export class DatePromptModal extends TcBaseModal {
  protected readonly modalContentClass = "task-center-date-prompt";
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

  protected populate(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.title);

    const input = new TextComponent(contentEl);
    input.inputEl.addClass("tc-full-width-input");
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
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        const resolved = resolveDateInput(this.value);
        // resolved: string (ISO) | null (blank → clear) | undefined (invalid → reject)
        if (resolved !== undefined) {
          this.onResolve(resolved);
          this.close();
        } else {
          input.inputEl.addClass("tc-input-invalid");
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
