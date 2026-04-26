// Card hover-popover: shows the source markdown around the task line.
//
// Defers work behind a 350ms hover timer so casually skimming the board
// doesn't thrash the vault read + markdown render pipeline. Only one
// popover lives at a time. Suppressed entirely while a drag is in progress
// so it doesn't fight the drop-target highlight.
//
// US-165: hover a card to see its parent chain + a few lines of the source
// file's surrounding markdown — gives the "which project does this task
// live under" context without leaving the board. Mobile substitutes a
// long-press action sheet (US-506); the popover never opens on touch.
// see USER_STORIES.md

import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import { ParsedTask } from "../types";

export interface ContextPopoverDeps {
  app: App;
  /**
   * Lifecycle hooks for the parent ItemView so MarkdownRenderer's
   * Component child is owned correctly.
   */
  addChild: (c: Component) => void;
  removeChild: (c: Component) => void;
  /**
   * Returns true if the user is currently dragging a card. The popover
   * is suppressed in that state to avoid colliding with drop targets.
   */
  isDragging: () => boolean;
}

const HOVER_DELAY_MS = 350;
const ANCHOR_MARGIN_PX = 8;
const LEAD_LINES = 2;

interface OpenPopover {
  el: HTMLElement;
  component: Component;
  anchor: HTMLElement;
}

export class ContextPopoverController {
  private hoverTimer: number | null = null;
  private popover: OpenPopover | null = null;

  constructor(private readonly deps: ContextPopoverDeps) {}

  /**
   * Wire `mouseenter` / `mouseleave` / `dragstart` for one card. The card
   * may be re-rendered any number of times — call `attach` again on the
   * new element, the controller is stateless w.r.t. previously-detached
   * cards (their listeners go away with the DOM nodes).
   */
  attach(card: HTMLElement, t: ParsedTask): void {
    card.addEventListener("mouseenter", () => {
      if (this.deps.isDragging()) return;
      this.cancelHoverTimer();
      this.hoverTimer = window.setTimeout(() => {
        this.hoverTimer = null;
        if (this.deps.isDragging()) return;
        if (!document.body.contains(card)) return;
        void this.open(card, t);
      }, HOVER_DELAY_MS);
    });
    card.addEventListener("mouseleave", () => {
      this.cancelHoverTimer();
      if (this.popover && this.popover.anchor === card) this.close();
    });
    card.addEventListener("dragstart", () => {
      this.cancelHoverTimer();
      this.close();
    });
  }

  /** Tear down popover + pending timer. Safe to call repeatedly. */
  close(): void {
    this.cancelHoverTimer();
    const p = this.popover;
    if (!p) return;
    this.popover = null;
    p.el.remove();
    this.deps.removeChild(p.component);
  }

  /**
   * Force open at the given anchor. Public for tests and explicit reveal
   * paths; the normal entry point is `attach()` + hover.
   */
  async open(card: HTMLElement, t: ParsedTask): Promise<void> {
    const file = this.deps.app.vault.getAbstractFileByPath(t.path);
    if (!(file instanceof TFile)) return;
    const data = await this.deps.app.vault.cachedRead(file);
    const lines = data.split("\n");
    if (t.line < 0 || t.line >= lines.length) return;

    // Walk by indent to capture the entire subtree (multi-level nesting).
    // A naive ±N window cut subtrees in half whenever depth > 1.
    const taskIndent = t.indent.length;
    let subtreeEnd = t.line;
    for (let i = t.line + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") break;
      const indent = (line.match(/^\s*/)?.[0].length) ?? 0;
      if (indent <= taskIndent) break;
      subtreeEnd = i;
    }
    const start = Math.max(0, t.line - LEAD_LINES);
    const end = subtreeEnd;
    const snippet = lines.slice(start, end + 1).join("\n");

    // If parent task lives outside the snippet window, surface it as a chip.
    const parentLine =
      t.parentLine !== null && (t.parentLine < start || t.parentLine > end)
        ? lines[t.parentLine] ?? null
        : null;

    this.close();

    const pop = document.body.createDiv({ cls: "bt-ctx-popover" });
    const component = new Component();
    this.deps.addChild(component);

    const renders: Promise<void>[] = [];
    if (parentLine !== null) {
      const chip = pop.createDiv({ cls: "bt-ctx-parent" });
      chip.createSpan({ cls: "bt-ctx-parent-arrow", text: "↑" });
      const chipBody = chip.createDiv({ cls: "bt-ctx-parent-body" });
      renders.push(
        MarkdownRenderer.render(
          this.deps.app,
          parentLine.trim(),
          chipBody,
          t.path,
          component,
        ),
      );
    }

    const body = pop.createDiv({ cls: "bt-ctx-body" });
    renders.push(
      MarkdownRenderer.render(this.deps.app, snippet, body, t.path, component),
    );

    // Wait for content to actually render before measuring — otherwise
    // popRect.height is 0 and the "flip above viewport edge" logic never
    // fires (Rally caught this in the popover review).
    await Promise.all(renders);

    this.popover = { el: pop, component, anchor: card };
    this.position(pop, card);
  }

  private position(pop: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    // Popover is already in the DOM, measure after insert.
    const popRect = pop.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = rect.bottom + ANCHOR_MARGIN_PX;
    if (top + popRect.height > vh - ANCHOR_MARGIN_PX) {
      // Flip above if there's no room below.
      top = Math.max(ANCHOR_MARGIN_PX, rect.top - popRect.height - ANCHOR_MARGIN_PX);
    }
    let left = rect.left;
    if (left + popRect.width > vw - ANCHOR_MARGIN_PX) {
      left = Math.max(ANCHOR_MARGIN_PX, vw - popRect.width - ANCHOR_MARGIN_PX);
    }
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }

  private cancelHoverTimer(): void {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }
}
