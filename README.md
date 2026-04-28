# Obsidian Task Center

[简体中文](./README.zh-CN.md)

Task Center is an Obsidian plugin that adds a daily/weekly/monthly task board, parent-child task rendering, natural-language Quick Add, mobile gestures, and an AI-friendly CLI on top of plain Obsidian Tasks markdown.

It does not create a new database or task format. Your source of truth stays in markdown:

```markdown
- [ ] Plan the launch #work ⏳ 2026-05-15 📅 2026-05-20 [estimate:: 90m]
    - [ ] Draft release notes [estimate:: 30m]
- [x] Ship the fix ✅ 2026-04-28 [actual:: 45m]
- [-] Retired idea ❌ 2026-04-28
```

## Why Task Center

Obsidian Tasks already owns the task syntax and query model. Task Center keeps that foundation and adds the working surfaces that are awkward to build in a note:

| Need | Task Center adds |
| --- | --- |
| Plan the week | A full-tab board with Today, Week, Month, Completed, and Unscheduled views |
| Move work around | Drag tasks between dates, nest under another task, or abandon without deleting markdown |
| Handle task trees | Recursive parent-child cards with inherited schedule/status semantics |
| Capture quickly | Spotlight-style Quick Add with English and Chinese date parsing |
| Review estimates | Estimate vs actual summaries via inline fields such as `[estimate::]` and `[actual::]` |
| Use mobile | Phone layout, long-press menus, swipe actions, and keyboard-safe Quick Add |
| Let an AI agent help | Stable `obsidian task-center:*` CLI verbs with greppable output |

## Install

Task Center is not yet listed in Obsidian's Community Plugins browser. Until it is, BRAT is the recommended installation path because it installs from GitHub Releases and can check for updates without manual file copying.

### Prerequisites

1. Install and enable [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks). Task Center reads and writes Tasks-compatible markdown and expects the Tasks plugin to remain the data-layer companion.
2. Enable Obsidian's built-in **Daily Notes** core plugin and set its "New file location". Quick Add writes new tasks to today's Daily Note and refuses to fall back to an inbox when Daily Notes is missing or misconfigured.

### Option 1: Install with BRAT (recommended)

1. In Obsidian, open **Settings -> Community plugins**.
2. Turn off Restricted Mode if Obsidian asks you to.
3. Click **Browse**, search for **BRAT**, install **Obsidian42 - BRAT**, and enable it.
4. Open **Settings -> BRAT**.
5. Choose **Add Beta Plugin**.
6. Paste this repository URL:

   ```text
   https://github.com/CorrectRoadH/obsidian-task-center
   ```

7. Let BRAT install the latest release.
8. Return to **Settings -> Community plugins** and enable **Task Center**.

### Option 2: Manual install

