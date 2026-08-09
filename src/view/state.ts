import type { QueryStatus, QueryTimeField, QueryTimeFilters } from "../types";

export type TabKey = "today" | "week" | "month" | "completed" | "unscheduled" | "list";
export type FilterPopoverKey = "view" | "tag" | "status" | "time-more" | `time:${QueryTimeField}`;

export interface ViewState {
  tab: TabKey;
  anchorISO: string;
  selectedTaskId: string | null;
  filter: string;
  savedViewId: string | null;
  savedViewTag: string;
  savedViewTime: QueryTimeFilters;
  savedViewStatus: QueryStatus;
  showUnscheduledPool: boolean;
  collapsedWeeks: Set<string>;
  expandedDays: Set<string>;
  selectedWeekDay: string | null;
  selectedMonthDay: string | null;
  // US-511: 移动端各 tab 当前展开哪个 area（DFS 索引）。会话态，不持久化。
  // 缺省（无键）回退到当前视图的首个内容 area；-1 表示全部收起。
  expandedAreaByTab: Record<string, number>;
}
