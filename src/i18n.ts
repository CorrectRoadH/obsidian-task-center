// Tiny i18n shim. Zero dependency.
//
// Obsidian stores the UI language in localStorage under the key "language".
// It's set when the user picks a language in Settings → About → Language.
// Fallback priority: stored value → navigator.language → "en".

type Locale = "zh" | "en";

// US-402: language auto-detection from Obsidian's UI language setting
// (`localStorage.language`). No separate plugin language toggle —
// Task Center follows whatever the user already configured in Obsidian.
// US-408 calls this on every `t()` so live language switches take effect
// without restart.
// see USER_STORIES.md
function detectLocale(): Locale {
  try {
    const stored = window.localStorage.getItem("language");
    if (stored) {
      if (stored.startsWith("zh")) return "zh";
      if (stored.startsWith("en")) return "en";
    }
  } catch {
    // localStorage may be unavailable in some contexts
  }
  if (typeof navigator !== "undefined" && navigator.language) {
    if (navigator.language.startsWith("zh")) return "zh";
  }
  return "en";
}

const EN = {
  // View tabs
  "tab.today": "Today",
  "tab.week": "Week",
  "tab.month": "Month",
  "tab.completed": "Completed",
  "tab.unscheduled": "Unscheduled",

  // Toolbar
  "toolbar.today": "Today",
  "toolbar.weekNo": "W{n}",
  "toolbar.add": "+ Add",
  "toolbar.filter": "🔍 filter…",

  // Weekdays (used as "周一"/"Mon")
  "weekday.0": "Sun",
  "weekday.1": "Mon",
  "weekday.2": "Tue",
  "weekday.3": "Wed",
  "weekday.4": "Thu",
  "weekday.5": "Fri",
  "weekday.6": "Sat",

  // Unscheduled pool
  "pool.unscheduled": "Unscheduled",
  "pool.hint": "⬆ Drag to week/month · drop here to clear ⏳",
  "pool.other": "other",

  // Unscheduled big view
  "unscheduled.hint":
    "Shortcuts: D date · Space done · 1-9 group · Delete drop",
  "unscheduled.mobileHint":
    "Long-press a card for actions · swipe left = done · swipe right = drop",

  // Trash
  "trash.title": "Trash",
  "trash.hint": "Drop here → [-] ❌",
  "trash.dropped": "🗑 dropped",

  // US-504: mobile month tab uses calendar-grid + dot density + tap-day
  // bottom sheet listing the day's tasks. This empty-state string powers
  // the sheet body when a day has no scheduled tasks.
  // see USER_STORIES.md
  "sheet.empty": "No tasks scheduled this day.",

  // Completed
  "completed.weekOf": "Week of {date}",
  "completed.tasks": "{n} tasks",
  "completed.accuracy": "accuracy {ratio}  ({actual}m / {est}m)",
  "completed.empty": "No completed tasks yet.",

  // Empty vault onboarding
  "loading": "Loading tasks…",
  "onboarding.title": "No tasks yet",
  "onboarding.body":
    "Create your first task: hit Cmd/Ctrl+T here, click + Add, or add a checkbox line in any note: `- [ ] My task #2q ⏳ tomorrow [estimate:: 30m]`.",
  "onboarding.mobileBody":
    "Create your first task: tap + Add below, or write `- [ ] My task #2q ⏳ tomorrow [estimate:: 30m]` in any note.",
  "onboarding.cta": "+ Add your first task",
  "completed.total": "total {actual}m",

  // Footer
  "footer.status": "{todo} todo · {done} done · {overdue} overdue",
  "footer.selected": "selected",
  "footer.hint":
    "1-9 group · ←/→ day · D date · Space done · E edit · Delete drop · Ctrl+Z undo · / search",
  "footer.mobileHint":
    "long-press for menu · swipe left = done · swipe right = drop · drag to reschedule",

  // Notices
  "notice.scheduled": "→ ⏳ {date}",
  "notice.clearedSchedule": "removed schedule",
  "notice.error": "error: {msg}",
  "notice.reloaded": "Task Center: reloaded",
  "notice.fileNotFound": "file not found: {path}",
  "notice.invalidDate": "invalid date",
  "notice.nested": "nested under {title} {where}",
  "notice.crossFile": "(cross-file)",

  // Context menu
  "ctx.openSource": "Open source",
  "ctx.markDone": "Mark done",
  "ctx.markTodo": "Mark todo",
  "ctx.scheduleToday": "Schedule today",
  "ctx.scheduleTomorrow": "Schedule tomorrow",
  "ctx.clearSchedule": "Clear schedule",
  "ctx.quadrant": "Group {n}",
  "ctx.groupingTag": "Set group: {tag}",
  "ctx.drop": "Drop",

  // Inline subtask add (visible on every card)
  "card.addSubtask": "+ subtask",
  "card.subtaskPlaceholder": "subtask title",

  // Quick add modal
  "qa.title": "Add task",
  "qa.placeholder":
    "Buy groceries #3 ⏳ tomorrow [estimate:: 25m]",
  "qa.hint":
    "Shortcuts: today/tomorrow/Mon-Sun auto-resolve to ⏳ dates · #Nq = quadrant · [estimate:: 30m]",

  // Date prompt
  "prompt.setScheduled":
    'Set ⏳ for "{title}"  (YYYY-MM-DD, today, tomorrow, or blank to clear)',

  // Commands
  "cmd.open": "Open Task Board",
  "cmd.quickAdd": "Quick add task",
  "cmd.reloadTasks": "Reload tasks",

  // Ribbon
  "ribbon.open": "Open Task Board",

  // Settings
  "settings.header": "Task Center",
  "settings.inbox.name": "Default inbox path",
  "settings.inbox.desc":
    "Where `task-center:add` puts tasks when to= is omitted and no daily note exists.",
  // task #32 (0.3.0 breaking): `settings.dailyFolder.name/desc` removed
  // — the setting is gone, so the i18n keys for its label/description
  // are dead. Daily-note path now reads from Obsidian's built-in Daily
  // Notes core plugin config exclusively (see writer.ts).
  "settings.groupingTags.name": "Grouping tags",
  "settings.groupingTags.desc":
    "Comma-separated tags for Unscheduled grouping, Quick Add chips, 1-9 shortcuts, and CLI group labels.",
  "settings.defaultView.name": "Default view",
  "settings.defaultView.desc": "Which tab to show when the board opens.",
  "settings.defaultView.today": "Today",
  "settings.defaultView.week": "Week",
  "settings.defaultView.month": "Month",
  "settings.defaultView.completed": "Completed",
  "settings.defaultView.unscheduled": "Unscheduled",
  "settings.weekStart.name": "Week starts on",
  "settings.weekStart.desc": "Monday = ISO; Sunday = US style.",
  "settings.weekStart.mon": "Monday",
  "settings.weekStart.sun": "Sunday",
  "settings.openOnStartup.name": "Open board on startup",
  "settings.openOnStartup.desc":
    "Opens the task board view automatically when Obsidian starts.",
  "settings.mobileHeader": "Mobile",
  "settings.mobileLongPress.name": "Long-press duration (ms)",
  "settings.mobileLongPress.desc":
    "Hold a card this long with no movement to open the action sheet. Higher = fewer accidental opens; lower = snappier.",
  "settings.mobileSwipe.name": "Swipe gestures",
  "settings.mobileSwipe.desc":
    "Left = mark done, right = drop. Disable if swipes conflict with your scroll habits.",
  "settings.mobileForceLayout.name": "Force mobile layout",
  "settings.mobileForceLayout.desc":
    "Keep the narrow / mobile layout regardless of viewport width. Useful on iPad in landscape, split-screen, or large foldables when you prefer the column layout over the desktop one.",
  "settings.cliHeader": "CLI",
  "settings.cliHelp":
    "Verbs register to the native Obsidian CLI (requires Obsidian 1.12.2+). Call them from your shell:",
  "settings.cliAiNote":
    "AI (Claude Code etc.) should call these directly — no eval hacks needed.",

  // US-412: error messages — surfaced via formatError(code, message) in
  // src/cli.ts. The thrown TaskWriterError keeps the English `message`
  // as a developer-facing detail; the i18n template wraps it in the
  // user's current locale.
  "err.task_not_found": "task not found: {ref}",
  "err.invalid_date": "invalid date: {ref}",
  "err.invalid_nest": "invalid nest: {ref}",
  "err.ambiguous_slug": "ambiguous slug: {ref}",

  // task #43 (US-402): persistent status bar + mobile mirrored status row.
  // Same key set is reused by both surfaces so the two stay in lock-step.
  "status.today": "📋 {n} today",
  "status.overdue": "⚠ {n} overdue",
  "status.openTooltip": "Click to open Task Board",

  // task #43: est/act metadata badges on every card.
  "meta.est": "est {dur}",
  "meta.act": "act {dur}",

  // task #43: mobile long-press action sheet (view.ts:openCardActionSheet).
  // `sheet.scheduleAt` formats a single ⏳ button with an explicit ISO date;
  // the date is opaque to the translator (no language-specific reformatting)
  // so EN and ZH share the literal template.
  "sheet.markUndone": "↩ Mark undone",
  "sheet.done": "✓ Done",
  "sheet.scheduleAt": "⏳ {date}",
  "sheet.scheduleClear": "⏳ —",
  "sheet.openSource": "📂 Open source",
  "sheet.drop": "🗑 Drop",

  // task #43: date prompt hint line — bilingual EN baseline (the original
  // hard-coded string already mixed today/tomorrow with 明天/周六; we
  // preserve that mix here and route through tr() so a CN session gets
  // a CN-leaning version).
  "prompt.dateHint":
    "YYYY-MM-DD · today · tomorrow · 明天 · 周六 · (blank to clear)",

  // task #43 (Leo PM HOLD msg cbf0489c): Completed tab 7-day stats
  // header — the third visible Completed surface (alongside the
  // accuracy/total + week-of labels that already routed through tr()).
  "stats.sevenDayDone": "7-day · {n} done",
  "stats.ratio": "ratio {ratio} ({sign}{delta}%)",

  // US-701: dependency-health banner. Surfaced as a status-bar item with
  // `data-dep-warning="..."` when the built-in Daily Notes plugin is
  // disabled or has no folder configured.
  "dep.dailyNotesDisabled":
    "Daily Notes plugin disabled — tasks will be written to inbox",
  "dep.dailyNotesNoFolder":
    "Daily Notes folder not set — tasks will be written to inbox",
  "dep.tasksMissing":
    "Tasks community plugin not installed — Tasks-format extensions may not render",
  "dep.tasksDisabled":
    "Tasks community plugin disabled — Tasks-format extensions may not render",
  "dep.openSettings": "Click to open Obsidian settings",

  // US-720 (task #63): today execution view — entry-point tab that
  // answers "what should I do today?". Three groups + minimal actions.
  "today.groupOverdue": "Overdue",
  "today.groupToday": "Today",
  "today.groupRec": "Recommended from inbox",
  "today.groupEmpty": "Nothing in this group.",
  "today.empty": "Nothing to do today — enjoy the quiet.",
  "today.actionDone": "✓ Done",
  "today.actionReschedule": "↷ Tomorrow",
  "today.actionDrop": "🗑 Drop",
  "today.actionOpenSource": "📂 Source",

  // US-721 (task #64): today planning mode.
  "plan.entry": "Plan today",
  "plan.title": "Plan today",
  "plan.totalEst": "Total estimate {dur}",
  "plan.overload": "Over capacity by {dur}",
  "plan.empty": "No unscheduled candidates.",
  "plan.scheduleToday": "Today",
  "plan.scheduleTomorrow": "Tomorrow",
  "plan.scheduleWeek": "This week",

  // US-724 (task #67): saved views / custom filters.
  "savedViews.current": "Current filters",
  "savedViews.tag": "#tag",
  "savedViews.date": "YYYY-MM-DD",
  "savedViews.statusAll": "Any status",
  "savedViews.statusTodo": "Todo",
  "savedViews.statusDone": "Done",
  "savedViews.statusDropped": "Dropped",
  "savedViews.groupingAll": "Any group",
  "savedViews.save": "Save view",
  "savedViews.promptName": "Saved view name",
  "savedViews.defaultName": "Saved view",
};

