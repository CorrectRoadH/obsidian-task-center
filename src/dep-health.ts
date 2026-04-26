// US-701 dependency health surface.
//
// The plugin depends on a couple of other plugins to behave well:
//   1. Obsidian's built-in Daily Notes plugin (folder + format options) —
//      Quick Add / addTask resolve their write target through it. When
//      it's disabled or has its folder explicitly cleared, the writer
//      silently falls back to `settings.inboxPath`.
//   2. The Obsidian Tasks community plugin — when present, our parser
//      stays format-compatible with what Tasks renders. When absent,
//      Tasks-format extensions in the user's notes may not display the
//      way they're used to.
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
  | "tasks-missing"
  | "tasks-disabled";

interface InternalPluginShape {
  enabled?: boolean;
  instance?: { options?: { folder?: string; format?: string } };
}

/** Pure check: returns the worst-currently-true Daily Notes warning, or null.
 *
 * Only an *explicit* empty-string folder is treated as "not configured" —
 * `undefined` / `null` mean the user has never opened the Daily Notes
 * settings page and Obsidian is happily writing to the vault root, which
 * is a valid (if minimal) configuration. Warning on undefined would noise
 * up vaults that never enabled the plugin at all.
 */
export function checkDailyNotes(app: App | null | undefined): DepWarningCode | null {
  const dn = (app as unknown as {
    internalPlugins?: { plugins?: Record<string, InternalPluginShape> };
  })?.internalPlugins?.plugins?.["daily-notes"];
  if (!dn?.enabled) return "daily-notes-disabled";
  const folder = dn.instance?.options?.folder;
  if (folder === "") return "daily-notes-no-folder";
  return null;
}

/** Pure check: returns the Tasks community-plugin warning, or null.
 *
 * `app.plugins.manifests["obsidian-tasks"]` ⇒ user has the plugin installed
 * (Obsidian saw the manifest on disk). `app.plugins.plugins["obsidian-tasks"]`
 * ⇒ the plugin is loaded — i.e. enabled. The "healthy" branch keys on the
 * loaded entry, not the manifest, so `fakeEnableTasks()` test fixtures that
 * inject only the loaded entry still count as healthy.
 */
export function checkTasksPlugin(app: App | null | undefined): DepWarningCode | null {
  const plugins = (app as unknown as {
    plugins?: { manifests?: Record<string, unknown>; plugins?: Record<string, unknown> };
  })?.plugins;
  if (plugins?.plugins?.["obsidian-tasks"]) return null;
  if (plugins?.manifests?.["obsidian-tasks"]) return "tasks-disabled";
  return "tasks-missing";
}

/**
 * The full set of checks the banner runs, in display order. Daily Notes
 * comes first because its failure affects the *write* path (where Quick
 * Add lands); Tasks comes second because its failure affects *render*
 * compatibility (lossier but recoverable).
 */
const CHECKS: Array<(app: App | null | undefined) => DepWarningCode | null> = [
  checkDailyNotes,
  checkTasksPlugin,
];

function warningMessageKey(code: DepWarningCode): Parameters<typeof tr>[0] {
  switch (code) {
    case "daily-notes-disabled":
      return "dep.dailyNotesDisabled";
    case "daily-notes-no-folder":
      return "dep.dailyNotesNoFolder";
    case "tasks-missing":
      return "dep.tasksMissing";
    case "tasks-disabled":
      return "dep.tasksDisabled";
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
 * write-path issue (Daily Notes) before the render-compatibility one
 * (Tasks). Both can show simultaneously without overwriting each other.
 */
export class DepHealthBanner {
  private active: DepWarningCode[] = [];

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
    const next = CHECKS.map((c) => c(this.app)).filter(
      (w): w is DepWarningCode => w !== null,
    );
    if (sameCodes(next, this.active)) return;
    this.active = next;
    this.el.empty();
    for (const code of next) {
      const item = this.el.createDiv({ cls: `task-center-dep-warning task-center-dep-warning-${code}` });
      item.dataset.depWarning = code;
      item.setText(`⚠ ${tr(warningMessageKey(code))}`);
      item.title = tr("dep.openSettings");
    }
  }

  dispose(): void {
    this.el.empty();
    this.active = [];
  }
}

function sameCodes(a: DepWarningCode[], b: DepWarningCode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
