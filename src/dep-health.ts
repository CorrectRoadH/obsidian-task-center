// US-701 dependency health surface.
//
// The plugin depends on a couple of other plugins to behave well:
//   1. Obsidian's built-in Daily Notes plugin (folder + format options) —
//      Quick Add / addTask resolve their write target through it. When
//      it's disabled or has no configured folder, Quick Add / add fail
//      without writing to an inbox fallback.
//   2. A task-format companion plugin: Obsidian Tasks or Dataview. Task
//      Center can read/write both flavors itself, but users generally expect
//      at least one companion to render/query the same metadata elsewhere in
//      the vault.
//
// Both classes of dependency surface through one widget — the status-bar
// `DepHealthBanner` — to avoid two competing notice strips. Each active
// warning gets its own sub-element carrying `data-dep-warning="<code>"`
// so e2e specs (and css) can target a specific warning, while the
// `[data-dep-warning]` selector returns nothing when every dep is healthy.

import { App } from "obsidian";
import { t as tr } from "./i18n";

export type DepWarningCode =
  | "daily-notes-disabled"
  | "daily-notes-no-folder"
  | "task-format-companion-missing"
  | "task-format-companion-disabled";

interface InternalPluginShape {
  enabled?: boolean;
  instance?: { options?: { folder?: string; format?: string } };
}

const TASKS_PLUGIN_ID = "obsidian-tasks-plugin";
const DATAVIEW_PLUGIN_ID = "dataview";

/** Pure check: returns the worst-currently-true Daily Notes warning, or null.
 *
 * A missing or empty folder is treated as "not configured" because task
 * creation now requires a Daily Notes folder rather than falling back to an
 * inbox file.
 */
export function checkDailyNotes(app: App | null | undefined): DepWarningCode | null {
  const dn = (app as unknown as {
    internalPlugins?: { plugins?: Record<string, InternalPluginShape> };
  })?.internalPlugins?.plugins?.["daily-notes"];
  if (!dn?.enabled) return "daily-notes-disabled";
  const folder = dn.instance?.options?.folder;
  if (!folder) return "daily-notes-no-folder";
  return null;
}

/** Pure check: returns the task-format companion warning, or null.
 *
 * Either Tasks or Dataview being loaded is healthy. If neither is loaded but
 * at least one manifest exists, the user has a companion installed but disabled.
 * If neither manifest exists, no supported companion is installed.
 */
export function checkTaskFormatCompanion(app: App | null | undefined): DepWarningCode | null {
  const plugins = (app as unknown as {
    plugins?: { manifests?: Record<string, unknown>; plugins?: Record<string, unknown> };
  })?.plugins;
  const loaded = plugins?.plugins ?? {};
  const manifests = plugins?.manifests ?? {};
  if (loaded[TASKS_PLUGIN_ID] || loaded[DATAVIEW_PLUGIN_ID]) return null;
  if (manifests[TASKS_PLUGIN_ID] || manifests[DATAVIEW_PLUGIN_ID]) {
    return "task-format-companion-disabled";
  }
  return "task-format-companion-missing";
}

/**
 * The full set of checks the banner runs, in display order. Daily Notes
 * comes first because its failure affects the *write* path (where Quick
 * Add lands); the format companion comes second because its failure affects
 * cross-plugin render/query compatibility (lossier but recoverable).
 */
const CHECKS: Array<(app: App | null | undefined) => DepWarningCode | null> = [
  checkDailyNotes,
  checkTaskFormatCompanion,
];

function warningMessageKey(code: DepWarningCode): Parameters<typeof tr>[0] {
  switch (code) {
    case "daily-notes-disabled":
      return "dep.dailyNotesDisabled";
    case "daily-notes-no-folder":
      return "dep.dailyNotesNoFolder";
    case "task-format-companion-missing":
      return "dep.taskFormatCompanionMissing";
    case "task-format-companion-disabled":
      return "dep.taskFormatCompanionDisabled";
  }
}

export interface DepHealthBannerOptions {
  /** Open Obsidian's plugin settings tab so the user can fix the dep. */
  onClick: () => void;
}

/**
 * Status-bar banner that mirrors the active dependency warnings onto a
 * persistent container. Each active warning becomes a child element with
 * `data-dep-warning="<code>"`; healthy deps render no element, so a
 * `[data-dep-warning]` selector returns nothing on a fully-healthy vault
 * (US-701c / US-701f — guard against false positives).
 *
 * Layout: warnings render in `CHECKS` order so the user sees the
 * write-path issue (Daily Notes) before the render/query-compatibility one.
 * Both can show simultaneously without overwriting each other.
 */
export class DepHealthBanner {
  private active: DepWarningCode[] = [];
  private readonly timer: number;

  constructor(
    private readonly el: HTMLElement,
    private readonly app: App,
    private readonly opts: DepHealthBannerOptions,
  ) {
    this.el.addClass("task-center-dep-health");
    this.refresh();
    // Plugin enable/disable and settings changes have no public dedicated event.
    this.timer = window.setInterval(() => this.refresh(), 1000);
  }

  /** Re-read dep state and repaint. Cheap — safe to call from any event. */
  refresh(): void {
    const next = CHECKS.map((c) => c(this.app)).filter(
      (w): w is DepWarningCode => w !== null,
    );
    if (sameCodes(next, this.active)) return;
    this.active = next;
    this.el.empty();
    for (const code of next) {
      const item = this.el.createEl("button", { cls: `task-center-dep-warning task-center-dep-warning-${code}` });
      item.dataset.depWarning = code;
      item.setText(`⚠ ${tr(warningMessageKey(code))}`);
      item.title = tr("dep.openSettings");
      item.addEventListener("click", () => {
        const setting = (this.app as unknown as { setting?: {
          open?: () => void; openTabById?: (id: string) => void;
        } }).setting;
        if (!setting?.open) { this.opts.onClick(); return; }
        setting.open();
        setting.openTabById?.(code.startsWith("task-format-") ? "community-plugins"
          : code === "daily-notes-disabled" ? "core-plugins" : "daily-notes");
      });
    }
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.el.empty();
    this.active = [];
  }
}

function sameCodes(a: DepWarningCode[], b: DepWarningCode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
