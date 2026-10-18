# Obsidian Task Center

[简体中文](https://github.com/CorrectRoadH/obsidian-task-center/blob/main/README.zh-CN.md) / [English](https://github.com/CorrectRoadH/obsidian-task-center/blob/main/README.md)

Task Center collects the `- [ ]` tasks scattered across your Obsidian vault into one board, so you can plan them by day, week, and month and look back on what got done.

Your tasks stay as plain markdown in the notes where you wrote them. There is no database and no new task format. Uninstall the plugin and your notes are unchanged.

```markdown
- [ ] Plan the launch #work ⏳ 2026-05-15 📅 2026-05-20 [estimate:: 90m]
    - [ ] Draft release notes [estimate:: 30m]
- [x] Ship the fix ✅ 2026-04-28 [actual:: 45m]
```

![Week drag demo](screenshots/week-drag.gif)

![Month drag demo](screenshots/month-drag.gif)

## Install

<a href="https://obsidian.md/plugins?id=task-center"><img src="assets/install-button.svg" alt="Install in Obsidian" height="52"></a>

Or search for "Task Center" in **Settings → Community plugins → Browse**.

Two more things to set up:

1. Install and enable either [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) or [Dataview](https://github.com/blacksmithgu/obsidian-dataview). Task Center uses their task syntax.
2. Turn on Obsidian's built-in **Daily notes** core plugin and set its "New file location". Quick Add writes new tasks into today's daily note.

## What you get

- A full-page board with Today, Week, Month, TODO, Unscheduled, Completed, and Dropped tabs.
- Drag a card to a day to schedule it, onto another card to make it a subtask, or into the drop zone to abandon it.
- Parent and child tasks share one card. A child without its own date follows its parent.
- Build your own tabs: split a tab into areas, each with its own filters. An Eisenhower matrix, or work and personal side by side.
- Quick Add: type one line, with dates like "tomorrow" or "周六" understood in English and Chinese.
- Track estimated vs. actual time and see how accurate your estimates are.
- On mobile: long-press for a menu, swipe left to complete, swipe right to drop.
- Obsidian CLI commands so AI agents like Claude Code can read and update the same tasks.

## Quick start

1. Keep writing tasks in any note:

   ```markdown
   - [ ] Review PR #work ⏳ 2026-05-15 [estimate:: 30m]
   - [ ] Renew passport 📅 2026-05-30
   ```

2. Open the board from the ribbon icon, or run "Task Center: Open Task Center" from the command palette.
3. Click `+` on the board, or run "Task Center: Quick add task":

   ```text
   Review beta feedback #work tomorrow [estimate:: 25m]
   处理发布清单 #work 周六
   ```

   Words like "today", "tomorrow", "Saturday", and "周六" become real dates (`2026-05-16`) before anything is written.

To open the board with a shortcut, search for "Task Center" in **Settings → Hotkeys** and bind your own.

## Task syntax

Both common syntaxes are read:

```markdown
- [ ] Tasks emoji style ⏳ 2026-05-15 📅 2026-05-20 ➕ 2026-05-01
- [ ] Dataview style [scheduled:: 2026-05-15] [due:: 2026-05-20] [created:: 2026-05-01]
```

| Meaning | Tasks emoji | Dataview |
| --- | --- | --- |
| Scheduled (the day you plan to do it) | `⏳` | `[scheduled::]` |
| Due | `📅` | `[due::]` |
| Created | `➕` | `[created::]` |
| Completed | `✅` | `[completion::]` |
| Dropped | `❌` | `[cancelled::]` |

Pick which syntax the plugin writes in **Settings → Task Center → Task format flavor**. Dragging, date pickers, Quick Add, and the CLI all follow it. If a line has the same field in both syntaxes, the emoji one wins.

Estimates and actual time are regular inline fields:

```markdown
[estimate:: 90m] [estimate:: 1h30m] [actual:: 75m]
```

Fields and tags the plugin doesn't know are left exactly as they are.

## CLI for AI agents

Task Center registers commands with Obsidian's built-in CLI (desktop only, CLI must be enabled in Obsidian):

```bash
obsidian task-center                                   # list all commands
obsidian task-center:list scheduled=today
obsidian task-center:show ref=Tasks/Inbox.md:L42
obsidian task-center:add text="Review launch checklist" tag='#work' scheduled=2026-05-15
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-05-16
obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-28
obsidian task-center:review days=7 format=json
```

Built so agents can rely on it:

- Every task has a fixed id, `path:L<line>`. If the line moves, the task is found again by its title.
- Running the same command twice gives the same result. Running `done` on a completed task returns `unchanged` instead of writing again.
- Every change prints a before line and an after line so you can check it.

Install the companion AI skill so your agent knows how to use these commands:

```bash
npx skills add CorrectRoadH/obsidian-task-center
```

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Default query tab | First visible tab | Which tab shows when the board opens |
| Week starts on | Monday | Column order and what counts as "this week" |
| Open Task Center on startup | Off | Open the board when Obsidian starts |
| Stamp created date | On | Add a created date to new tasks |
| Task format flavor | Tasks emoji | Write emoji fields or Dataview fields |
| Force mobile layout | Off | Use the phone layout on tablets and large screens |

## License

MIT
