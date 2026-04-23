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
}

export interface BetterTaskSettings {
  inboxPath: string;
  dailyFolder: string;
  defaultView: "week" | "month" | "completed" | "unscheduled";
  openOnStartup: boolean;
  weekStartsOn: 0 | 1;
  stampCreated: boolean;
}

export const DEFAULT_SETTINGS: BetterTaskSettings = {
  inboxPath: "Tasks/Inbox.md",
  dailyFolder: "Daily",
  defaultView: "week",
  openOnStartup: false,
  weekStartsOn: 1,
  stampCreated: true,
};

export const VIEW_TYPE_BETTER_TASK = "better-task-board";
