// Tiny i18n shim. Zero dependency.
//
// Uses Obsidian's getLanguage() API (available since v1.1.0) to detect
// the user's UI language. No separate plugin language toggle —
// Task Center follows whatever the user already configured in Obsidian.

import { getLanguage } from "obsidian";

type Locale = "zh" | "en";

// US-402: language auto-detection from Obsidian's UI language setting.
// US-408 calls this on every `t()` so live language switches take effect
// without restart.
// see USER_STORIES.md
function detectLocale(): Locale {
  const lang = getLanguage();
  if (lang.startsWith("zh")) return "zh";
  return "en";
}

const EN = {
  // View tabs
  "tab.today": "Today",
  "tab.week": "Week",
  "tab.month": "Month",
  "tab.completed": "Completed",
  "tab.unscheduled": "Unscheduled",
  "tab.todo": "TODO",
  "tab.dropped": "Dropped",

  // Toolbar
  "toolbar.today": "Today",
  "toolbar.weekNo": "W{n}",
  "toolbar.monthNo": "M{n}",
  "toolbar.add": "+ Add",
  "toolbar.settings": "Settings",
  "toolbar.filter": "Search tasks",
  "filters.empty": "No tasks match the current filters.",
  "filters.clear": "Clear filters",
  "filters.emptyVault": "No tasks in this vault yet.",
  "filters.emptyVaultHint": "Add your first task with + Add.",
  "filters.emptyFiltersTitle": "No results for these filters.",
  "filters.emptyFiltersHint": "Try clearing or relaxing your filter conditions.",

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
    "Use filters and query tabs to narrow this list.",
  "unscheduled.mobileHint":
    "Long-press a card for actions · swipe left = done · swipe right = abandon",

  // Abandon target
  "trash.title": "Abandon",
  "trash.hint": "Drop here to abandon",
  "trash.dropped": "Abandoned",
  "dnd.inheritedSchedule":
    "Schedule is inherited from parent; edit source or move out of parent first.",
  "dnd.droppedUndo": "dropped",

  // US-504: mobile month tab uses calendar-grid + dot density + tap-day
  // inline day panel listing the day's tasks. This empty-state string powers
  // the panel body when a day has no scheduled tasks.
  // see USER_STORIES.md
  "month.daySchedule": "{date} schedule",
  "calendar.overdueShort": "Overdue {n}",
  "calendar.nearDeadlineShort": "Due soon {n}",
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
    "Create your first task: click + Add, or add a checkbox line in any note: `- [ ] My task #tag ⏳ tomorrow [estimate:: 30m]`.",
  "onboarding.mobileBody":
    "Create your first task: tap + Add below, or write `- [ ] My task #tag ⏳ tomorrow [estimate:: 30m]` in any note.",
  "onboarding.cta": "+ Add your first task",
  "completed.total": "total {actual}m",

  // Footer
  "footer.status": "{todo} todo · {done} done · {overdue} overdue",
  "footer.selected": "selected",
  "footer.hint":
    "Ctrl+1-9 tabs · / search · Ctrl+Z undo",
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
  "notice.deleted": "Deleted tab \"{name}\" — no tasks were removed.",
  "notice.undoAction": "Undo",
  "notice.undoRestored": "Restored tab \"{name}\".",
  "notice.undone": "Marked undone",
  "notice.tagsUpdated": "Tags updated",

  // Context menu
  "ctx.markDone": "Mark done",
  "ctx.markTodo": "Mark todo",
  "ctx.scheduleToday": "Schedule today",
  "ctx.scheduleTomorrow": "Schedule tomorrow",
  "ctx.clearSchedule": "Clear schedule",
  "ctx.quadrant": "Group {n}",
  "ctx.groupingTag": "Set group: {tag}",
  "ctx.drop": "Drop",

  // Quick add modal
  "qa.title": "Add task",
  "qa.placeholder":
    "Buy groceries #tag ⏳ tomorrow [estimate:: 25m]",
  "qa.hint":
    "Dates resolve to ⏳ / 📅. Tags and inline fields stay exactly as typed.",
  "qa.noDailyTarget": "Enable and configure Daily Notes to add tasks",

  // Date prompt
  "prompt.setScheduled":
    'Set ⏳ for "{title}"  (YYYY-MM-DD, today, tomorrow, or blank to clear)',

  // Commands
  "cmd.open": "Open Task Center",
  "cmd.quickAdd": "Quick add task",
  "cmd.reloadTasks": "Reload tasks",

  // Ribbon
  "ribbon.open": "Open Task Center",

  // Settings
  "settings.header": "Task Center",
  // task #32 (0.3.0 breaking): `settings.dailyFolder.name/desc` removed
  // — the setting is gone, so the i18n keys for its label/description
  // are dead. Daily-note path now reads from Obsidian's built-in Daily
  // Notes core plugin config exclusively (see writer.ts).
  "settings.defaultView.name": "Default view",
  "settings.defaultView.desc": "Which tab to show when Task Center opens.",
  "settings.defaultView.today": "Today",
  "settings.defaultView.week": "Week",
  "settings.defaultView.month": "Month",
  "settings.defaultView.completed": "Completed",
  "settings.defaultView.unscheduled": "Unscheduled",
  "settings.defaultSavedView.name": "Default query tab",
  "settings.defaultSavedView.desc": "Optional saved query tab to open on cold start. If unset, Task Center falls back to the first visible tab.",
  "settings.defaultSavedView.none": "Follow the first visible tab",
  "settings.manageTabs.name": "Manage query tabs",
  "settings.manageTabs.desc": "Open the main Task Center tabs panel to create, rename, reorder, hide, restore, or delete query tabs.",
  "settings.manageTabs.action": "Open manager",
  "settings.restoreBuiltins.name": "Restore preset tabs",
  "settings.restoreBuiltins.desc": "Recreate and reset the built-in query tabs: Today, Week, Month, Completed, and Unscheduled.",
  "settings.restoreBuiltins.action": "Restore",
  "settings.weekStart.name": "Week starts on",
  "settings.weekStart.desc": "Monday = ISO; Sunday = US style.",
  "settings.weekStart.mon": "Monday",
  "settings.weekStart.sun": "Sunday",
  "settings.openOnStartup.name": "Open Task Center on startup",
  "settings.openOnStartup.desc":
    "Opens Task Center automatically when Obsidian starts.",
  "settings.stampCreated.name": "Stamp created date",
  "settings.stampCreated.desc":
    "Append ➕ today when adding new tasks. CLI can override per add.",
  "settings.taskFormatFlavor.name": "Task format flavor",
  "settings.taskFormatFlavor.desc":
    "Read supports Tasks emoji and Dataview inline fields. New task metadata writes use this flavor.",
  "settings.taskFormatFlavor.tasks": "Tasks emoji: ⏳ 📅 ➕ ✅",
  "settings.taskFormatFlavor.dataview": "Dataview inline fields: [scheduled::] [due::]",
  "settings.groupTabs": "Query tabs",
  "settings.groupGeneral": "General",
  "settings.groupWriting": "Task writing",
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
  "settings.skillInstall.name": "AI skill",
  "settings.skillInstall.desc": "Install the Task Center skill for agents:",
  "settings.copy": "Copy",
  "settings.copied": "Copied.",
  "settings.cliHeader": "CLI",
  "settings.cliHelp":
    "Verbs register to the native Obsidian CLI (requires Obsidian 1.12.2+). Call them from your shell:",
  "settings.cliAiNote":
    "AI (Claude Code etc.) should call these directly — no eval hacks needed.",

  // US-412: error messages — surfaced via formatError(code, message) in
  // src/cli.ts. The thrown TaskWriterError keeps the English `message`
  // as a developer-facing detail; the i18n template wraps it in the
  // user's current locale.
  "err.not_found": "task not found: {ref}",
  "err.invalid_date": "invalid date: {ref}",
  "err.invalid_query": "invalid query: {ref}",
  "err.query_not_found": "query not found: {ref}",
  "err.write_conflict": "write conflict: {ref}",
  "err.daily_notes_missing": "{ref}",
  "err.daily_notes_folder_missing": "{ref}",
  "err.invalid_nest": "invalid nest: {ref}",
  "err.ambiguous_slug": "ambiguous slug: {ref}",
  "err.nest_partial": "nest partial: {ref}",

  // task #43 (US-402): persistent status bar + mobile mirrored status row.
  // Same key set is reused by both surfaces so the two stay in lock-step.
  "status.today": "📋 {n} today",
  "status.overdue": "⚠ {n} overdue",
  "status.openTooltip": "Click to open Task Center",

  // task #43: est/act metadata badges on every card.
  "meta.est": "est {dur}",
  "meta.act": "act {dur}",

  // Mobile task sheet labels (view.ts:openMobileTaskDetailSheet — the single
  // grouped sheet that both tap and long-press now open). `sheet.scheduleAt`
  // formats a ⏳ button with an explicit ISO date; the date is opaque to the
  // translator (no language-specific reformatting) so EN and ZH share the
  // literal template.
  "sheet.markUndone": "↩ Mark undone",
  "sheet.done": "✓ Done",
  "sheet.scheduleAt": "⏳ {date}",
  "sheet.schedule": "Schedule",
  "sheet.reschedule": "Reschedule",
  "sheet.scheduleClear": "⏳ —",
  "sheet.tomorrow": "Tomorrow",
  "sheet.nextWeek": "Next week",
  "sheet.clearSchedule": "Clear schedule",
  "sheet.unscheduled": "Unscheduled",
  "sheet.drop": "Abandon",
  "sheet.scheduleCustom": "Pick a date…",
  "sheet.nest": "Set as subtask…",
  "sheet.parentPickerTitle": "Choose parent task",
  "sheet.parentPickerSubtitle": "Move “{title}” under a parent task.",
  "sheet.parentPickerSearch": "Search parent tasks",
  "sheet.parentPickerCurrentView": "Current view",
  "sheet.parentPickerSameFile": "Same file",
  "sheet.parentPickerSearchResults": "Search results",
  "sheet.parentPickerEmpty": "No parent tasks match.",
  "sheet.parentPickerInvalid": "Cannot choose this task or its descendants.",
  "sheet.parentPickerConfirm": "Set as subtask of “{title}”",
  "sheet.parentPickerNeedsSelection": "Choose a parent task",
  "sheet.parentPickerEffect": "This clears this task’s own ⏳ and lets it inherit the parent schedule.",
  "sheet.parentPickerChildren": "{n} subtasks",
  "sheet.editTag": "Edit tag",
  "sheet.editSource": "Edit source",
  "sheet.editTagHint": "Enter a tag (e.g. #project, #next)",
  "sheet.editTagCurrent": "Current tags",
  "sheet.editTagAdd": "Add tag",
  "sheet.editTagAddButton": "Add",
  "sheet.editTagSuggestions": "Suggestions",
  "sheet.editTagEmpty": "No tags yet",
  "sheet.editTagNoSuggestions": "No suggestions",
  "sheet.editTagRemove": "Remove {tag}",
  "sheet.cancel": "Cancel",
  "sheet.save": "Save",

  // task #43: date prompt hint line — bilingual EN baseline (the original
  // hard-coded string already mixed today/tomorrow with 明天/周六; we
  // preserve that mix here and route through tr() so a CN session gets
  // a CN-leaning version).
  "prompt.dateHint":
    "YYYY-MM-DD · today · tomorrow · 明天 · 周六 · (blank to clear)",

  // task #43 (PM PM HOLD msg cbf0489c): Completed tab 7-day stats
  // header — the third visible Completed surface (alongside the
  // accuracy/total + week-of labels that already routed through tr()).
  "stats.sevenDayDone": "7-day · {n} done",
  "stats.ratio": "ratio {ratio} ({sign}{delta}%)",

  // US-701: dependency-health banner. Surfaced as a status-bar item with
  // `data-dep-warning="..."` when the built-in Daily Notes plugin is
  // disabled or has no folder configured.
  "dep.dailyNotesDisabled":
    "Daily Notes plugin disabled — new tasks cannot be created",
  "dep.dailyNotesNoFolder":
    "Daily Notes folder not set — new tasks cannot be created",
  "dep.taskFormatCompanionMissing":
    "Install Tasks or Dataview — task metadata may not render or query elsewhere",
  "dep.taskFormatCompanionDisabled":
    "Enable Tasks or Dataview — task metadata may not render or query elsewhere",
  "dep.openSettings": "Click to open Obsidian settings",

  // US-720: builtin "Today" area titles — localized at render by area id
  // (今日 = col[ list×3 ]; each area's id maps to one of these via BUILTIN_TITLE_KEYS).
  "today.groupOverdue": "Overdue",
  "today.groupToday": "Today",
  "today.groupRec": "Unscheduled",

  // US-724 (task #67): saved views / custom filters.
  "savedViews.tag": "Tags",
  "savedViews.tagSearch": "Search tags",
  "savedViews.clearTags": "Clear",
  "savedViews.tagInsert": "Insert a tag…",
  "savedViews.tagEmpty": "No tags found. Add #hashtags to your tasks to filter by tag.",
  "savedViews.tagExprExample": "e.g. #a and #b · #a or #b · not #c · (#a or #b) and not #c",
  "savedViews.tagExprError": "Invalid expression — check tags, and/or/not, and parentheses.",
  "savedViews.emptyHint": "Set filters, then save a new query tab.",
  "savedViews.timeScheduled": "Schedule",
  "savedViews.timeDeadline": "Deadline",
  "savedViews.timeCompleted": "Completed",
  "savedViews.timeCreated": "Created",
  "savedViews.timeMore": "More time",
  "savedViews.timeMoreActive": "Time +{count}",
  "savedViews.timeBack": "Back",
  "savedViews.timeAll": "Any {field}",
  "savedViews.timePreset": "{field} range",
  "savedViews.clearTimeRange": "Clear {field}",
  "savedViews.customTimeRange": "Custom {field}",
  "savedViews.dateOverdue": "Overdue",
  "savedViews.dateNext7Days": "Next 7 days",
  "savedViews.dateToday": "Today",
  "savedViews.dateTomorrow": "Tomorrow",
  "savedViews.dateWeek": "This week",
  "savedViews.dateNextWeek": "Next week",
  "savedViews.dateMonth": "This month",
  "savedViews.statusAll": "Status",
  "savedViews.statusAny": "All",
  "savedViews.statusTodo": "Todo",
  "savedViews.statusDone": "Done",
  "savedViews.statusDropped": "Dropped",
  "savedViews.save": "Save as new tab",
  "savedViews.copy": "Duplicate tab",
  "savedViews.update": "Update",
  "savedViews.discard": "Discard changes",
  "savedViews.switchDirtyTitle": "Unsaved changes",
  "savedViews.switchDirtyBody": "You have unsaved changes in the current tab. What would you like to do?",
  "savedViews.switchDirtySave": "Save and switch",
  "savedViews.switchDirtyDiscard": "Switch without saving",
  "savedViews.switchDirtyCancel": "Cancel",
  "savedViews.editDsl": "Edit Query DSL",
  "savedViews.editQuery": "Edit view",
  "savedViews.editArea": "Edit area",
  "savedViews.open": "Open tab",
  "savedViews.create": "New tab",
  "savedViews.saveDisabled": "Set at least one filter before saving or updating.",
  "savedViews.promptName": "Query tab name",
  "savedViews.rename": "Rename tab",
  "savedViews.setDefault": "Set as default tab",
  "savedViews.hide": "Hide tab",
  "savedViews.show": "Show tab",
  "savedViews.delete": "Delete tab",
  "savedViews.manage": "Manage tabs",
  "savedViews.manageTitle": "Query Tabs",
  "savedViews.more": "More",
  "savedViews.moveLeft": "Move left",
  "savedViews.moveRight": "Move right",
  "savedViews.restore": "Restore preset",
  "savedViews.restoreDefaultTabs": "Restore preset tabs",
  "savedViews.presetBadge": "Preset",
  "savedViews.defaultBadge": "Default",
  "savedViews.currentBadge": "Current",
  "savedViews.dirtyBadge": "Unsaved",
  "savedViews.hiddenBadge": "Hidden",
  "savedViews.cancel": "Cancel",
  "savedViews.confirmSave": "Save",
  "savedViews.defaultName": "New query tab",
  "savedViews.custom": "Custom",
  "savedViews.customDate": "Custom date",
  "savedViews.datePreviousMonth": "Previous month",
  "savedViews.dateNextMonth": "Next month",
  "savedViews.rangeFrom": "From",
  "savedViews.rangeTo": "To",
  "savedViews.rangeOpenStart": "Start",
  "savedViews.rangeOpenEnd": "End",
  "savedViews.apply": "Apply",
  "savedViews.mobileEntry": "Filters",
  "savedViews.mobileTitle": "Query, view, and filters",
  "savedViews.queryEditorTitle": "Edit current query",
  "savedViews.editViewTitle": "Edit current view",
  "savedViews.editAreaTitle": "Edit current area",
  "savedViews.queryEditorHelp": "Edit the active query tab — filters, view, summary, and DSL are all editable here.",
  "savedViews.queryEditorFilters": "Filters",
  "savedViews.queryEditorAreaFilters": "Filters",
  "savedViews.queryEditorBaseFilters": "Base set (shared by all areas)",
  "savedViews.queryEditorBaseFiltersNote": "Search / status / scheduled / tags added here stack onto every area in this view.",
  "savedViews.viewName": "View name",
  "savedViews.queryEditorAreaTitle": "Title",
  "savedViews.queryEditorActions": "Save and manage",
  "savedViews.queryEditorActionsNote": "Save, save-as, DSL editing, and tab management here all work on the current tab's query draft.",
  "savedViews.dslTitle": "Edit query DSL",
  "savedViews.dslHelp": "Advanced mode. Edit the same query preset as JSON; save only writes after validation succeeds.",
  "savedViews.dslDocs": "DSL reference ↗",
  "savedViews.dslValid": "Validation passed",
  "savedViews.deleteConfirmTitle": "Delete tab",
  "savedViews.deleteConfirmBody": "Only removes this view — no tasks are deleted.",
  "savedViews.deleteConfirmAction": "Delete",
  "savedViews.tabMore": "More",
  "savedViews.toolbarSummary": "Filters: {summary}",
  "savedViews.emptyCondition": "No filter conditions set.",
  "savedViews.queryEditorView": "View",
  "savedViews.queryEditorViewType": "View type",
  "savedViews.viewList": "List",
  "savedViews.viewWeek": "Week",
  "savedViews.viewMonth": "Month",
  "savedViews.queryEditorDsl": "DSL",
  // US-109z2: area filter — searchable tag list + per-field date range.
  "savedViews.tagMore": "{n} more — type to filter",
  "savedViews.dateRangeTo": "to",
  "savedViews.searchContains": "Task text contains…",
  "savedViews.addTimeField": "Add date filter",
  "savedViews.dateOrRange": "or a date range",
  // US-109p10 / US-109p11: two-panel Query editor + visual layout tree.
  "savedViews.areaTabAppearance": "Appearance",
  "savedViews.layout": "Layout",
  "savedViews.layoutSummary": "{count} areas · {dir}",
  "savedViews.layoutAddArea": "Add area",
  "savedViews.layoutToggleDir": "Toggle direction",
  "savedViews.layoutWrapRow": "Wrap in row",
  "savedViews.layoutWrapCol": "Wrap in column",
  "savedViews.layoutDelete": "Delete area",
  "savedViews.layoutDuplicate": "Duplicate area",
  "savedViews.layoutMoveUp": "Move up",
  "savedViews.layoutMoveDown": "Move down",
  "savedViews.layoutRow": "Row",
  "savedViews.layoutCol": "Column",
  "savedViews.viewGrid": "Grid",
  "savedViews.areaTypeDrop": "Drop zone",
  "savedViews.baseSetHint": "Base set ({summary}) also applies here",
  "savedViews.baseSetHintEmpty": "The tab base set also applies here",
  "savedViews.goEditBaseSet": "Edit base set",
  "savedViews.backToTab": "Edit whole tab",

  // US-168: in-place source Markdown edit overlay.
  "sourceEdit.title": "Edit in Obsidian",
  "sourceEdit.openInNewTab": "Open (new tab)",
  "sourceEdit.save": "Save",
  "sourceEdit.close": "Close",
  "sourceEdit.saved": "Saved",
  "sourceEdit.unsaved": "Unsaved",
  "sourceEdit.nativeFailed": "Could not open Obsidian's native editor.",

  // Unknown area type — graceful degradation when a view config uses an
  // unsupported area `type` (typo, or a removed view type).
  "area.unknownType": "Unknown view type: {type}",
  "area.unknownHint": "This area type is not supported. Edit the Query DSL to fix it.",

  // US-109w: per-area filter + empty state
  "area.emptyArea": "No tasks match here.",
  "area.emptyTray": "No unscheduled tasks.",
  "area.clearAreaFilter": "Clear this area's filter",

  // US-415: full-view upgrade gate (legacy SavedTaskView / old-DSL view →
  // new QueryPreset model). Shown instead of the board when legacy data is
  // detected; the board renders only after the user confirms.
  "migration.badge": "Upgrade",
  "migration.title": "Task Center has been upgraded",
  "migration.lead":
    "This version refreshes how your views are set up. The {n} view(s) below upgrade automatically — just confirm to continue. Your tasks and notes are untouched.",
  "migration.scrollHint": "Scroll down to confirm and enter",
  "migration.whatsNewTitle": "What's new",
  "migration.feature1Title": "Mix and match layouts",
  "migration.feature1Desc":
    "Put lists, a week and a month side by side in one tab.",
  "migration.feature2Title": "Set it up once",
  "migration.feature2Desc":
    "What you set up in the app works the same from the command line — one place, no surprises.",
  "migration.feature3Title": "Built-in views are editable",
  "migration.feature3Desc":
    "Copy a built-in view like Today or Week and tweak it into your own.",
  "migration.feature5Title": "One edit button per section",
  "migration.feature5Desc":
    "Every list, week and month has the same edit button — open it to change what shows and how it looks. No more hunting for little icons.",
  "migration.feature4Title": "A fresh look",
  "migration.feature4Desc":
    "Cleaner board, tabs and edit panels.",
  "migration.feature6Title": "Done tasks don't jump away",
  "migration.feature6Desc":
    "Tick a task and it turns done right where it is instead of vanishing — it only clears when you reopen the view, so a mis-tap is easy to undo.",
  "migration.roadmapTitle": "On the roadmap",
  "migration.roadmapTag": "Planned",
  "migration.roadmap1Title": "Customizable stat cards",
  "migration.roadmap1Desc":
    "The old summary chips are gone for now. They'll come back as stat cards you can arrange freely — pick the numbers you want (count, sum, ratio, charts) instead of a fixed strip.",
  "migration.roadmap2Title": "More drag-to-edit",
  "migration.roadmap2Desc":
    "Grouping, sorting and limits will become drag-to-edit in the app too — no hand-written config.",
  "migration.viewsTitle": "Views migrating automatically ({n})",
  "migration.viewsBuiltin": "Built-in",
  "migration.viewsCustom": "Custom",
  "migration.untitledView": "Untitled view",
  "migration.note":
    "Both your built-in views (rename / hide / order) and your custom views migrate automatically and are kept. This only updates local settings — no task files are touched.",
  "migration.flavorTitle": "Pick your task format",
  "migration.flavorDesc":
    "Task Center reads both. New task metadata is written in the format you choose here.",
  "migration.flavorDataviewTitle": "Dataview inline fields",
  "migration.flavorTasksTitle": "Tasks emoji",
  "migration.aiTipTitle": "Manage tasks with AI? Update the skill",
  "migration.aiTipDesc":
    "This release changed the query DSL shape. If you read or write tasks through Task Center's AI skill / CLI, update the skill after upgrading — otherwise the agent will keep emitting the old DSL:",
  "migration.cta": "Upgrade and open the board",
};

