import { App, MarkdownView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type { ParsedTask } from "../types";
import { t as tr } from "../i18n";

function clearPreviousSourceShells(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-source-edit-shell]"))) {
    delete el.dataset.sourceEditShell;
    delete el.dataset.sourceEditTaskId;
    delete el.dataset.sourceEditEditor;
    el.removeClass("task-center-source-edit-shell");
  }
}

function createSourceLeaf(app: App, hostLeaf: WorkspaceLeaf): WorkspaceLeaf {
  try {
    return app.workspace.createLeafBySplit(hostLeaf, "vertical");
  } catch {
    return app.workspace.getLeaf("tab");
  }
}

/**
 * US-168 source edit shell.
 *
 * Obsidian does not expose a public API for mounting MarkdownView directly
 * into Modal.contentEl (see docs/source-edit-dialog-spike.md). The supported
 * native editor path is a real WorkspaceLeaf running MarkdownView, so this
 * helper creates/reveals that editor leaf and marks its real container as the
 * dialog-like source edit shell for tests and styling.
 */
export async function openTaskSourceEditShell(
  app: App,
  hostLeaf: WorkspaceLeaf,
  task: ParsedTask,
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(task.path);
  if (!(file instanceof TFile)) {
    new Notice(tr("notice.fileNotFound", { path: task.path }));
    return;
  }

  clearPreviousSourceShells();

  const leaf = createSourceLeaf(app, hostLeaf);
  await leaf.openFile(file, { eState: { line: task.line } });
  if (typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
  app.workspace.revealLeaf(leaf);

  const view = leaf.view;
  if (!(view instanceof MarkdownView)) {
    throw new Error("US-168 source edit shell expected a MarkdownView");
  }

  view.containerEl.addClass("task-center-source-edit-shell");
  view.containerEl.dataset.sourceEditShell = "true";
  view.containerEl.dataset.sourceEditTaskId = task.id;
  view.containerEl.dataset.sourceEditEditor = "markdown";

  const pos = { line: task.line, ch: 0 };
  view.editor.setCursor(pos);
  view.editor.scrollIntoView({ from: pos, to: pos }, true);
}
