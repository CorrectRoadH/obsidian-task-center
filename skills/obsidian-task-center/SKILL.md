---
name: obsidian-task-center
description: Read and write tasks in an Obsidian vault through the Task Center plugin's CLI. Use when the user wants to list, schedule, complete, abandon, nest, or add tasks — or when they want estimate-accuracy / review / agent-brief stats. Obsidian must be running with the task-center plugin enabled; commands use the obsidian task-center namespace.
---

# Obsidian Task Center — CLI skill

This skill is the AI interface to the obsidian-task-center plugin. The plugin registers its verbs to Obsidian's native CLI (1.12.2+), so calls go `obsidian task-center:<verb> key=value …`.

Product behavior follows `USER_STORIES.md` §16. CLI is desktop-only (US-201 / US-501). A view / Tab is a saved layout with independent areas; filters belong only to each area's `when`, and GUI statistics appear in area headers, not in a tab-level summary.

For a full command index, run:

```bash
obsidian task-center
```

Data stays inline markdown. Syntax:

```
- [ ] Title #2象限 📅 2026-05-15 ⏳ 2026-04-24 ➕ 2026-04-23 [estimate:: 90m] [actual:: 75m]
```

| Field | Encoding | Meaning |
|---|---|---|
| `⏳ YYYY-MM-DD` | scheduled | which day the user plans to do it |
| `📅 YYYY-MM-DD` | deadline | external hard deadline |
| `➕ YYYY-MM-DD` | created | when the task was added |
| `✅ YYYY-MM-DD` | completed | done stamp (written when `[x]`) |
| `❌ YYYY-MM-DD` | cancelled | dropped stamp (written when `[-]`) |
| `[estimate:: Nm]` | estimate | minutes planned |
| `[actual:: Nm]` | actual | minutes actually spent |
| `#project` | tag | user-defined classification; no built-in methodology |

Tasks emoji and Dataview fields are both readable; when both encode a field, emoji wins. Writes follow the user's task-format preference and remove the alternate encoding of the changed field (US-111 / US-407). Quadrant tags in examples are optional user conventions, never a plugin rule (US-301).

## When to use this skill

- "list today's tasks" / "what do I have scheduled" → `task-center:list`
- "show task details" / "pull the raw line" → `task-center:show`
- "schedule X" / "move X to tomorrow" → `task-center:schedule`
- "mark X done" / "I finished X" → `task-center:done`
- "drop X" / "abandon X" / "remove X" → `task-center:abandon`
- "nest X under Y" / "make X a subtask of Y" → `task-center:nest`
- "log time on X" / "I spent 45m on X" → `task-center:actual`
- "add a task" / "remind me to …" → `task-center:add`
- "how accurate were my estimates" / "weekly review" → `task-center:stats`
- "what should I do next" / "brief me on today" → `task-center:brief`
- "end-of-day review" / "what happened this week" → `task-center:review`
- "list/manage/edit query tabs" / "show saved query DSL" / "run a preset view" → `task-center:query-list` / `task-center:query-show` / `task-center:query-run`
- "create/update/rename/copy/hide/delete/default a query tab" → `task-center:query-create` / `task-center:query-update` / `task-center:query-rename` / `task-center:query-copy` / `task-center:query-hide` / `task-center:query-delete` / `task-center:query-set-default`

**Do not** use `Read`/`Write` directly on task files to mutate tasks — use the CLI so `vault.process` locking + parser conventions are respected. Reading files is fine when you want broader context (the task body, surrounding notes).

## Before calling any verb

Verify the plugin is loaded:

```bash
obsidian plugins:enabled | grep task-center
```

If missing, ask the user to enable it. If Obsidian isn't running, the CLI will auto-launch (first call incurs latency).

If `obsidian task-center` works but a specific verb is missing, the vault is running an older plugin build. Ask the user to update/reload Task Center before using that verb.

## Verbs

### `task-center:list [filters]`

Read-only. Returns tasks matching all filters. Every row starts with `<path>:L<line>` as the id — safe to pipe.

```
obsidian task-center:list scheduled=today
obsidian task-center:list scheduled=unscheduled tag='#2象限'
obsidian task-center:list done=2026-04-01..2026-04-30
obsidian task-center:list overdue
obsidian task-center:list status=todo search=示例
```

`scheduled=` / `done=` vocabulary:
- `today` / `tomorrow` / `yesterday`
- `week` (this week) / `next-week`
- `month` / `next-month`
- `unscheduled` (only meaningful with `scheduled=`)
- ISO `YYYY-MM-DD`
- range `YYYY-MM-DD..YYYY-MM-DD`