const ZH: Partial<typeof EN> = {
  "tab.today": "今日",
  "tab.week": "本周",
  "tab.month": "本月",
  "tab.completed": "已完成",
  "tab.unscheduled": "未排期",
  "tab.todo": "TODO",
  "tab.dropped": "已放弃",

  "toolbar.today": "今天",
  "toolbar.weekNo": "第{n}周",
  "toolbar.monthNo": "{n}月",
  "toolbar.add": "+ 新建",
  "toolbar.settings": "设置",
  "toolbar.filter": "搜索任务",
  "filters.empty": "没有符合当前筛选的任务。",
  "filters.clear": "清空筛选",
  "filters.emptyVault": "这个 Vault 还没有任务。",
  "filters.emptyVaultHint": "用 + 添加来创建第一条任务。",
  "filters.emptyFiltersTitle": "当前筛选条件无结果。",
  "filters.emptyFiltersHint": "尝试清空或放宽筛选条件。",

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
    "用筛选和 query tab 缩小列表。",
  "unscheduled.mobileHint":
    "长按卡片打开操作 · 左滑 = 完成 · 右滑 = 放弃",

  "trash.title": "放弃区",
  "trash.hint": "拖到此处放弃",
  "trash.dropped": "已放弃",
  "dnd.inheritedSchedule":
    "排期继承自父任务，请编辑源 Markdown 或将任务移出父级。",
  "dnd.droppedUndo": "放弃",

  "month.daySchedule": "{date} 排期",
  "calendar.overdueShort": "逾 {n}",
  "calendar.nearDeadlineShort": "近 {n}",
  "sheet.empty": "这一天没有任务。",

  "completed.weekOf": "{date} 那一周",
  "completed.tasks": "{n} 条任务",
  "completed.accuracy": "准确率 {ratio}  ({actual}m / {est}m)",
  "completed.empty": "还没有已完成的任务。",

  "loading": "加载任务中…",
  "onboarding.title": "还没有任务",
  "onboarding.body":
    "创建第一条任务：点击 + 新建，或在任意笔记里写：`- [ ] 第一个任务 #tag ⏳ 明天 [estimate:: 30m]`。",
  "onboarding.mobileBody":
    "创建第一条任务：点击下方 + 新建，或在任意笔记里写：`- [ ] 第一个任务 #tag ⏳ 明天 [estimate:: 30m]`。",
  "onboarding.cta": "+ 新建第一个任务",
  "completed.total": "总计 {actual}m",

  "footer.status": "{todo} 待办 · {done} 完成 · {overdue} 逾期",
  "footer.selected": "已选",
  "footer.hint":
    "Ctrl+1-9 切 Tab · / 搜索 · Ctrl+Z 撤销",
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
  "notice.deleted": "已删除 Tab「{name}」——任务本身未被删除。",
  "notice.undoAction": "撤销",
  "notice.undoRestored": "已恢复 Tab「{name}」。",
  "notice.undone": "已取消完成",
  "notice.tagsUpdated": "已更新 tag",

  "ctx.markDone": "标记完成",
  "ctx.markTodo": "取消完成",
  "ctx.scheduleToday": "排到今天",
  "ctx.scheduleTomorrow": "排到明天",
  "ctx.clearSchedule": "清除排期",
  "ctx.quadrant": "第{n}组",
  "ctx.groupingTag": "设为分组：{tag}",
  "ctx.drop": "放弃",

  "qa.title": "新建任务",
  "qa.placeholder":
    "处理示例任务 #tag ⏳ 周六 [estimate:: 25m]",
  "qa.hint":
    "日期会识别为 ⏳ / 📅；tag 与 inline field 原样保留。",
  "qa.noDailyTarget": "请先启用并配置 Daily Notes 后再新建任务",

  "prompt.setScheduled": '设置 ⏳ 给 "{title}"  (YYYY-MM-DD、today、tomorrow，留空清除)',

  "cmd.open": "打开任务看板",
  "cmd.quickAdd": "快速新建任务",
  "cmd.reloadTasks": "重新加载任务",

  "ribbon.open": "打开任务看板",

  "settings.header": "Task Center",
  "settings.defaultView.name": "默认视图",
  "settings.defaultView.desc": "打开看板时默认展示哪个 tab。",
  "settings.defaultView.today": "今日",
  "settings.defaultView.week": "本周",
  "settings.defaultView.month": "本月",
  "settings.defaultView.completed": "已完成",
  "settings.defaultView.unscheduled": "未排期",
  "settings.defaultSavedView.name": "默认 Query Tab",
  "settings.defaultSavedView.desc": "可选：冷启动时优先打开这个已保存的 Query Tab；未设置时回退到当前第一个可见 Tab。",
  "settings.defaultSavedView.none": "跟随首个可见 Tab",
  "settings.manageTabs.name": "管理 Query Tabs",
  "settings.manageTabs.desc": "打开主界面的 Tabs 管理面板，在那里新建、重命名、排序、隐藏、恢复或删除 Query Tabs。",
  "settings.manageTabs.action": "打开管理器",
  "settings.restoreBuiltins.name": "恢复预设 Tabs",
  "settings.restoreBuiltins.desc": "重新补齐并重置内置 Query Tabs：今日、本周、本月、已完成、未排期。",
  "settings.restoreBuiltins.action": "恢复",
  "settings.weekStart.name": "一周从哪天开始",
  "settings.weekStart.desc": "周一 = ISO；周日 = 美式。",
  "settings.weekStart.mon": "周一",
  "settings.weekStart.sun": "周日",
  "settings.openOnStartup.name": "启动时打开看板",
  "settings.openOnStartup.desc": "Obsidian 启动时自动打开任务看板。",
  "settings.stampCreated.name": "自动打创建日期",
  "settings.stampCreated.desc":
    "新建任务时追加 ➕ 今天；CLI add 可单次覆盖。",
  "settings.taskFormatFlavor.name": "任务格式风味",
  "settings.taskFormatFlavor.desc":
    "读取同时兼容 Tasks emoji 与 Dataview inline fields；新的任务元数据写入使用这里选择的风味。",
  "settings.taskFormatFlavor.tasks": "Tasks emoji：⏳ 📅 ➕ ✅",
  "settings.taskFormatFlavor.dataview": "Dataview inline fields：[scheduled::] [due::]",
  "settings.groupTabs": "Query 标签页",
  "settings.groupGeneral": "通用",
  "settings.groupWriting": "任务写入",
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
  "settings.skillInstall.name": "AI skill",
  "settings.skillInstall.desc": "给 agent 安装 Task Center skill：",
  "settings.copy": "复制",
  "settings.copied": "已复制。",
  "settings.cliHeader": "CLI",
  "settings.cliHelp":
    "所有命令都注册到 Obsidian 原生 CLI（需要 Obsidian ≥ 1.12.2）。在终端这样调用：",
  "settings.cliAiNote":
    "AI（Claude Code 等）可以直接调用这些命令 — 不需要 eval hack。",

  // US-412: error messages（中文）
  "err.not_found": "找不到任务：{ref}",
  "err.invalid_date": "日期无效：{ref}",
  "err.invalid_query": "查询无效：{ref}",
  "err.query_not_found": "找不到查询：{ref}",
  "err.write_conflict": "写入冲突：{ref}",
  "err.daily_notes_missing": "{ref}",
  "err.daily_notes_folder_missing": "{ref}",
  "err.invalid_nest": "嵌套无效：{ref}",
  "err.ambiguous_slug": "前缀歧义：{ref}",
  "err.nest_partial": "部分嵌套成功：{ref}",

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
  "sheet.schedule": "排期",
  "sheet.reschedule": "改期",
  "sheet.scheduleClear": "⏳ —",
  "sheet.tomorrow": "明天",
  "sheet.nextWeek": "下周",
  "sheet.clearSchedule": "清除排期",
  "sheet.unscheduled": "未排期",
  "sheet.drop": "放弃",
  "sheet.scheduleCustom": "改期…",
  "sheet.nest": "设为子任务…",
  "sheet.parentPickerTitle": "选择父任务",
  "sheet.parentPickerSubtitle": "把「{title}」移动到父任务下。",
  "sheet.parentPickerSearch": "搜索父任务",
  "sheet.parentPickerCurrentView": "当前视图",
  "sheet.parentPickerSameFile": "同文件",
  "sheet.parentPickerSearchResults": "搜索结果",
  "sheet.parentPickerEmpty": "没有匹配的父任务。",
  "sheet.parentPickerInvalid": "不能选择当前任务或它的后代。",
  "sheet.parentPickerConfirm": "设为「{title}」的子任务",
  "sheet.parentPickerNeedsSelection": "先选择父任务",
  "sheet.parentPickerEffect": "会清空当前任务自己的 ⏳，并继承父任务排期。",
  "sheet.parentPickerChildren": "{n} 个子任务",
  "sheet.editTag": "编辑 tag",
  "sheet.editSource": "编辑原文",
  "sheet.editTagHint": "输入 tag（例如 #项目、#下一步）",
  "sheet.editTagCurrent": "当前 tag",
  "sheet.editTagAdd": "添加 tag",
  "sheet.editTagAddButton": "添加",
  "sheet.editTagSuggestions": "候选 tag",
  "sheet.editTagEmpty": "还没有 tag",
  "sheet.editTagNoSuggestions": "暂无候选",
  "sheet.editTagRemove": "移除 {tag}",
  "sheet.cancel": "取消",
  "sheet.save": "保存",

  // task #43: 日期弹窗提示
  "prompt.dateHint":
    "YYYY-MM-DD · 今天 · 明天 · 后天 · 周六 · 留空清除",

  // task #43: Completed 顶部 7 日统计
  "stats.sevenDayDone": "近 7 日 · 完成 {n} 条",
  "stats.ratio": "准确率 {ratio} ({sign}{delta}%)",

  // US-701: 依赖健康提示
  "dep.dailyNotesDisabled":
    "Daily Notes 插件未启用 — 无法新建任务",
  "dep.dailyNotesNoFolder":
    "Daily Notes 未设置文件夹 — 无法新建任务",
  "dep.taskFormatCompanionMissing":
    "请安装 Tasks 或 Dataview — 任务元数据在其他视图中可能无法展示或查询",
  "dep.taskFormatCompanionDisabled":
    "请启用 Tasks 或 Dataview — 任务元数据在其他视图中可能无法展示或查询",
  "dep.openSettings": "点击打开 Obsidian 设置",

  // US-720: 今日执行视图
  "today.groupOverdue": "逾期",
  "today.groupToday": "今天",
  "today.groupRec": "未排期",

  // US-724: 保存视图 / 自定义过滤
  "savedViews.tag": "标签",
  "savedViews.tagSearch": "搜索标签",
  "savedViews.clearTags": "清空",
  "savedViews.tagInsert": "插入标签…",
  "savedViews.tagEmpty": "未找到标签。在任务中添加 #hashtag 即可按标签筛选。",
  "savedViews.tagExprExample": "例：#a and #b · #a or #b · not #c · (#a or #b) and not #c",
  "savedViews.tagExprError": "表达式有误——检查标签、and / or / not 与括号。",
  "savedViews.emptyHint": "设置过滤条件后可保存为新的 query tab。",
  "savedViews.timeScheduled": "排期",
  "savedViews.timeDeadline": "截止",
  "savedViews.timeCompleted": "完成于",
  "savedViews.timeCreated": "创建于",
  "savedViews.timeMore": "更多时间",
  "savedViews.timeMoreActive": "时间 +{count}",
  "savedViews.timeBack": "返回",
  "savedViews.timeAll": "全部{field}",
  "savedViews.timePreset": "{field}范围",
  "savedViews.clearTimeRange": "清空{field}",
  "savedViews.customTimeRange": "自定义{field}",
  "savedViews.dateOverdue": "逾期",
  "savedViews.dateNext7Days": "未来 7 天",
  "savedViews.dateToday": "今天",
  "savedViews.dateTomorrow": "明天",
  "savedViews.dateWeek": "本周",
  "savedViews.dateNextWeek": "下周",
  "savedViews.dateMonth": "本月",
  "savedViews.statusAll": "状态",
  "savedViews.statusAny": "全部",
  "savedViews.statusTodo": "待办",
  "savedViews.statusDone": "完成",
  "savedViews.statusDropped": "放弃",
  "savedViews.save": "另存为新 tab",
  "savedViews.copy": "复制 Tab",
  "savedViews.update": "更新",
  "savedViews.discard": "放弃改动",
  "savedViews.switchDirtyTitle": "有未保存的改动",
  "savedViews.switchDirtyBody": "当前 Tab 有未保存的改动，切换后如何处理？",
  "savedViews.switchDirtySave": "保存并切换",
  "savedViews.switchDirtyDiscard": "不保存，直接切换",
  "savedViews.switchDirtyCancel": "取消",
  "savedViews.editDsl": "编辑 Query DSL",
  "savedViews.editQuery": "编辑视图",
  "savedViews.editArea": "编辑区域",
  "savedViews.open": "打开 Tab",
  "savedViews.create": "新建 Tab",
  "savedViews.saveDisabled": "先设置至少一个筛选条件再保存或更新。",
  "savedViews.promptName": "Query Tab 名称",
  "savedViews.rename": "重命名 Tab",
  "savedViews.setDefault": "设为默认 Tab",
  "savedViews.hide": "隐藏 Tab",
  "savedViews.show": "显示 Tab",
  "savedViews.delete": "删除 Tab",
  "savedViews.manage": "管理 Tabs",
  "savedViews.manageTitle": "Query Tabs",
  "savedViews.more": "更多",
  "savedViews.moveLeft": "左移",
  "savedViews.moveRight": "右移",
  "savedViews.restore": "恢复预设",
  "savedViews.restoreDefaultTabs": "恢复预设 Tabs",
  "savedViews.presetBadge": "预设",
  "savedViews.defaultBadge": "默认",
  "savedViews.currentBadge": "当前",
  "savedViews.dirtyBadge": "未保存",
  "savedViews.hiddenBadge": "已隐藏",
  "savedViews.cancel": "取消",
  "savedViews.confirmSave": "保存",
  "savedViews.defaultName": "新 Query Tab",
  "savedViews.custom": "自定义",
  "savedViews.customDate": "自定义日期",
  "savedViews.datePreviousMonth": "上个月",
  "savedViews.dateNextMonth": "下个月",
  "savedViews.rangeFrom": "开始",
  "savedViews.rangeTo": "结束",
  "savedViews.rangeOpenStart": "开始",
  "savedViews.rangeOpenEnd": "结束",
  "savedViews.apply": "应用",
  "savedViews.mobileEntry": "过滤 / 视图",
  "savedViews.mobileTitle": "Query、视图与过滤",
  "savedViews.queryEditorTitle": "编辑当前 Query",
  "savedViews.editViewTitle": "编辑当前视图",
  "savedViews.editAreaTitle": "编辑当前区域",
  "savedViews.queryEditorHelp": "编辑当前 Query Tab——筛选、视图、统计与 DSL 均可在同一面板完成。",
  "savedViews.queryEditorFilters": "过滤条件",
  "savedViews.queryEditorAreaFilters": "过滤条件",
  "savedViews.queryEditorBaseFilters": "基础集（所有区域共享）",
  "savedViews.queryEditorBaseFiltersNote": "在这里加的搜索 / 状态 / 排期 / 标签，会叠加到本视图的每一个区域上。",
  "savedViews.viewName": "视图名称",
  "savedViews.queryEditorAreaTitle": "标题",
  "savedViews.queryEditorActions": "保存与管理",
  "savedViews.queryEditorActionsNote": "这里的保存、另存为、DSL 与 Tabs 管理，作用的都是当前 Tab 的 query draft。",
  "savedViews.dslTitle": "编辑 Query DSL",
  "savedViews.dslHelp": "高级入口。直接以 JSON 编辑同一份 query preset；只有校验通过才会写入。",
  "savedViews.dslDocs": "DSL 文档 ↗",
  "savedViews.dslValid": "校验通过",
  "savedViews.deleteConfirmTitle": "删除 Tab",
  "savedViews.deleteConfirmBody": "只删除这个视图，不删除任何任务。",
  "savedViews.deleteConfirmAction": "删除",
  "savedViews.tabMore": "更多",
  "savedViews.toolbarSummary": "当前筛选：{summary}",
  "savedViews.emptyCondition": "无筛选条件。",
  "savedViews.queryEditorView": "视图",
  "savedViews.queryEditorViewType": "视图类型",
  "savedViews.viewList": "列表",
  "savedViews.viewWeek": "周",
  "savedViews.viewMonth": "月",
  "savedViews.queryEditorDsl": "DSL",
  "savedViews.tagMore": "还有 {n} 个，输入以筛选",
  "savedViews.dateRangeTo": "至",
  "savedViews.searchContains": "任务文本包含…",
  "savedViews.addTimeField": "添加日期筛选",
  "savedViews.dateOrRange": "或自定义范围",
  "savedViews.areaTabAppearance": "外观",
  "savedViews.layout": "布局",
  "savedViews.layoutSummary": "{count} 个区域 · {dir}",
  "savedViews.layoutAddArea": "添加区域",
  "savedViews.layoutToggleDir": "切换排列",
  "savedViews.layoutWrapRow": "嵌套成行",
  "savedViews.layoutWrapCol": "嵌套成列",
  "savedViews.layoutDelete": "删除区域",
  "savedViews.layoutDuplicate": "复制区域",
  "savedViews.layoutMoveUp": "上移",
  "savedViews.layoutMoveDown": "下移",
  "savedViews.layoutRow": "横排",
  "savedViews.layoutCol": "竖排",
  "savedViews.viewGrid": "网格",
  "savedViews.areaTypeDrop": "放弃区",
  "savedViews.baseSetHint": "基础集（{summary}）也叠加在本区",
  "savedViews.baseSetHintEmpty": "本 Tab 的基础集也叠加在本区",
  "savedViews.goEditBaseSet": "去改基础集",
  "savedViews.backToTab": "编辑整个 Tab",

  "sourceEdit.title": "在 Obsidian 中编辑",
  "sourceEdit.openInNewTab": "打开（新标签页）",
  "sourceEdit.save": "保存",
  "sourceEdit.close": "关闭",
  "sourceEdit.saved": "已保存",
  "sourceEdit.unsaved": "未保存",
  "sourceEdit.nativeFailed": "无法打开 Obsidian 原生编辑器。",

  "area.unknownType": "未知视图类型：{type}",
  "area.unknownHint": "这个 area 类型不被支持。请编辑 Query DSL 修正。",

  "area.emptyArea": "本区无匹配任务。",
  "area.emptyTray": "没有未排期任务。",
  "area.clearAreaFilter": "清空本区筛选",

  // US-415: 全屏升级闸门页
  "migration.badge": "升级",
  "migration.title": "Task Center 已升级",
  "migration.lead":
    "这一版换了视图的配置方式。下面 {n} 个视图会自动升级，确认即可继续；你的任务和笔记不受影响。",
  "migration.scrollHint": "向下滑动，到底部确认升级",
  "migration.whatsNewTitle": "新版变化",
  "migration.feature1Title": "布局自由拼",
  "migration.feature1Desc":
    "列表、周历、月历能拼在同一个标签页里。",
  "migration.feature2Title": "配置只设一次",
  "migration.feature2Desc":
    "在界面里配好的，在命令行里也照样用——一处设置，结果一致。",
  "migration.feature3Title": "内置视图可改",
  "migration.feature3Desc":
    "Today、本周这些内置视图都能复制一份，改成你自己的样子。",
  "migration.feature5Title": "每块内容一个编辑入口",
  "migration.feature5Desc":
    "每个列表、周历、月历都带同一个编辑按钮，点开就能改“显示什么”和“长什么样”，不用再到处找小按钮。",
  "migration.feature4Title": "界面焕新",
  "migration.feature4Desc":
    "看板、标签页和编辑面板都更清爽。",
  "migration.feature6Title": "完成不急着消失",
  "migration.feature6Desc":
    "勾完一条任务，它会原地变成完成态而不是立刻消失；重新打开这个视图时才隐去——点错了随手就能撤。",
  "migration.roadmapTitle": "接下来",
  "migration.roadmapTag": "计划中",
  "migration.roadmap1Title": "可自定义的统计卡",
  "migration.roadmap1Desc":
    "原来的统计小标签先下线，以后会以可自由摆放的统计卡回归——自己选要看的数字（计数 / 合计 / 比率 / 图表），像拼看板一样排，而不是固定一条。",
  "migration.roadmap2Title": "更多拖拽编辑",
  "migration.roadmap2Desc":
    "分组、排序、数量上限这些也会陆续做成界面里直接拖着改，不用手写配置。",
  "migration.viewsTitle": "将自动迁移的视图（{n}）",
  "migration.viewsBuiltin": "内置",
  "migration.viewsCustom": "自定义",
  "migration.untitledView": "未命名视图",
  "migration.note":
    "你的内置视图（重命名 / 隐藏 / 排序）和自定义视图都会自动迁移并保留。本次只更新本地配置，不会改动任何任务文件。",
  "migration.flavorTitle": "选择任务格式",
  "migration.flavorDesc":
    "读取时两种格式都兼容。新写入的任务元数据使用你在这里选择的格式。",
  "migration.flavorDataviewTitle": "Dataview inline fields",
  "migration.flavorTasksTitle": "Tasks emoji",
  "migration.aiTipTitle": "用 AI 管理任务？记得更新 skill",
  "migration.aiTipDesc":
    "这次升级改了查询 DSL 的结构。如果你通过 Task Center 的 AI skill / CLI 读写任务，升级后请运行下面的命令更新 skill，否则 AI 还会按旧结构生成 DSL：",
  "migration.cta": "升级并进入看板",
};

// US-408: re-detect locale on every `t()` call so that flipping the
// Obsidian UI language at runtime (Settings → About → Language) is reflected
// immediately. A view that wants its DOM to refresh after a language switch
// must additionally subscribe to `app.workspace.on("css-change")` and
// re-render; this function only guarantees the next call returns the current
// locale's translation.

export function t(key: keyof typeof EN, vars?: Record<string, string | number>): string {
  const locale = detectLocale();
  const raw = (locale === "zh" ? ZH[key] : undefined) ?? EN[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_match: string, k: string) => String(vars[k] ?? `{${k}}`));
}

export function getLocale(): Locale {
  return detectLocale();
}
