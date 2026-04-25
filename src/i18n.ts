// Tiny i18n shim. Zero dependency.
//
// Obsidian stores the UI language in localStorage under the key "language".
// It's set when the user picks a language in Settings → About → Language.
// Fallback priority: stored value → navigator.language → "en".

type Locale = "zh" | "en";

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
    "Shortcuts: D date · Space done · 1-4 quadrant · Delete drop",
  "unscheduled.mobileHint":
    "Long-press a card for actions · swipe left = done · swipe right = drop",

  // Trash
  "trash.title": "Trash",
  "trash.hint": "Drop here → [-] ❌",
  "trash.dropped": "🗑 dropped",

  // Mobile bottom sheet (US-504)
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
    "1-4 quadrant · ←/→ day · D date · Space done · E edit · Delete drop · Ctrl+Z undo · / search",
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
  "ctx.quadrant": "Quadrant {n}",
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
  "settings.dailyFolder.name": "Daily folder",
  "settings.dailyFolder.desc":
    "Folder where daily notes live — default add target and sub-task move targets.",
  "settings.defaultView.name": "Default view",
  "settings.defaultView.desc": "Which tab to show when the board opens.",
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
};

const ZH: Partial<typeof EN> = {
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
    "快捷键: D 选日期 · Space 完成 · 1-4 改象限 · Delete 放弃",
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
    "1-4 象限 · ←/→ 改天 · D 选日期 · Space 完成 · E 跳源码 · Delete 放弃 · Ctrl+Z 撤销 · / 搜索",
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
  "ctx.quadrant": "第{n}象限",
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
  "settings.dailyFolder.name": "Daily 文件夹",
  "settings.dailyFolder.desc":
    "每日笔记所在文件夹 — 默认 add 目标、子任务搬家目标。",
  "settings.defaultView.name": "默认视图",
  "settings.defaultView.desc": "打开看板时默认展示哪个 tab。",
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
};

const locale: Locale = detectLocale();

export function t(key: keyof typeof EN, vars?: Record<string, string | number>): string {
  const raw = (locale === "zh" ? ZH[key] : undefined) ?? EN[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

export function getLocale(): Locale {
  return locale;
}
