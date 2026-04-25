// Mobile pointer-based drag controller (US-507 / UX-mobile §5.2 / §13 #2 #4 #6).
//
// Why a separate controller from desktop's HTML5 DnD: mobile browsers don't
// reliably synthesize the dragstart/dragover/drop event chain from touch
// pointers. We use raw PointerEvent + a floating clone + elementFromPoint
// hit-testing — same approach iOS / Android native task switchers use.
//
// Wiring (one instance per board view):
//   const mobileDrag = new MobileDragController({...});
//   // for each card: attachCardGestures(card, { onDragArmed: () => mobileDrag.begin(...) })
//   // on view close: mobileDrag.destroy()
//
// State machine of one drag (pointermove flow):
//   begin(card, taskId, x, y)
//     ├─ make floating clone, position at pointer, fix to viewport
//     ├─ start rAF auto-scroll loop (60px edge threshold)
//     └─ return DragSession { onMove, onEnd }
//
//   onMove(x, y)  -- called by gesture controller per pointermove
//     ├─ position clone at (x, y)
//     ├─ hide clone → elementFromPoint → restore clone
//     ├─ classify hit: tab head | day cell | trash | card body | nothing
//     ├─ drive TabDwellTracker (mobile mode 800ms)
//     └─ paint visual hover state on hit el (data-tc-drop-hover attr)
//
//   onEnd(committed)
//     ├─ resolve final hit (snapshot of last hover)
//     ├─ if committed && legal target: dispatch handler (schedule/drop/nest)
//     └─ teardown clone + scroll loop + dwell + hover paint

import { TabDwellTracker } from "./dnd";

/** Returned by `MobileDragController.begin`; gesture caller drives lifecycle. */
export interface MobileDragSession {
  onMove(x: number, y: number): void;
  onEnd(committed: boolean): void;
}

export interface MobileDragOptions<TabKey extends string> {
  /** The scrollable element of the board (auto-scroll on edge). */
  scrollEl: HTMLElement;
  /** Container for floating clone + visual hover hooks. */
  contentEl: HTMLElement;
  /** Mobile cross-tab dwell duration (ms). UX-mobile §5.2 says 800. */
  dwellMs: number;
  /** Distance from viewport edge that triggers auto-scroll (px). */
  edgeScrollPx: number;
  /** Auto-scroll speed in px / second when fully at the edge. */
  edgeScrollMaxSpeed: number;
  /** Returns the currently-active board tab; needed by TabDwellTracker. */
  getCurrentTab: () => TabKey;
  /** Called when a tab head has been dwelled long enough. */
  onTabSwitch: (tab: TabKey) => void;
  /** Drop handlers — caller runs the actual writer + undo bookkeeping. */
  onScheduleDrop: (taskId: string, dateISO: string) => void;
  onTrashDrop: (taskId: string) => void;
  onNestDrop: (droppedId: string, parentTaskId: string) => void;
}

interface DragHitState {
  el: HTMLElement | null;
  tab: string | null;
  date: string | null;
  dropZone: string | null;
  cardId: string | null;
  // For tab dwell visual: the actual tab head DOM element (we paint progress
  // CSS variable on it).
  tabEl: HTMLElement | null;
}

const HOVER_ATTR = "data-tc-drop-hover";

export class MobileDragController<TabKey extends string> {
  private clone: HTMLElement | null = null;
  private dwell: TabDwellTracker<TabKey>;
  private rafId: number | null = null;
  private lastTickTs = 0;
  private lastPointerY = 0;
  private hovered: HTMLElement | null = null;
  private active = false;
  private taskId: string | null = null;
  private lastHit: DragHitState = blankHit();

  constructor(private readonly opts: MobileDragOptions<TabKey>) {
    this.dwell = new TabDwellTracker<TabKey>({
      durationMs: opts.dwellMs,
      onCommit: (tab) => this.opts.onTabSwitch(tab),
    });
  }

