# Obsidian Task Center

Energy-aware task board + CLI on top of the [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) syntax. One plugin, two entry points:

- **GUI** — a full-tab kanban view with week/month/completed/unscheduled tabs, drag-to-schedule, trash bin, keyboard shortcuts
- **CLI** — verbs registered to Obsidian's native CLI (1.12.2+) so you (and an AI like Claude Code) can read/write tasks from the shell

Data is plain markdown. No custom file format, no lock-in — Obsidian Tasks plugin, Dataview, and anything else that reads `- [ ] task 📅 2026-04-25 ⏳ 2026-04-24 [estimate:: 30m]` keeps working.

## Why not just Obsidian Tasks?

Obsidian Tasks is the authoritative data-layer — keep it installed. Task Center adds on top:

| Feature | Obsidian Tasks | Task Center |
|---|---|---|
| Inline `- [ ]` syntax | ✅ authoritative | ✅ sources |
| `✅ / ❌ / ➕` date stamps | ✅ | ✅ reads + writes |
| Query blocks | ✅ | — |
| Kanban tab with drag-to-date | — | ✅ |
| Week / month calendar views | — | ✅ |
| Native CLI verbs | — | ✅ |
| `[estimate::]` / `[actual::]` tracking | — | ✅ |
| Drop cascade to subtasks | — | ✅ |
| Click-to-rename cards | — | ✅ |

## Syntax

```markdown
- [ ] Task title #2象限 📅 2026-05-15 ⏳ 2026-04-24 [estimate:: 90m]
    - [ ] Subtask ⏳ 2026-04-24 [estimate:: 30m]
- [x] Done one ✅ 2026-04-23 [estimate:: 60m] [actual:: 75m]
- [-] Abandoned ❌ 2026-04-23
```

| Field | Encoding |
|---|---|
| Scheduled (which day to do it) | `⏳ YYYY-MM-DD` |
| Deadline | `📅 YYYY-MM-DD` |
| Start date | `🛫 YYYY-MM-DD` |
| Completed | `[x]` + `✅ YYYY-MM-DD` |
| Cancelled / dropped | `[-]` + `❌ YYYY-MM-DD` |
| Created | `➕ YYYY-MM-DD` |
| Estimate | `[estimate:: 90m]` or `1h30m` |
| Actual time spent | `[actual:: 92m]` |
| Quadrant (Covey 4Q) | `#1象限` / `#2象限` / `#3象限` / `#4象限` |
| Custom tags | `#foo`, `#bar` |

## GUI

Open the board — ribbon icon, `⌘/Ctrl+Shift+T`, command palette "Open Task Board", or `obsidian command id=obsidian-task-center:open`. Four tabs at the top (`⌃1–4`), each shows an active-todo badge:

- **本周 / Week** — 7 columns Mon–Sun, today highlighted. Drag cards between columns to change `⏳`.
- **本月 / Month** — calendar grid. Each cell is a drop zone.
- **已完成 / Completed** — timeline grouped by week, with per-week accuracy `sum(actual)/sum(estimate)`.
- **未排期 / Unscheduled** — grouped by quadrant, masonry layout.

Below the week/month view, a masonry pool of unscheduled tasks + a sticky trash bin. Drag cards into the trash to mark `[-] ❌ today`; dropping a parent cascades to its subtasks (already-done subtasks are left alone).

The **Completed** tab has a 7-day stats header (accuracy ratio + top 4 tag minutes) and collapsible per-week groups — past weeks default collapsed.

**Ancestor propagation**: when a task or section-header bullet is `[x]` / `[-]` / `#dropped`, all descendant tasks are automatically hidden from todo/unscheduled/week/month views. Abandoning a project, or completing a parent, silently retires its children without you having to tick each one.

**Status bar** shows `📋 N today · ⚠ M overdue` in the bottom bar; click to open the board.

### Card keyboard shortcuts

Select a card (click), then:

| Key | Action |
|---|---|
| `1` / `2` / `3` / `4` | Set quadrant |
| `←` / `→` | Move one day earlier / later |
| `D` | Set/clear scheduled date via prompt |
| `Space` | Toggle done |
| `E` / `Enter` | Open source file at the task's line |
| `Delete` / `Backspace` | Drop |
| `⌘/Ctrl+Z` | Undo the last drag/date mutation made in this view (stack depth 20) |
| `/` | Focus the filter input |

Click the title text to rename in place (Enter commits, Escape reverts). All metadata (tags, emojis, inline fields) is preserved.

### Quick add

`⌘/Ctrl+T` in the board, or the `+ Add` button, opens a one-line input:

