// Drag-and-drop helpers for the board view.
//
// Right now this module only owns `TabDwellTracker` — the rAF + performance.now
// based "hover a card over a tab for 600ms to switch to it" behaviour required
// by UX.md §6.1 and ARCHITECTURE.md §11 (hard constraint #8).
//
// `setTimeout(fn, 600)` was the previous implementation. It drifts when the
// main thread stalls (e.g. while the cache reparses a freshly-modified file
// during a drag), which is exactly when the dwell needs to be precise. rAF
// ticks are clamped to display vsync; `performance.now()` reads a monotonic
// clock; together they give a stable elapsed-time measurement.
//
// The tracker is also where per-tab progress visualization lives. We don't
// touch DOM directly — instead we publish `progress: 0..1` on the hovered
// element via a CSS custom property, and a pseudo-element in styles.css
// renders the bar. This keeps the controller DOM-light and CSS-themable.

export interface TabDwellTrackerOptions<TabKey extends string> {
  /** Duration the cursor must stay on a target tab head before commit. */
  durationMs: number;
  /** Called when a target tab has been hovered for `durationMs`. */
  onCommit: (tab: TabKey) => void;
  /**
   * Optional progress callback (0..1) per rAF tick. Default behavior writes
   * `--tc-dwell-progress` on the hovered element; pass your own to override.
   */
  onProgress?: (tab: TabKey, el: HTMLElement, progress: number) => void;
}

export class TabDwellTracker<TabKey extends string> {
  private rafId: number | null = null;
  private startTs: number | null = null;
  private targetTab: TabKey | null = null;
  private targetEl: HTMLElement | null = null;

  constructor(private readonly opts: TabDwellTrackerOptions<TabKey>) {}

  /**
   * Call on `dragover` events from tab heads.
   *
   * Pass `hoveredTab=null` (or call `reset()`) on `dragleave` / `dragend`.
   * If `hoveredTab === currentTab`, no dwell — already on the target.
   */
  update(
    hoveredTab: TabKey | null,
    hoveredEl: HTMLElement | null,
    currentTab: TabKey,
  ): void {
    if (hoveredTab === null || hoveredTab === currentTab) {
      this.reset();
      return;
    }
    if (hoveredTab !== this.targetTab) {
      // Switched targets mid-drag — restart the timer on the new tab so the
      // user can't accumulate progress across two heads.
      this.cancelTick();
      this.clearProgress();
      this.startTs = null;
    }
    this.targetTab = hoveredTab;
    this.targetEl = hoveredEl;
    if (this.startTs === null) {
      this.startTs = performance.now();
      this.tick();
    }
  }

  reset(): void {
    this.cancelTick();
    this.clearProgress();
    this.startTs = null;
    this.targetTab = null;
    this.targetEl = null;
  }

  private tick = (): void => {
    if (this.startTs === null || this.targetTab === null) return;
    const elapsed = performance.now() - this.startTs;
    const progress = Math.min(elapsed / this.opts.durationMs, 1);
    if (this.targetEl) {
      if (this.opts.onProgress) {
        this.opts.onProgress(this.targetTab, this.targetEl, progress);
      } else {
        this.targetEl.style.setProperty("--tc-dwell-progress", String(progress));
      }
    }
    if (elapsed >= this.opts.durationMs) {
      const target = this.targetTab;
      this.reset();
      this.opts.onCommit(target);
      return;
    }
    this.rafId = requestAnimationFrame(this.tick);
  };

  private cancelTick(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private clearProgress(): void {
    if (this.targetEl) {
      this.targetEl.style.removeProperty("--tc-dwell-progress");
    }
  }
}