  /**
   * Start a drag. Caller (gesture controller) has already verified the user
   * meant to drag (long-press 250ms + first move past 4px threshold).
   * Returns the `MobileDragSession` to drive subsequent move/end events.
   */
  begin(
    card: HTMLElement,
    taskId: string,
    x: number,
    y: number,
  ): MobileDragSession {
    this.cancel(); // belt-and-suspenders: clear any prior session
    this.active = true;
    this.taskId = taskId;
    this.opts.contentEl.classList.add("dragging-active");

    // Floating clone — visually echo the source card. CSS handles the look
    // (opacity, shadow); JS only owns position + size.
    const rect = card.getBoundingClientRect();
    const clone = card.cloneNode(true) as HTMLElement;
    clone.classList.add("bt-mobile-drag-clone");
    clone.style.position = "fixed";
    clone.style.left = "0px";
    clone.style.top = "0px";
    clone.style.width = `${rect.width}px`;
    clone.style.pointerEvents = "none";
    clone.style.zIndex = "9999";
    clone.style.transform = `translate(${x - rect.width / 2}px, ${y - rect.height / 2}px)`;
    document.body.appendChild(clone);
    this.clone = clone;

    this.lastPointerY = y;
    this.lastTickTs = performance.now();
    this.startScrollLoop();

    return {
      onMove: (mx, my) => this.handleMove(mx, my),
      onEnd: (committed) => this.handleEnd(committed),
    };
  }

  /** Force-cancel a drag (e.g. on view unmount). Idempotent. */
  cancel(): void {
    if (!this.active) return;
    this.handleEnd(false);
  }

  destroy(): void {
    this.cancel();
  }

  // ---------- internal ----------

  private handleMove(x: number, y: number): void {
    if (!this.clone) return;
    this.lastPointerY = y;
    const rect = this.clone.getBoundingClientRect();
    this.clone.style.transform = `translate(${x - rect.width / 2}px, ${y - rect.height / 2}px)`;

    const hit = this.classifyHit(x, y);
    this.paintHover(hit);
    this.lastHit = hit;

    // Drive tab dwell — only fires when the hovered tab differs from current.
    const currentTab = this.opts.getCurrentTab();
    this.dwell.update(
      hit.tab as TabKey | null,
      hit.tabEl,
      currentTab,
    );
  }

  private handleEnd(committed: boolean): void {
    if (!this.active) return;
    this.active = false;
    const hit = this.lastHit;
    const taskId = this.taskId;
    this.taskId = null;
    this.lastHit = blankHit();
    this.dwell.reset();
    this.stopScrollLoop();
    this.opts.contentEl.classList.remove("dragging-active");
    this.clearHoverPaint();
    if (this.clone) {
      this.clone.remove();
      this.clone = null;
    }

    if (!committed || !taskId) return;
    if (hit.dropZone === "trash") {
      this.opts.onTrashDrop(taskId);
    } else if (hit.date) {
      this.opts.onScheduleDrop(taskId, hit.date);
    } else if (hit.cardId && hit.cardId !== taskId) {
      this.opts.onNestDrop(taskId, hit.cardId);
    }
    // Otherwise: drop on empty space → no-op (UX-mobile §6.2 cancellation).
  }

