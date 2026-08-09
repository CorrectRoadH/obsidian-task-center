export type PaneLayout = "narrow" | "compact" | "wide";

/**
 * US-514: layout follows the plugin pane, not the application window.
 * Input modality is deliberately absent: a narrow desktop pane is still a
 * pointer surface and keeps drag, hover, right click, and keyboard behavior.
 */
export function classifyPaneLayout(width: number): PaneLayout {
  if (width < 600) return "narrow";
  if (width < 1120) return "compact";
  return "wide";
}
