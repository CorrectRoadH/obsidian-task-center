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

export interface BetterTaskSettings {
  inboxPath: string;
  dailyFolder: string;
  defaultView: "week" | "month" | "completed" | "unscheduled";
  openOnStartup: boolean;
  weekStartsOn: 0 | 1;
  stampCreated: boolean;
  // Last tab the user was on when they closed the board. Persists across
  // Obsidian restarts so morning-open lands where evening-close left off.
  lastTab: "week" | "month" | "completed" | "unscheduled" | null;
}

export const DEFAULT_SETTINGS: BetterTaskSettings = {
  inboxPath: "Tasks/Inbox.md",
  dailyFolder: "Daily",
  defaultView: "week",
  openOnStartup: false,
  weekStartsOn: 1,
  stampCreated: true,
  lastTab: null,
};

export const VIEW_TYPE_BETTER_TASK = "better-task-board";