  /**
   * elementFromPoint with the clone hidden so it doesn't shadow real targets.
   * Then walks up the parents to find any data-* attribute we recognise.
   */
  private classifyHit(x: number, y: number): DragHitState {
    if (!this.clone) return blankHit();
    const cloneDisplay = this.clone.style.display;
    this.clone.style.display = "none";
    const raw = document.elementFromPoint(x, y) as HTMLElement | null;
    this.clone.style.display = cloneDisplay;
    const result = blankHit();
    if (!raw) return result;

    // Walk up to find any tagged ancestor — `closest()` runs in C, fast.
    const tabEl = raw.closest<HTMLElement>("[data-tab]");
    const dropZoneEl = raw.closest<HTMLElement>("[data-drop-zone]");
    const dateEl = raw.closest<HTMLElement>("[data-date]");
    const cardEl = raw.closest<HTMLElement>("[data-task-id]");

    // Priority is intentional: trash > date column > card body > tab head.
    // If the user's pointer lands on a card *inside* a day column, we treat
    // the inner card as the target (nest), matching desktop semantics where
    // dragover on a card stopPropagation()s upward.
    result.el = raw;
    if (dropZoneEl) {
      result.dropZone = dropZoneEl.dataset.dropZone ?? null;
    }
    if (cardEl) {
      result.cardId = cardEl.dataset.taskId ?? null;
    }
    if (dateEl && !cardEl) {
      // Card-on-day: prefer card. Date-only: schedule into that day.
      result.date = dateEl.dataset.date ?? null;
    }
    if (tabEl && !dropZoneEl && !dateEl && !cardEl) {
      // Tab head triggers dwell — but only if the pointer is actually on the
      // tab head (no overlay zones on top).
      result.tab = tabEl.dataset.tab ?? null;
      result.tabEl = tabEl;
    } else if (tabEl) {
      // Pointer on a tab head while ALSO over a drop zone (e.g. tab strip
      // floats above board content): still report tab so dwell can drive,
      // but dwell logic ignores `tab === currentTab`.
      result.tab = tabEl.dataset.tab ?? null;
      result.tabEl = tabEl;
    }
    return result;
  }

  private paintHover(hit: DragHitState): void {
    let candidate: HTMLElement | null = null;
    if (hit.dropZone === "trash") {
      candidate = hit.el?.closest<HTMLElement>("[data-drop-zone='trash']") ?? null;
    } else if (hit.cardId) {
      candidate = hit.el?.closest<HTMLElement>("[data-task-id]") ?? null;
    } else if (hit.date) {
      candidate = hit.el?.closest<HTMLElement>("[data-date]") ?? null;
    }
    if (candidate === this.hovered) return;
    if (this.hovered) this.hovered.removeAttribute(HOVER_ATTR);
    this.hovered = candidate;
    if (candidate) candidate.setAttribute(HOVER_ATTR, "true");
  }

  private clearHoverPaint(): void {
    if (this.hovered) {
      this.hovered.removeAttribute(HOVER_ATTR);
      this.hovered = null;
    }
  }

  // ---------- edge auto-scroll ----------

  private startScrollLoop(): void {
    this.stopScrollLoop();
    const tick = (now: number) => {
      if (!this.active) return;
      const dt = Math.max(0, now - this.lastTickTs);
      this.lastTickTs = now;
      this.maybeScroll(dt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopScrollLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * If the pointer is within `edgeScrollPx` of the scroll element's top or
   * bottom, scroll proportionally (full speed at the very edge). dt-based
   * so speed is consistent across vsync rates (60 / 90 / 120 Hz).
   */
  private maybeScroll(dtMs: number): void {
    const scrollEl = this.opts.scrollEl;
    const rect = scrollEl.getBoundingClientRect();
    const y = this.lastPointerY;
    const edge = this.opts.edgeScrollPx;
    const max = this.opts.edgeScrollMaxSpeed;

    let speed = 0;
    if (y < rect.top + edge) {
      const ratio = Math.max(0, (rect.top + edge - y) / edge);
      speed = -max * ratio;
    } else if (y > rect.bottom - edge) {
      const ratio = Math.max(0, (y - (rect.bottom - edge)) / edge);
      speed = max * ratio;
    }
    if (speed === 0) return;
    scrollEl.scrollTop += (speed * dtMs) / 1000;
  }
}

function blankHit(): DragHitState {
  return {
    el: null,
    tab: null,
    date: null,
    dropZone: null,
    cardId: null,
    tabEl: null,
  };
}