Other flags: `overdue`, `has-deadline`, `status=todo|done|dropped`, `tag=<comma-sep>` (supports `#*象限`), `parent=<id>`, `search=<text>`, `limit=N`, `format=text|json` (JSON gives a structured array with every field — prefer it when you plan to parse).

Scheduling filters use effective scheduled dates (inherit from parents when absent); `week` follows the configured first day of week. `list parent=<id>` includes all descendants (US-207 / US-212 / US-144).

### `task-center:show ref=<id>`

Full single-task detail — raw text, status, all dates, tags, estimate/actual, parent and child ids (US-216a). `show` and JSON also include the title hash; every `ref=` accepts either `path:Lnn` or that hash. If a line moved, resolution must verify the task identity; never write to an unrelated replacement line (US-202 / US-208).

### `task-center:stats [days=N] [from=<date>] [to=<date>] [group=<text>] [format=text|json]`

Rolling-window estimate accuracy + tag minutes breakdown. Default `days=7`, including today in every timezone. `group=象限` aggregates tags whose names contain that text (US-206). Output includes:

- `sum actual / sum estimate` ratio (calibration signal)
- `per-task mean / σ` for ratio variance
- `within band 11/18 (61%)` share inside `[0.8, 1.25]`
- per-tag minutes with ASCII bar chart

Use historical ratios as context when the user asks for planning advice; do not automatically rewrite their estimates or impose a task-management method.

### `task-center:brief [today=YYYY-MM-DD] [limit=N] [format=text|json]`

Agent brief for near-term planning. Shows overdue / today / unscheduled candidate counts, sample tasks, and executable next-action commands such as `done`, `abandon`, `schedule_today`, `schedule_tomorrow`, and `actual +15m`.

`brief` overdue includes unfinished tasks with past scheduled dates or deadlines; today includes either date falling today. No unfinished task with a scheduled date or deadline on/before today may be omitted. This differs from the GUI Today view's deadline-only overdue area, whose unscheduled recommendations exclude overdue tasks (US-723 / US-720b).

Use this when the user asks what to do next or wants a compact status overview before planning.

### `task-center:review [today=YYYY-MM-DD] [days=N] [limit=N] [format=text|json]`

End-of-day / weekly retrospective summary. Reports today and rolling-week windows: done, abandoned, delayed-open tasks, estimate-vs-actual totals, grouping summaries, and sample task ids.

Use this for shutdown reviews, weekly reviews, and "what actually happened?" questions. Prefer text output for user-facing summaries; use `format=json` only when you need to parse it.

### Query Tab / preset views

A Query Tab is a saved QueryPreset — a `view.layout` tree (same storage/schema/validation as the GUI Query editor). Target tabs by stable `id`, never display name.

Read / run (common, read-only):

```
obsidian task-center:query-list [hidden=true] [format=json]
obsidian task-center:query-show id=preset-week
obsidian task-center:query-run  id=preset-today [view=list|week|month] [anchor=YYYY-MM-DD] [format=json]
```

- `query-run` outputs every task area in layout order, with an area title for each section; drop areas are omitted. Lists/grids output task trees, week areas group all 7 days, month areas group by date; JSON contains all area results (US-220).
- `view=` temporarily changes each task area's display type, retaining its own `when` and area order; it never collapses the layout into one area or writes back. `anchor=` is the week/month cursor (defaults to today) and accepts natural-language dates (US-410a).
- Rows keep stable ids (`Tasks/Inbox.md:L42`) — pipe into `show` / `schedule` / `done` / `abandon`.

