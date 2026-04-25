// Touch interaction primitives for the mobile board.
//
// PointerEvent-based (UX-mobile.md §13 #2) so the same code paths handle
// touch, mouse, and pen. Right now this only owns long-press detection;
// the planned drag controller (UX-mobile §5.2 / §13 #6) will live alongside
// here so that long-press and drag share one piece of state and can
// implement the "first to fire wins" mutual-exclusion rule cleanly.
//
// `setTimeout` is used for the simple "is the user still here in 500ms"
// timer — that's not a precision requirement and the rAF + perf.now()
// pattern is reserved for the drag-dwell tab-switch (handled elsewhere
// by `TabDwellTracker`, where main-thread stalls during cache reparse
// would matter).

export interface LongPressOptions {
  /** ms before the long-press fires. Default 500. */
  durationMs?: number;
  /** Cancel if the pointer moves more than this many pixels. Default 4. */
  moveThresholdPx?: number;
  /** Fired once if the user holds still for `durationMs`. */
  onTrigger: () => void;
}

/**
 * Attach a long-press detector to `el`. Returns a detach function that
 * unwires every listener — call it on view re-render so stale cards don't
 * keep window-level move/up listeners around.
 */
export function attachLongPress(
  el: HTMLElement,
  opts: LongPressOptions,
): () => void {
  const durationMs = opts.durationMs ?? 500;
  const moveThresholdPx = opts.moveThresholdPx ?? 4;
  let timer: number | null = null;
  let startX = 0;
  let startY = 0;

  const cancel = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", cancel);
    window.removeEventListener("pointercancel", cancel);
  };

  const onMove = (e: PointerEvent) => {
    if (
      Math.abs(e.clientX - startX) > moveThresholdPx ||
      Math.abs(e.clientY - startY) > moveThresholdPx
    ) {
      // Movement past threshold = drag intent or scroll, NOT long-press.
      // Bail without firing — never claim a gesture the user redirected.
      cancel();
    }
  };

  const onDown = (e: PointerEvent) => {
    // Right-click / aux button shouldn't fire long-press on desktop browsers.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    timer = window.setTimeout(() => {
      timer = null;
      // Move/up listeners can stay no-op until cleared on real release —
      // simpler to just clear them now that we've fired.
      cancel();
      opts.onTrigger();
    }, durationMs);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
  };

  el.addEventListener("pointerdown", onDown);
  return () => {
    el.removeEventListener("pointerdown", onDown);
    cancel();
  };
}
