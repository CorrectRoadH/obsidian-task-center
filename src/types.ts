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
  // True if any ancestor list item (task OR bullet) is in a terminal state —
  // `[x]` done, `[-]` dropped, or tagged `#dropped`. A terminated ancestor
  // suppresses its descendants from todo/unscheduled views (finishing or
  // abandoning a section implicitly finishes everything below it).
  inheritsTerminal: boolean;
}

export interface TaskCenterSettings {
  inboxPath: string;
  dailyFolder: string;
  defaultView: "week" | "month" | "completed" | "unscheduled";
  openOnStartup: boolean;
  weekStartsOn: 0 | 1;
  stampCreated: boolean;
  // Last tab the user was on when they closed the board. Persists across
  // Obsidian restarts so morning-open lands where evening-close left off.
  lastTab: "week" | "month" | "completed" | "unscheduled" | null;
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
  dailyFolder: "Daily",
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
