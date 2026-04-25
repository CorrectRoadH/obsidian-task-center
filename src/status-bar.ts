// Status bar — shows the active todo count.
//
// Subscribes to `cache.on("changed")` only — never to vault events or to
// `metadataCache.on("resolved")` (BUG.md #3 / #4: those flooded the main
// thread on large vaults and froze Obsidian even when the board was never
// opened). The cache populates passively from `metadataCache.changed`
// single-file callbacks; the status-bar count grows as files are indexed.
//
// `refresh()` reads `cache.flatten()` synchronously — no full vault scan,
// no await. The cache may not be fully primed (no one opened the board yet)
// and that's fine: the count grows as files get indexed (ARCHITECTURE.md §3.3).

import { ParsedTask } from "./types";
import { TaskCache } from "./cache";
import { todayISO } from "./dates";

const REFRESH_DEBOUNCE_MS = 500;

export interface StatusBarOptions {
  /** Called when the status bar text is clicked. Typically opens the board. */
  onClick: () => void;
}

export class StatusBar {
  private timer: number | null = null;
  private readonly cacheUnsub: () => void;

  constructor(
    private readonly el: HTMLElement,
    private readonly cache: TaskCache,
    opts: StatusBarOptions,
  ) {
    this.el.addClass("task-center-status");
    this.el.addEventListener("click", opts.onClick);
    this.cacheUnsub = this.cache.on("changed", () => this.scheduleRefresh());
  }

  /** Force an immediate render. */
  refresh(): void {
    const all = this.cache.flatten();
    const today = todayISO();
    const todo = all.filter(activeTodo);
    const todayCount = todo.filter((t) => t.scheduled === today).length;
    const overdue = todo.filter((t) => t.deadline && t.deadline < today).length;
    const parts = [`📋 ${todayCount} today`];
    if (overdue > 0) parts.push(`⚠ ${overdue} overdue`);
    this.el.setText(parts.join(" · "));
    this.el.title = "Click to open Task Board";
  }

  /**
   * Flush any pending debounce + render now. Used by `plugin.__forFlush()`
   * so e2e tests get a deterministic post-event read.
   */
  flush(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
      this.refresh();
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.cacheUnsub();
  }

  private scheduleRefresh(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }
}

function activeTodo(t: ParsedTask): boolean {
  return t.status === "todo" && !t.inheritsTerminal;
}
