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

/** US-303: ratio compares only tasks with both measurements. */
export function summarizeAreaTasks(tasks: ReadonlyArray<{
  estimate: number | null;
  actual: number | null;
  effectiveStatus: string;
}>): { count: number; estimate: number; actual: number; hasDone: boolean; percent: number | null } {
  let estimate = 0;
  let actual = 0;
  let pairedEstimate = 0;
  let pairedActual = 0;
  let hasDone = false;
  for (const task of tasks) {
    estimate += task.estimate ?? 0;
    actual += task.actual ?? 0;
    if (task.effectiveStatus === "done") hasDone = true;
    if (task.estimate != null && task.actual != null) {
      pairedEstimate += task.estimate;
      pairedActual += task.actual;
    }
  }
  return { count: tasks.length, estimate, actual, hasDone,
    percent: pairedEstimate > 0 ? Math.round(pairedActual / pairedEstimate * 100) : null };
}
