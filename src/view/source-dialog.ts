import { App, MarkdownView, Notice, TFile, WorkspaceLeaf, WorkspaceSplit } from "obsidian";
import type { ParsedTask } from "../types";
import { t as tr } from "../i18n";

type SourceEditOptions = {
  onSave?: () => void | Promise<void>;
};

type SourceEditorLeaf = WorkspaceLeaf & {
  containerEl?: HTMLElement;
  parentSplit?: {
    removeChild?: (leaf: WorkspaceLeaf, resize?: boolean) => void;
  };
};

type SourceEditorSplit = WorkspaceSplit & {
  containerEl: HTMLElement;
  children?: unknown[];
};

type ConstructableWorkspaceSplit = new (workspace: unknown, direction: string) => SourceEditorSplit;

type SourceEditShellElement = HTMLElement & {
  __sourceEditLeaf?: WorkspaceLeaf;
  __sourceEditView?: MarkdownView;
  __sourceEditClose?: () => Promise<void>;
};

function clearPreviousSourceShells(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-source-edit-shell]"))) {
    const close = (el as SourceEditShellElement).__sourceEditClose;
    if (close) void close();
    else el.remove();
  }
}

function createSourceEditorSplit(app: App): SourceEditorSplit {
  const Split = WorkspaceSplit as unknown as ConstructableWorkspaceSplit;
  const split = new Split(app.workspace, "vertical");
  const workspace = app.workspace as unknown as { rootSplit?: unknown };
  const internalSplit = split as unknown as {
    getRoot: () => unknown;
    getContainer: () => unknown;
  };
  internalSplit.getRoot = () => workspace.rootSplit ?? split;
  internalSplit.getContainer = () => workspace.rootSplit ?? split;
  return split as SourceEditorSplit;
}

async function focusTaskLineInMarkdownView(leaf: WorkspaceLeaf, line: number): Promise<MarkdownView> {
  if (typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
  const view = leaf.view;
  if (!(view instanceof MarkdownView) || !view.editor) {
    throw new Error("Source editor did not create a MarkdownView");
  }
  const pos = { line, ch: 0 };
  view.editor.setCursor(pos);
  view.editor.scrollIntoView({ from: pos, to: pos }, true);
  view.editor.focus();
  return view;
}

/**
 * US-168 source edit shell.
 *
 * The user journey is an in-place editor dialog over Task Center: clicking a
 * card must not navigate away to another workspace pane. A live Obsidian
 * MarkdownView requires a WorkspaceLeaf, so this shell creates a temporary
 * WorkspaceSplit inside the overlay and opens the file in a real MarkdownView
 * there. That keeps the Task Center visible underneath while preserving
 * Obsidian's own Live Preview/source editor behavior.
 */
export async function openTaskSourceEditShell(
  app: App,
  hostLeaf: WorkspaceLeaf,
  task: ParsedTask,
  opts: SourceEditOptions = {},
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(task.path);
  if (!(file instanceof TFile)) {
    new Notice(tr("notice.fileNotFound", { path: task.path }));
    return;
  }

  clearPreviousSourceShells();

  const overlay = document.body.createDiv({ cls: "task-center-source-edit-overlay" }) as SourceEditShellElement;
  overlay.dataset.sourceEditShell = "true";
  overlay.dataset.sourceEditTaskId = task.id;
  overlay.dataset.sourceEditEditor = "obsidian-markdown-view";

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
  const close = actions.createEl("button", { text: tr("sourceEdit.close") });
  close.dataset.sourceEditAction = "close";

  const editorHost = dialog.createDiv({ cls: "task-center-source-edit-editor-host" });
  editorHost.dataset.sourceEditMarkdownView = "true";

  let leaf: SourceEditorLeaf | null = null;
  let view: MarkdownView | null = null;
  let closing = false;
  const split = createSourceEditorSplit(app);
  editorHost.appendChild(split.containerEl);

  const restoreHostLeaf = (focus = true) => {
    try {
      if (hostLeaf) app.workspace.setActiveLeaf(hostLeaf, { focus });
    } catch {
      // The source shell is already closing; losing focus restoration should not
      // keep the editor shell open or prevent saving.
    }
  };

  const consumeEscape = (e: KeyboardEvent): boolean => {
    if (e.key !== "Escape") return false;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return true;
  };

  const suppressNextEscapeKeyup = () => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      document.removeEventListener("keyup", suppress, true);
      window.removeEventListener("keyup", suppress, true);
    };
    const suppress = (e: KeyboardEvent) => {
      if (!consumeEscape(e)) return;
      cleanup();
    };
    document.addEventListener("keyup", suppress, true);
    window.addEventListener("keyup", suppress, true);
    window.setTimeout(cleanup, 1000);
  };

  const destroy = async () => {
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("keyup", onKeyup, true);
    window.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("keyup", onKeyup, true);
    restoreHostLeaf(false);
    try {
      await (view as unknown as { save?: () => Promise<void> })?.save?.();
    } catch {
      // Obsidian's editor save is best-effort here; the editor also has its own
      // requestSave pipeline. Closing the shell must not strand the user.
    }
    try {
      leaf?.detach();
    } catch {
      leaf?.parentSplit?.removeChild?.(leaf);
    }
    overlay.remove();
    await opts.onSave?.();
    restoreHostLeaf();
    requestAnimationFrame(() => restoreHostLeaf());
    window.setTimeout(restoreHostLeaf, 0);
  };
  overlay.__sourceEditClose = destroy;

  const onKeydown = (e: KeyboardEvent) => {
    if (!consumeEscape(e)) return;
    if (closing) return;
    closing = true;
    suppressNextEscapeKeyup();
    restoreHostLeaf(false);
    void destroy();
  };

  const onKeyup = (e: KeyboardEvent) => {
    consumeEscape(e);
  };

  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("keyup", onKeyup, true);
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("keyup", onKeyup, true);
  close.addEventListener("click", () => void destroy());
  overlay.addEventListener("click", () => void destroy());

  try {
    restoreHostLeaf(false);
    leaf = app.workspace.createLeafInParent(split, 0) as SourceEditorLeaf;
    await leaf.openFile(file, {
      active: false,
      eState: { line: task.line },
    });
    view = await focusTaskLineInMarkdownView(leaf, task.line);
    restoreHostLeaf(false);
    overlay.__sourceEditLeaf = leaf;
    overlay.__sourceEditView = view;
  } catch (err) {
    await destroy();
    new Notice(tr("sourceEdit.nativeFailed"));
    console.error(err);
  }
}
