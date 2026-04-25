// Mobile bottom-sheet primitive.
//
// UX-mobile.md §3.2 needs a "tap a month cell → list of tasks for that day"
// surface, and §5.1 needs a "long-press → context menu + source info" sheet.
// Both are visually the same primitive: a full-width panel anchored to the
// bottom of the viewport with a close gesture. This module provides the
// shell; consumers fill the body via the `populate()` callback.
//
// Implementation notes:
//   - Uses Obsidian's `Modal` for backdrop / open / close lifecycle, then
//     restyles the modal element to anchor at the bottom (CSS in
//     `task-center-bottom-sheet` block in styles.css).
//   - `Modal.contentEl` is where consumers should append rows. The shell
//     adds the title and (optional) handle bar; otherwise leaves layout
//     to the consumer.
//   - Backdrop tap and Escape close the sheet via the inherited Modal
//     behavior.

import { App, Modal } from "obsidian";

export interface BottomSheetOptions {
  /** Heading rendered at the top of the sheet. */
  title: string;
  /**
   * Called once on open, after the title is in the DOM. Append your rows
   * to `contentEl`. Anything you wire here is torn down when the user
   * dismisses the sheet.
   */
  populate: (contentEl: HTMLElement) => void;
}

export class BottomSheet extends Modal {
  constructor(app: App, private readonly opts: BottomSheetOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("task-center-bottom-sheet");
    contentEl.empty();
    contentEl.addClass("bt-sheet-content");

    // Drag handle at the top so users see the sheet is dismissible.
    const handle = contentEl.createDiv({ cls: "bt-sheet-handle" });
    handle.setAttr("aria-hidden", "true");

    contentEl.createEl("h3", { cls: "bt-sheet-title", text: this.opts.title });

    this.opts.populate(contentEl);
  }
}