1. Open the [latest GitHub Release](https://github.com/CorrectRoadH/obsidian-task-center/releases/latest).
2. Download the three release assets:
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. Create this folder inside your vault:

   ```text
   <your-vault>/.obsidian/plugins/task-center/
   ```

4. Put the three files directly inside that folder. They must not be inside a nested zip or extracted subfolder.
5. Restart Obsidian.
6. Open **Settings -> Community plugins** and enable **Task Center**.

### Mobile install

Task Center is mobile-capable (`isDesktopOnly: false`). Before the plugin is listed in the official Community Plugins browser, the most reliable mobile setup is:

1. Install Task Center on desktop with BRAT or the manual three-file method.
2. Sync `.obsidian/plugins/task-center/` to mobile with Obsidian Sync, or copy the same folder to the mobile vault.
3. On Obsidian Mobile, open **Settings -> Community plugins** and enable **Task Center**.

If Task Center does not appear on mobile, confirm that `manifest.json`, `main.js`, and `styles.css` are directly inside `.obsidian/plugins/task-center/`, Restricted Mode is off, and the phone is opening the same vault copy.

## Quick Start

1. Write or keep using normal Tasks-style checkboxes in any markdown file.
2. Add schedule, deadline, estimate, and actual-time metadata only when useful:

   ```markdown
   - [ ] Review PR #work ⏳ today [estimate:: 30m]
   - [ ] Renew passport 📅 2026-05-30
   ```

3. Open Task Center from the ribbon icon, command palette, `Ctrl/Cmd+Shift+T`, or:

   ```bash
   obsidian command id=task-center:open
   ```

4. Use **Quick Add** with `Ctrl/Cmd+T` inside the board:

   ```text
   Review beta feedback #work tomorrow [estimate:: 25m]
   处理发布清单 #3象限 周六 [estimate:: 45m]
   ```

Natural-language dates such as `today`, `tomorrow`, `Mon`, `今天`, `明天`, and `周六` are resolved to ISO dates before writing markdown.

## Views

- **Today**: overdue, scheduled-today, and unscheduled-recommendation groups with quick actions.
- **Week**: seven columns, today highlighted, with per-day task counts and estimate totals.
- **Month**: calendar grid with date drop zones.
- **Completed**: review timeline grouped by week with estimate-vs-actual summaries.
- **Unscheduled**: task pool sorted by deadline and creation order.

Drag a card to a date to change `⏳`. Drop it onto another card to nest it. Drop it on the abandon target to mark it `[-] ❌` instead of deleting the source line.

## Syntax

Task Center preserves Obsidian Tasks metadata and unknown inline fields byte-for-byte when editing, moving, or nesting tasks.

| Meaning | Markdown |
| --- | --- |
| Scheduled for | `⏳ YYYY-MM-DD` |
| Deadline | `📅 YYYY-MM-DD` |
| Start date | `🛫 YYYY-MM-DD` |
| Created | `➕ YYYY-MM-DD` |
| Completed | `[x]` plus `✅ YYYY-MM-DD` |
| Abandoned | `[-]` plus `❌ YYYY-MM-DD` |
| Estimate | `[estimate:: 90m]`, `[estimate:: 1h30m]` |
| Actual time | `[actual:: 75m]` |
| Tags | `#work`, `#1象限`, `#next` |

Tags and inline-field names are user data. Task Center does not translate, normalize, or hard-code them.

## CLI

Task Center registers verbs with Obsidian's native CLI. There is no separate wrapper script.

```bash
obsidian task-center:list scheduled=today
obsidian task-center:list scheduled=unscheduled tag='#work'
obsidian task-center:show ref=Tasks/Inbox.md:L42
obsidian task-center:add text="Review launch checklist" tag='#work' scheduled=2026-05-15
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-05-16
obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-28
obsidian task-center:abandon ref=Tasks/Inbox.md:L42
obsidian task-center:nest ref=Tasks/Inbox.md:L42 under=Projects/Launch.md:L10
obsidian task-center:actual ref=Tasks/Inbox.md:L42 minutes=+30m
obsidian task-center:review days=7
obsidian task-center:review days=7 format=json
```

CLI output is designed for both humans and agents:

- List rows start with a stable id such as `path:L42`.
- Write commands are idempotent.
- Mutations print `before` and `after` lines.
- Hash collisions return `ambiguous_slug` with candidates instead of guessing.

To install the companion AI skill:

```bash
npx skills add CorrectRoadH/obsidian-task-center
```

## Settings

| Setting | Default | What it controls |
| --- | --- | --- |
| Default view | Week | Which tab opens first |
| Week starts on | Monday | Week and calendar boundaries |
| Open Task Center on startup | Off | Whether the board opens with the vault |
| Stamp created date | On | Whether new tasks get `➕ YYYY-MM-DD` |
| Force mobile layout | Off | Use the phone layout on wider screens |

## Migration

### 0.3.0: Daily Notes owns Quick Add targets

Task Center removed the old `settings.dailyFolder` setting. Quick Add now reads Obsidian's built-in **Daily Notes** core plugin configuration for the target folder and date format.

To migrate, enable **Daily Notes** in **Settings -> Core plugins** and set "New file location" to the folder you want Task Center to write into. If you used the old default, set Daily Notes to `Daily/` for the same behavior.

## License

MIT.
