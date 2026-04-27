import { App, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type { ParsedTask } from "../types";
import { t as tr } from "../i18n";

type SourceEditOptions = {
  onSave?: () => void | Promise<void>;
};

function clearPreviousSourceShells(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-source-edit-shell]"))) {
    el.remove();
  }
}

function lineStartOffset(text: string, line: number): number {
  if (line <= 0) return 0;
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return offset;
}

function focusTaskLine(textarea: HTMLTextAreaElement, line: number): void {
  const start = lineStartOffset(textarea.value, line);
  const end = textarea.value.indexOf("\n", start);
  textarea.focus();
  textarea.setSelectionRange(start, end === -1 ? textarea.value.length : end);
  requestAnimationFrame(() => {
    const style = window.getComputedStyle(textarea);
    const parsed = Number.parseFloat(style.lineHeight);
    const lineHeight = Number.isFinite(parsed) ? parsed : 20;
    textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight / 2 + lineHeight);
  });
}

/**
 * US-168 source edit shell.
 *
 * The user journey is an in-place editor dialog over Task Center: clicking a
 * card must not navigate away to another workspace leaf. Obsidian's public API
 * does not let plugins mount a live MarkdownView inside a Modal, so this shell
 * uses a source textarea fallback that edits the file's original Markdown and
 * keeps Task Center visible underneath.
 */
export async function openTaskSourceEditShell(
  app: App,
  _hostLeaf: WorkspaceLeaf,
  task: ParsedTask,
  opts: SourceEditOptions = {},
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(task.path);
  if (!(file instanceof TFile)) {
    new Notice(tr("notice.fileNotFound", { path: task.path }));
    return;
  }

  clearPreviousSourceShells();

  let dirty = false;
  const original = await app.vault.read(file);
  const overlay = document.body.createDiv({ cls: "task-center-source-edit-overlay" });
  overlay.dataset.sourceEditShell = "true";
  overlay.dataset.sourceEditTaskId = task.id;
  overlay.dataset.sourceEditEditor = "markdown-source";

  const dialog = overlay.createDiv({ cls: "task-center-source-edit-dialog" });
  dialog.addEventListener("click", (e) => e.stopPropagation());

  const header = dialog.createDiv({ cls: "task-center-source-edit-header" });
  header.createDiv({
    cls: "task-center-source-edit-title",
    text: tr("sourceEdit.title"),
  });
  header.createDiv({
    cls: "task-center-source-edit-path",
    text: `${task.path}:L${task.line + 1}`,
  });
  const actions = header.createDiv({ cls: "task-center-source-edit-actions" });
  const status = actions.createSpan({ cls: "task-center-source-edit-status", text: "" });
  const save = actions.createEl("button", { text: tr("sourceEdit.save") });
  save.dataset.sourceEditAction = "save";
  const close = actions.createEl("button", { text: tr("sourceEdit.close") });
  close.dataset.sourceEditAction = "close";

  const textarea = dialog.createEl("textarea", {
    cls: "task-center-source-edit-textarea",
  });
  textarea.dataset.sourceEditTextarea = "true";
  textarea.spellcheck = false;
  textarea.value = original;

  const destroy = () => overlay.remove();
  const doSave = async () => {
    await app.vault.modify(file, textarea.value);
    dirty = false;
    status.setText(tr("sourceEdit.saved"));
    await opts.onSave?.();
  };

  textarea.addEventListener("input", () => {
    dirty = true;
    status.setText(tr("sourceEdit.unsaved"));
  });
  textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void doSave();
    } else if (e.key === "Escape" && !dirty) {
      e.preventDefault();
      destroy();
    }
  });
  save.addEventListener("click", () => void doSave());
  close.addEventListener("click", destroy);
  overlay.addEventListener("click", destroy);

  focusTaskLine(textarea, task.line);
}