Create / edit a view (the DSL is a layout tree; **filtering lives only in each area's `when`**):

```
obsidian task-center:query-create dsl='…'      # new tab, always a fresh id (query-save is an alias)
obsidian task-center:query-update id=… dsl='…' # edit existing; keeps id/builtin; invalid DSL leaves it untouched
obsidian task-center:query-rename id=… name="…"
obsidian task-center:query-copy   id=… [name="…"]
obsidian task-center:query-hide   id=… hidden=true|false
obsidian task-center:query-delete id=…
obsidian task-center:query-set-default id=…|null
```

Before writing DSL: filtering belongs **only** to each area's `when`. Top-level `filters` / `summary`, old flat `search` / `tag` / `time` / `status`, and old `view.type/preset/sections/tray/matrix` shapes are **rejected with `invalid_query`**. Update this skill and use `view.layout`; do not expect silent ignoring or automatic migration on CLI import (US-217a). Tags use `{ "expr": "(#work or #urgent) and not #waiting" }`; legacy tag-array / values-mode forms remain readable with the same meaning (US-109d4).

**Product requirements come from `USER_STORIES.md`; grammar references are `docs/dsl/zh.md` (English `docs/dsl/en.md`).** If an older grammar example conflicts with current requirements, report the discrepancy instead of importing a rejected legacy shape. Before building/editing a view:

- Full grammar (node types, Filters/`when`, onDrop, orderBy, real factory DSL) → read `docs/dsl/zh.md` or `en.md`; a condensed skill-local mirror is `reference/queries.md`.
- Ready-made layouts: four quadrants → `examples/four-quadrant.md`; week + unscheduled tray + drop zone → `examples/week-with-tray.md`; simple / multi-segment list → `examples/simple-list.md`.
- Unsure of the current shape? `query-show id=preset-today` (col of 3 lists) or `id=preset-week` (week + tray + drop), and mirror what it returns instead of guessing.

Rules: builtin and custom tabs can be deleted; deletion removes only the view, never tasks. Deleted builtin tabs stay deleted after reload and can be restored explicitly in the GUI (US-109l / US-218). Saved layouts and mixed tab ordering survive reload, reopening the vault, and upgrades (US-109c2). A hidden tab cannot be default. Invalid DSL returns `invalid_query`, identifies the area and field, and leaves settings unchanged; successful changes refresh open boards (US-217 / US-219). Use `query-list` for current ids; the stories do not yet assign an error code for an unknown view id, so do not assume a separate `query_not_found` code.

### Write verbs

State-setting verbs return `ok <id>` with `before / after` for every changed line, or `unchanged` if already in the target state. Repeating `done` on a completed task preserves its original completion date, even on a later day (US-203 / US-204). `add` returns the new task id and line; `nest` returns the moved task's new id. Do not blindly retry additive time updates or task creation after an uncertain result; inspect the task first (see the unresolved retry boundary below).

```
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-04-25
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=null       # clear ⏳

obsidian task-center:deadline ref=… date=2026-05-15
obsidian task-center:deadline ref=… date=null

obsidian task-center:estimate ref=… minutes=90m         # set [estimate::]
obsidian task-center:estimate ref=… minutes=null        # clear
obsidian task-center:actual   ref=… minutes=45m         # set [actual::]
obsidian task-center:actual   ref=… minutes=+15m        # additive
obsidian task-center:actual   ref=… minutes=-15m        # subtract, floor at zero

obsidian task-center:done   ref=… [at=YYYY-MM-DD]       # [x] + ✅
obsidian task-center:undone ref=…                        # reverse a done
obsidian task-center:abandon ref=…                       # [-] + ❌, cascades to todo children
obsidian task-center:drop   ref=…                        # deprecated alias for abandon

obsidian task-center:tag    ref=… tag='#基建'            # add
obsidian task-center:tag    ref=… tag='#基建' remove     # remove

obsidian task-center:rename ref=… title="新的任务标题"  # preserves all metadata; empty title is missing_arg

obsidian task-center:nest   ref=… under=…                # make ref a subtask of under

obsidian task-center:add text="处理示例任务" tag='#3象限' scheduled=2026-04-26 [to=<path>] [deadline=…] [estimate=30m] [parent=<id>]
```

`task-center:add` uses explicit `to=`, or the parent's file when `parent=` is given, otherwise today's Daily Note. If `to=` and `parent=` name different files, return `invalid_arg`. If today's note does not exist, create it using Daily Notes' folder, filename format, and template before appending. There is no inbox fallback: the default Daily Note path requires the plugin enabled (`daily_notes_missing`) and a configured folder (`daily_notes_folder_missing`). Default stamps today's created date unless `stamp-created=false` (US-163 / US-213).

`schedule` and `deadline` require `date=`: only explicit `date=null` clears the field, omission returns `missing_arg` (US-221). All CLI date parameters accept natural language such as `today`, `tomorrow`, `今天`, `明天`, `周六`, `next-week`; invalid/unrecognized/nonexistent dates return `invalid_date` and never enter Markdown as raw words (US-410a).

Boolean parameters are parsed by value: `remove=false` does not remove a tag, `hidden=false` means visible. `days` and `limit` must be positive integers; invalid numeric, boolean, duration, or tag values return `invalid_arg` (US-413a / US-211).

Time increments/decrements use the value in the file at write time, not cached values (US-209). Tags match whole tokens, including Chinese and hierarchical tags: removing `#work` does not remove `#work/sub`, and adding an existing tag is unchanged (US-223).

`abandon` / `drop` cascades to todo descendants only. Already completed / abandoned / cancelled descendants keep their historical stamps. To abandon just one line, pass a leaf task.

`done` also cascades to unfinished descendants while preserving completed descendants' history. Changing back to todo clears completion and dropped dates; dropped → done clears the dropped date (US-222). `nest` moves the entire subtree, clears only the moved root's own scheduled date, and preserves descendant metadata (US-228).

### Error shape

Errors go to stderr as:

```
error <code>
<one human-readable sentence explaining what to do>
```

The fixed code set is `not_found`, `ambiguous_slug`, `missing_arg`, `invalid_arg`, `invalid_date`, `invalid_query`, `daily_notes_missing`, `daily_notes_folder_missing`, `write_conflict` (US-211). Codes stay English; the second line follows Obsidian's language (US-412).

Recover by:
- `not_found` → re-run `task-center:list` to get fresh task ids
- `ambiguous_slug` → the error message lists candidate ids; pick one
- `missing_arg` → supply the required parameter; omitted dates never mean clear
- `invalid_arg` → correct the duration, positive integer, boolean, tag, or other argument
- `invalid_date` → use a recognizable date or a valid `YYYY-MM-DD`
- `daily_notes_missing` → enable Daily Notes, or use an explicitly requested `to=<path>` / parent target
- `daily_notes_folder_missing` → configure its folder, or use an explicitly requested target
- `write_conflict` → re-read the affected tasks and reconcile before retrying; do not overwrite concurrent edits
- `invalid_query` → the message echoes the validation failure; fix the DSL per `docs/dsl/` (filtering must be per-area `when`)

Unresolved in the stories: US-203 says every write is repeatable, while US-209 explicitly makes `actual +Nm/-Nm` additive and US-213 creates a new task; retry/deduplication semantics for these commands are not specified. Unknown view-id and partial cross-file `nest` error classification also need clarification. Do not invent extra error codes or assume automatic rollback.

## Recommended workflows

### End-of-day wrap-up (US-210)

```bash
obsidian task-center:list done=today
# Use a real id from list; record the user's reported duration.
obsidian task-center:actual ref='Daily/2026-10-18.md:L42' minutes=45m
obsidian task-center:review days=7
obsidian task-center:stats days=7
obsidian task-center:list scheduled=unscheduled
obsidian task-center:list scheduled=tomorrow
# Schedule the task the user selected; replace this example id with the returned id.
obsidian task-center:schedule ref='Tasks/Project.md:L12' date=tomorrow
```

Summarize completion, abandonment, delay, and estimate/actual totals. Choose follow-up tasks according to the user's priorities; no external time-tracker or quadrant method is required.

### Quick capture (US-210)

User says "don't forget to X". Default to today's daily note:

```
obsidian task-center:add text="X"
```

Only set `scheduled=` / `deadline=` / `tag=` if the user specified them.

### Backfill completions (US-210)

User says “I finished Y yesterday”: locate the task first and verify it, then use the returned id (the id below is illustrative).

```bash
obsidian task-center:list search='Y'
obsidian task-center:show ref='Tasks/Project.md:L12'
obsidian task-center:done ref='Tasks/Project.md:L12' at=yesterday
obsidian task-center:show ref='Tasks/Project.md:L12'
```

If several tasks match, ask which one. If it is already completed, `done` returns unchanged rather than overwriting the historical date (US-203).

## Output contract

- Every list row starts with `<path>:L<line>` — pipe-friendly.
- Monetary / time values: minutes, no conversion. Format with `formatMinutes` convention (`90m`, `1h30m`).
- Writes print `before / after` — use this to confirm the mutation was what you intended.
- Stats output is ASCII-bar-charted; do not JSON-ify it before showing the user.
- `brief` and `review` default to greppable text; use `format=json` only for downstream parsing.

## Do not

- Do not edit task files directly with `Read` + `Write`; use the CLI so parser + locking invariants hold.
- Do not try to install a wrapper shell script called `obsidian-task-center`; the plugin uses Obsidian's native CLI.
- Do not call `obsidian task` / `obsidian tasks` (those are built-in, read-only) when you mean `task-center:…`.
- Do not stamp `✅` / `❌` / `➕` manually with `Edit` — let the plugin do it via `done` / `abandon` / `add`.
