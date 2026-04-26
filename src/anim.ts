/**
 * Fade + scale + collapse-height animation for removing a card from the view.
 * Uses the Web Animations API — no library, no runtime deps.
 *
 * Collapsing maxHeight + margin to 0 in parallel with the fade is what lets
 * neighbouring cards slide up smoothly instead of snapping after a re-render.
 * Resolves when the animation finishes (or immediately if the element is
 * already detached / interrupted mid-flight).
 *
 * US-127: every card removal flows through this helper so the eye sees
 * a fade + neighbours sliding up rather than a snap-disappearance. In-
 * place mutations don't animate (no element to remove).
 * see USER_STORIES.md
 */
export async function animateOut(el: HTMLElement, durationMs = 180): Promise<void> {
  if (!el.isConnected) return;
  const cs = getComputedStyle(el);
  const h = el.getBoundingClientRect().height;
  const mt = cs.marginTop;
  const mb = cs.marginBottom;
  el.style.overflow = "hidden";
  el.style.pointerEvents = "none";
  try {
    const anim = el.animate(
      [
        {
          opacity: 1,
          transform: "scale(1)",
          maxHeight: `${h}px`,
          marginTop: mt,
          marginBottom: mb,
        },
        {
          opacity: 0,
          transform: "scale(0.94)",
          maxHeight: "0px",
          marginTop: "0px",
          marginBottom: "0px",
        },
      ],
      {
        duration: durationMs,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        fill: "forwards",
      },
    );
    await anim.finished;
  } catch {
    // Animation cancelled (DOM removed mid-flight, view re-rendered, etc.) — non-fatal
  }
}
