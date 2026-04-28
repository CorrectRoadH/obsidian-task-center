export function weekMinHeightFromViewHeightPx(viewHeight: number): number {
  if (!Number.isFinite(viewHeight) || viewHeight <= 0) return 0;
  return Math.ceil(viewHeight / 2);
}
