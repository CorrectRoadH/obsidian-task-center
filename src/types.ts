// US-305: `[-] ❌` is "abandoned" and is its own checkbox-status semantic
// (`dropped`), separate from `done`. Keeping abandonment distinct lets
// users see what they walked away from — not lumped into "completed"
// counts and not pretending it never existed (vs. file deletion).
// see USER_STORIES.md
export type TaskStatus = "todo" | "done" | "dropped" | "in_progress" | "cancelled" | "custom";

export interface ParsedTask {
  id: string;
  path: string;
  line: number;
  indent: string;
  checkbox: string;
  status: TaskStatus;
  title: string;
  rawTitle: string;
  rawLine: string;
  tags: string[];
  scheduled: string | null;
  deadline: string | null;
  start: string | null;
  completed: string | null;
  cancelled: string | null;
  created: string | null;
  estimate: number | null;
  actual: number | null;
  parentLine: number | null;
  parentIndex: number | null;
  childrenLines: number[];
  hash: string;
  mtime: number;
  // US-144: child inherits parent's terminal status (and via parent-side
  // emoji-date inspection in the renderer, parent's ⏳ / 📅 too) — so
  // children don't have to redundantly carry their parent's metadata.
  // Concretely this flag is "any ancestor list item (task OR bullet) is
  // `[x]` done, `[-]` dropped, or tagged `#dropped`". A terminated
  // ancestor suppresses its descendants from todo / unscheduled views
  // (finishing or abandoning a section implicitly finishes everything
  // below it — the cascade complement of US-145).
  // see USER_STORIES.md
  inheritsTerminal: boolean;
}

export interface TaskCenterSettings {
  inboxPath: string;
  // US-301: tags used to group the Unscheduled view, Quick Add chips,
  // context-menu grouping actions, and CLI grouping column. Missing
  // legacy settings fall back to `#1象限`~`#4象限`; explicit empty disables
  // grouping actions.
  // see USER_STORIES.md
  groupingTags: string[];
  defaultView: "today" | "week" | "month" | "completed" | "unscheduled";
  openOnStartup: boolean;
  weekStartsOn: 0 | 1;
  stampCreated: boolean;
  // US-405: last tab the user was on when they closed the board. Persists
  // across Obsidian restarts so morning-open lands where evening-close
  // left off. Read in `TaskCenterView.constructor`'s ViewState init,
  // written in `setTab`.
  // see USER_STORIES.md
  lastTab: "today" | "week" | "month" | "completed" | "unscheduled" | null;
  // US-510: platform-conditional UI strings — shortcut hints / mouse
  // descriptions are branched per platform (desktop hint vs mobile hint),
  // not localized; these tunables also live mobile-only. Safe defaults so
  // desktop users see no change.
  // see USER_STORIES.md
  mobileLongPressMs: number; // 200..1000, default 500
  mobileSwipeEnabled: boolean; // default true (left=done, right=drop)
  // US-502: viewport-based mobile layout switch + force-mobile escape
  // hatch for iPad / split-screen / large foldables that want column
  // layout regardless of width. UX-mobile §7.
  // see USER_STORIES.md
  mobileForceLayout: boolean; // default false (auto = follow viewport width)
}

export const DEFAULT_SETTINGS: TaskCenterSettings = {
  inboxPath: "Tasks/Inbox.md",
  groupingTags: ["#1象限", "#2象限", "#3象限", "#4象限"],
  defaultView: "week",
  openOnStartup: false,
  weekStartsOn: 1,
  stampCreated: true,
  lastTab: null,
  mobileLongPressMs: 500,
  mobileSwipeEnabled: true,
  mobileForceLayout: false,
};

export const VIEW_TYPE_TASK_CENTER = "task-center-board";