```
去营业厅问携号转网 #3象限 ⏳ 周六 [estimate:: 25m]
```

Natural language dates (`今天/today/tomorrow/明天/周六/Mon`) resolve to real ISO dates. No date = goes to "unscheduled".

## CLI

Every verb registers to Obsidian's native CLI via `registerCliHandler` (no shell wrapper, no `eval` hacks). Requires Obsidian 1.12.2+.

```
obsidian task-center:list scheduled=today
obsidian task-center:list scheduled=unscheduled tag='#2象限'
obsidian task-center:show ref=Tasks/Inbox.md:L42
obsidian task-center:stats days=7 group=象限

obsidian task-center:add text="去营业厅问携号转网" tag='#3象限' scheduled=2026-04-26
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-04-25
obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-23
obsidian task-center:abandon ref=Tasks/Inbox.md:L42   # alias: task-center:drop
obsidian task-center:nest ref=Tasks/Inbox.md:L42 under=Tasks/Inbox.md:L10
obsidian task-center:actual ref=Tasks/Inbox.md:L42 minutes=+30m
obsidian task-center:estimate ref=Tasks/Inbox.md:L42 minutes=90m
obsidian task-center:tag ref=Tasks/Inbox.md:L42 tag='#基建'
obsidian task-center:deadline ref=Tasks/Inbox.md:L42 date=2026-05-15
obsidian task-center:undone ref=Tasks/Inbox.md:L42
```

Full list with `obsidian help task-center`.

### Output shape

Human-readable, greppable, first column always an id:

```
$ obsidian task-center:list scheduled=today
3 tasks · scheduled today · 2026-04-24

Tasks/Inbox.md:L42  [ ]  #2  添加 bq 权限
    scheduled 2026-04-24  deadline 2026-05-15  est 90m
    ├ L43  [ ]  写测试   est 30m
    └ L44  [ ]  跑 CI    est 60m
```

Write verbs return `ok / before / after`:

```
$ obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-04-25
ok  Tasks/Inbox.md:L42  添加 bq 权限
    before  - [ ] 添加 bq 权限 #2象限 ⏳ 2026-04-24 [estimate:: 90m]
    after   - [ ] 添加 bq 权限 #2象限 ⏳ 2026-04-25 [estimate:: 90m]
```

Idempotent: running `done` on an already-done task returns `ok … unchanged (already done ✅ 2026-04-23)` rather than erroring.

### Filter vocabulary

`scheduled=` / `done=` accept:

- `today` / `tomorrow` / `yesterday`
- `week` (this week) / `next-week`
- `month` / `next-month`
- `unscheduled` (scheduled= only — tasks without ⏳)
- `YYYY-MM-DD` for a specific day
- `FROM..TO` e.g. `2026-04-01..2026-04-30`

### Task IDs

- `path:L42` — exact file + line
- `path:L42` where L42 falls out of date → falls back to title hash
- 12-char hex hash (shown by `show`)

Ambiguous hashes return an `ambiguous_slug` error listing candidates.

## AI integration

The CLI output is designed for Claude Code / other agents:

1. First column of every list row is a pipe-friendly id — `grep`, `awk`, `cut` work.
2. Write verbs are idempotent, so the AI can re-run without side-effect explosion.
3. `stats days=N` gives the estimate-accuracy ratio + per-tag minutes so the AI can calibrate its future estimates (planning fallacy correction).

Recommended AI workflow:

```bash
# Grab today's candidate pool
obsidian task-center:list scheduled=unscheduled
obsidian task-center:list scheduled=tomorrow

# Estimate calibration
obsidian task-center:stats days=7

# Schedule picks
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-04-24
obsidian task-center:add text="新冒出来的事" tag='#3象限' scheduled=2026-04-24
```

## Development

```bash
git clone <this repo>
cd obsidian-task-center
npm install
npm run dev          # esbuild watch mode

# Symlink into your dev vault (recommended):
ln -s $(pwd) /path/to/vault/.obsidian/plugins/obsidian-task-center

# Reload on change (or install pjeby/hot-reload for auto-reload):
obsidian plugin:reload id=obsidian-task-center
```

## Settings

| Setting | Default | Description |
|---|---|---|
| Default inbox path | `Tasks/Inbox.md` | Where `add` writes when `to=` omitted AND no daily note |
| Daily folder | `Daily` | Default `add` target (today's daily note) |
| Default view | Week | Which tab opens first |
| Week starts on | Monday | ISO vs US-style |
| Open board on startup | off | Auto-open on vault launch |
| Stamp ➕ created date | on | Add `➕ YYYY-MM-DD` to every new task |

## License

MIT. Patches welcome.
