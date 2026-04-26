// US-701 dependency health surface for the built-in Daily Notes plugin.
//
// Quick Add and `addTask` resolve their write target through Obsidian's
// built-in Daily Notes plugin (folder + format options). When that plugin
// is disabled, or enabled but missing a folder, the writer silently falls
// back to `settings.inboxPath`. Users would land on the wrong file with
// no visible explanation. US-701 surfaces this as an actionable status-bar
// banner instead.

import { App } from "obsidian";
import { t as tr } from "./i18n";

export type DepWarningCode =
  | "daily-notes-disabled"
  | "daily-notes-no-folder"
  | null;

interface InternalPluginShape {
  enabled?: boolean;
  instance?: { options?: { folder?: string; format?: string } };
}

/** Pure check: returns the worst-currently-true warning, or null if healthy.
 *
 * Only an *explicit* empty-string folder is treated as "not configured" —
 * `undefined` / `null` mean the user has never opened the Daily Notes
 * settings page and Obsidian is happily writing to the vault root, which
 * is a valid (if minimal) configuration. Warning on undefined would noise
 * up vaults that never enabled the plugin at all.
 */
export function checkDailyNotes(app: App | null | undefined): DepWarningCode {
  const dn = (app as unknown as {
    internalPlugins?: { plugins?: Record<string, InternalPluginShape> };
  })?.internalPlugins?.plugins?.["daily-notes"];
  if (!dn?.enabled) return "daily-notes-disabled";
  const folder = dn.instance?.options?.folder;
  if (folder === "") return "daily-notes-no-folder";
  return null;
}

export interface DepHealthBannerOptions {
  /** Open Obsidian's plugin settings tab so the user can fix the dep. */
  onClick: () => void;
}

/**
 * Status-bar banner that mirrors `checkDailyNotes()` onto a persistent DOM
 * element. The element carries `data-dep-warning="<code>"` when unhealthy
 * so e2e specs (and css) can target it; the attribute is removed when the
 * deps recover, so a `[data-dep-warning]` selector returns nothing on a
 * healthy vault (US-701c — guard against false positives).
 */
export class DepHealthBanner {
  private current: DepWarningCode = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly app: App,
    opts: DepHealthBannerOptions,
  ) {
    this.el.addClass("task-center-dep-health");
    this.el.addEventListener("click", opts.onClick);
    this.refresh();
  }

  /** Re-read dep state and repaint. Cheap — safe to call from any event. */
  refresh(): void {
    const next = checkDailyNotes(this.app);
    if (next === this.current) return;
    this.current = next;
    if (next === null) {
      this.el.removeAttribute("data-dep-warning");
      this.el.empty();
      return;
    }
    this.el.setAttribute("data-dep-warning", next);
    const msg =
      next === "daily-notes-disabled"
        ? tr("dep.dailyNotesDisabled")
        : tr("dep.dailyNotesNoFolder");
    this.el.setText(`⚠ ${msg}`);
    this.el.title = tr("dep.openSettings");
  }

  dispose(): void {
    this.el.empty();
    this.el.removeAttribute("data-dep-warning");
  }
}
