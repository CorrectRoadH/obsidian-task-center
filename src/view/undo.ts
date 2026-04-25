// Board-view undo stack.
//
// Records byte-level write operations issued from the view (drag, complete,
// drop, nest, quick-add, rename) so the user can roll one back with Ctrl+Z.
// CLI-issued writes are intentionally NOT captured (UX.md §6.7) — the CLI is
// scriptable and idempotent enough that auto-undo would be more confusing
// than helpful.
//
// Each entry's `ops` are in forward order; we apply them in reverse on undo.
// For cross-file moves (nested across files), the entry holds one op per
// touched file. Reversing the array thus restores both sides cleanly.
//
// We also do a content-divergence check before each undo: if the file's
// `after` lines no longer match what we wrote, the user edited over us and
// we abort rather than overwrite (UX.md §6.7 / ARCHITECTURE.md §6.2).

import { App, TFile } from "obsidian";

export interface UndoOp {
  path: string;
  line: number;
  before: string[];
  after: string[];
}

export interface UndoEntry {
  /** Short human description shown in the toast on undo. */
  label: string;
  /** Forward ops; the stack applies them in reverse during `pop()`. */
  ops: UndoOp[];
}

export interface UndoStackOptions {
  /**
   * Called after a successful undo so the view can refresh. Failures notify
   * via the `notify` callback only — no refresh fires, the stack just leaves
   * the entry consumed.
   */
  onApplied: () => void;
  /** Toast / notice channel — kept abstract so the class is DOM-free. */
  notify: (message: string, durationMs?: number) => void;
}

export class UndoStack {
  static readonly MAX = 20;
  private readonly stack: UndoEntry[] = [];

  constructor(
    private readonly app: App,
    private readonly opts: UndoStackOptions,
  ) {}

  size(): number {
    return this.stack.length;
  }

  push(entry: UndoEntry): void {
    this.stack.push(entry);
    if (this.stack.length > UndoStack.MAX) this.stack.shift();
  }

  /** Pop the top entry and reverse it. No-op + toast if empty. */
  async pop(): Promise<void> {
    const entry = this.stack.pop();
    if (!entry) {
      this.opts.notify("nothing to undo");
      return;
    }
    try {
      // Reverse order: each op is "at path:line, `after` is present; replace
      // with `before`". Cross-file entries store one op per touched file, so
      // reversing restores both sides of a cross-file nest.
      for (let i = entry.ops.length - 1; i >= 0; i--) {
        const op = entry.ops[i];
        const file = this.app.vault.getAbstractFileByPath(op.path);
        if (!(file instanceof TFile)) {
          throw new Error(`file not found: ${op.path}`);
        }
        await this.app.vault.process(file, (data) => {
          const lines = data.split("\n");
          for (let j = 0; j < op.after.length; j++) {
            if (lines[op.line + j] !== op.after[j]) {
              throw new Error(
                `content diverged at ${op.path}:L${op.line + j + 1} — skipping undo`,
              );
            }
          }
          const out = [
            ...lines.slice(0, op.line),
            ...op.before,
            ...lines.slice(op.line + op.after.length),
          ];
          return out.join("\n");
        });
      }
      this.opts.notify(`undo: ${entry.label}`);
      this.opts.onApplied();
    } catch (e) {
      this.opts.notify(`cannot undo: ${(e as Error).message}`, 4000);
      // Don't re-push the entry: the divergence means the user edited over
      // our change on purpose; restoring would clobber that intent.
    }
  }
}