const ZH: Partial<typeof EN> = {
  "tab.today": "今日",
  "tab.week": "本周",
  "tab.month": "本月",
  "tab.completed": "已完成",
  "tab.unscheduled": "未排期",

  "toolbar.today": "今天",
  "toolbar.weekNo": "第{n}周",
  "toolbar.add": "+ 新建",
  "toolbar.filter": "🔍 过滤…",

  "weekday.0": "日",
  "weekday.1": "一",
  "weekday.2": "二",
  "weekday.3": "三",
  "weekday.4": "四",
  "weekday.5": "五",
  "weekday.6": "六",

  "pool.unscheduled": "未排期",
  "pool.hint": "⬆ 拖到周/月视图 · 拖到此处移除 ⏳",
  "pool.other": "其他",

  "unscheduled.hint":
    "快捷键: D 选日期 · Space 完成 · 1-9 改分组 · Delete 放弃",
  "unscheduled.mobileHint":
    "长按卡片打开操作 · 左滑 = 完成 · 右滑 = 放弃",

  "trash.title": "垃圾站",
  "trash.hint": "拖到此处 → [-] ❌",
  "trash.dropped": "🗑 已放弃",

  "sheet.empty": "这一天没有任务。",

  "completed.weekOf": "{date} 那一周",
  "completed.tasks": "{n} 条任务",
  "completed.accuracy": "准确率 {ratio}  ({actual}m / {est}m)",
  "completed.empty": "还没有已完成的任务。",

  "loading": "加载任务中…",
  "onboarding.title": "还没有任务",
  "onboarding.body":
    "创建第一条任务：在此按 Cmd/Ctrl+T，或点击 + 新建，或在任意笔记里写：`- [ ] 第一个任务 #2象限 ⏳ 明天 [estimate:: 30m]`。",
  "onboarding.mobileBody":
    "创建第一条任务：点击下方 + 新建，或在任意笔记里写：`- [ ] 第一个任务 #2象限 ⏳ 明天 [estimate:: 30m]`。",
  "onboarding.cta": "+ 新建第一个任务",
  "completed.total": "总计 {actual}m",

  "footer.status": "{todo} 待办 · {done} 完成 · {overdue} 逾期",
  "footer.selected": "已选",
  "footer.hint":
    "1-9 分组 · ←/→ 改天 · D 选日期 · Space 完成 · E 跳源码 · Delete 放弃 · Ctrl+Z 撤销 · / 搜索",
  "footer.mobileHint":
    "长按弹菜单 · 左滑 = 完成 · 右滑 = 放弃 · 拖拽改期",

  "notice.scheduled": "→ ⏳ {date}",
  "notice.clearedSchedule": "已清除排期",
  "notice.error": "错误：{msg}",
  "notice.reloaded": "Task Center: 已刷新",
  "notice.fileNotFound": "文件不存在：{path}",
  "notice.invalidDate": "日期格式不对",
  "notice.nested": "已嵌入到「{title}」{where}",
  "notice.crossFile": "（跨文件）",

  "ctx.openSource": "跳转到源文件",
  "ctx.markDone": "标记完成",
  "ctx.markTodo": "取消完成",
  "ctx.scheduleToday": "排到今天",
  "ctx.scheduleTomorrow": "排到明天",
  "ctx.clearSchedule": "清除排期",
  "ctx.quadrant": "第{n}组",
  "ctx.groupingTag": "设为分组：{tag}",
  "ctx.drop": "放弃",

  "card.addSubtask": "+ 子任务",
  "card.subtaskPlaceholder": "子任务标题",

  "qa.title": "新建任务",
  "qa.placeholder":
    "去营业厅问携号转网 #3象限 ⏳ 周六 [estimate:: 25m]",
  "qa.hint":
    "快捷键：今天/明天/周六 → 自动识别为 ⏳ 日期 · #N象限 = 象限 · [estimate:: 30m]",

  "prompt.setScheduled": '设置 ⏳ 给 "{title}"  (YYYY-MM-DD、today、tomorrow，留空清除)',

  "cmd.open": "打开任务看板",
  "cmd.quickAdd": "快速新建任务",
  "cmd.reloadTasks": "重新加载任务",

  "ribbon.open": "打开任务看板",

  "settings.header": "Task Center",
  "settings.inbox.name": "默认收件箱路径",
  "settings.inbox.desc":
    "`task-center:add` 在没有指定 to= 且没有当日 daily note 时，把任务写到这里。",
  "settings.groupingTags.name": "分组标签",
  "settings.groupingTags.desc":
    "逗号分隔；用于未排期分组、快速新建 chip、1-9 快捷键和 CLI 分组列。",
  "settings.defaultView.name": "默认视图",
  "settings.defaultView.desc": "打开看板时默认展示哪个 tab。",
  "settings.defaultView.today": "今日",
  "settings.defaultView.week": "本周",
  "settings.defaultView.month": "本月",
  "settings.defaultView.completed": "已完成",
  "settings.defaultView.unscheduled": "未排期",
  "settings.weekStart.name": "一周从哪天开始",
  "settings.weekStart.desc": "周一 = ISO；周日 = 美式。",
  "settings.weekStart.mon": "周一",
  "settings.weekStart.sun": "周日",
  "settings.openOnStartup.name": "启动时打开看板",
  "settings.openOnStartup.desc": "Obsidian 启动时自动打开任务看板。",
  "settings.mobileHeader": "移动端",
  "settings.mobileLongPress.name": "长按时长 (ms)",
  "settings.mobileLongPress.desc":
    "按住卡片不动达到该时长才弹出操作面板。值越大越不容易误触；越小响应越快。",
  "settings.mobileSwipe.name": "滑动手势",
  "settings.mobileSwipe.desc":
    "左滑 = 完成，右滑 = 放弃。如果跟你的滚动习惯冲突可以关掉。",
  "settings.mobileForceLayout.name": "强制移动布局",
  "settings.mobileForceLayout.desc":
    "无论屏幕宽度都保持窄/移动布局。iPad 横屏、分屏、大屏可折叠设备的用户如果更想要列式布局, 打开这个.",
  "settings.cliHeader": "CLI",
  "settings.cliHelp":
    "所有命令都注册到 Obsidian 原生 CLI（需要 Obsidian ≥ 1.12.2）。在终端这样调用：",
  "settings.cliAiNote":
    "AI（Claude Code 等）可以直接调用这些命令 — 不需要 eval hack。",

  // US-412: error messages（中文）
  "err.task_not_found": "找不到任务：{ref}",
  "err.invalid_date": "日期无效：{ref}",
  "err.invalid_nest": "嵌套无效：{ref}",
  "err.ambiguous_slug": "前缀歧义：{ref}",

  // task #43: 状态栏 + 移动状态行（共用一组 key）
  "status.today": "📋 今日 {n}",
  "status.overdue": "⚠ 逾期 {n}",
  "status.openTooltip": "点击打开任务中心",

  // task #43: 卡片 est/act 标签
  "meta.est": "预估 {dur}",
  "meta.act": "实际 {dur}",

  // task #43: 移动端长按操作面板
  "sheet.markUndone": "↩ 取消完成",
  "sheet.done": "✓ 完成",
  "sheet.scheduleAt": "⏳ {date}",
  "sheet.scheduleClear": "⏳ —",
  "sheet.openSource": "📂 打开源文件",
  "sheet.drop": "🗑 放弃",

  // task #43: 日期弹窗提示
  "prompt.dateHint":
    "YYYY-MM-DD · 今天 · 明天 · 后天 · 周六 · 留空清除",

  // task #43: Completed 顶部 7 日统计
  "stats.sevenDayDone": "近 7 日 · 完成 {n} 条",
  "stats.ratio": "准确率 {ratio} ({sign}{delta}%)",

  // US-701: 依赖健康提示
  "dep.dailyNotesDisabled":
    "Daily Notes 插件未启用 — 任务将写入收件箱",
  "dep.dailyNotesNoFolder":
    "Daily Notes 未设置文件夹 — 任务将写入收件箱",
  "dep.tasksMissing":
    "Tasks 社区插件未安装 — Tasks 扩展字段可能展示不完整",
  "dep.tasksDisabled":
    "Tasks 社区插件未启用 — Tasks 扩展字段可能展示不完整",
  "dep.openSettings": "点击打开 Obsidian 设置",

  // US-720: 今日执行视图
  "today.groupOverdue": "逾期",
  "today.groupToday": "今天",
  "today.groupRec": "未排期推荐",
  "today.groupEmpty": "本组暂无内容。",
  "today.empty": "今天没有可执行任务。",
  "today.actionDone": "✓ 完成",
  "today.actionReschedule": "↷ 明天",
  "today.actionDrop": "🗑 放弃",
  "today.actionOpenSource": "📂 来源",

  // US-721: 今日计划模式
  "plan.entry": "计划今天",
  "plan.title": "今日计划",
  "plan.totalEst": "总预估 {dur}",
  "plan.overload": "超出容量 {dur}",
  "plan.empty": "没有未排期候选任务。",
  "plan.scheduleToday": "今天",
  "plan.scheduleTomorrow": "明天",
  "plan.scheduleWeek": "本周",

  // US-724: 保存视图 / 自定义过滤
  "savedViews.current": "当前过滤",
  "savedViews.tag": "#标签",
  "savedViews.date": "YYYY-MM-DD",
  "savedViews.statusAll": "任意状态",
  "savedViews.statusTodo": "待办",
  "savedViews.statusDone": "完成",
  "savedViews.statusDropped": "放弃",
  "savedViews.groupingAll": "任意分组",
  "savedViews.save": "保存视图",
  "savedViews.promptName": "保存视图名称",
  "savedViews.defaultName": "保存视图",
};

// US-408: re-detect locale on every `t()` call so that flipping the
// Obsidian UI language at runtime (Settings → About → Language, which
// updates `localStorage.language`) is reflected immediately. The
// localStorage read is ~100 ns — cheap enough that we don't bother
// caching. A view that wants its DOM to refresh after a language switch
// must additionally subscribe to `app.workspace.on("css-change")` and
// re-render; this function only guarantees the next call returns the
// current locale's translation.

export function t(key: keyof typeof EN, vars?: Record<string, string | number>): string {
  const locale = detectLocale();
  const raw = (locale === "zh" ? ZH[key] : undefined) ?? EN[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

export function getLocale(): Locale {
  return detectLocale();
}
