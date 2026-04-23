---
name: obsidian-better-task
description: Read and write tasks in an Obsidian vault through the Better Task plugin's CLI. Use when the user wants to list, schedule, complete, abandon, or add tasks — or when they want estimate-accuracy / tag-distribution stats. Obsidian must be running with the `obsidian-better-task` plugin enabled; all verbs are namespaced `obsidian better-task:<verb>`.
---

# Obsidian Better Task — CLI skill

This skill is the AI interface to the [obsidian-better-task](https://github.com/CorrectRoadH/obsidian-better-task) plugin. The plugin registers its verbs to Obsidian's native CLI (1.12.2+), so calls go `obsidian better-task:<verb> key=value …`.

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
| `#1象限..#4象限` | quadrant | Covey quadrants (1=urgent+important, 2=not-urgent+important, 3=urgent, 4=neither) |

## When to use this skill

- "list today's tasks" / "what do I have scheduled" → `better-task:list`
- "show task details" / "pull the raw line" → `better-task:show`
- "schedule X" / "move X to tomorrow" → `better-task:schedule`
- "mark X done" / "I finished X" → `better-task:done`
- "drop X" / "abandon X" / "remove X" → `better-task:drop`
- "log time on X" / "I spent 45m on X" → `better-task:actual`
- "add a task" / "remind me to …" → `better-task:add`
- "how accurate were my estimates" / "weekly review" → `better-task:stats`

**Do not** use `Read`/`Write` directly on task files to mutate tasks — use the CLI so `vault.process` locking + parser conventions are respected. Reading files is fine when you want broader context (the task body, surrounding notes).

## Before calling any verb

Verify the plugin is loaded:

```bash
obsidian plugins:enabled | grep obsidian-better-task
```

If missing, ask the user to enable it. If Obsidian isn't running, the CLI will auto-launch (first call incurs latency).

## Verbs

### `better-task:list [filters]`

Read-only. Returns tasks matching all filters. Every row starts with `<path>:L<line>` as the id — safe to pipe.

```
obsidian better-task:list scheduled=today
obsidian better-task:list scheduled=unscheduled tag='#2象限'
obsidian better-task:list done=2026-04-01..2026-04-30
obsidian better-task:list overdue
obsidian better-task:list status=todo search=携号
```

`scheduled=` / `done=` vocabulary:
- `today` / `tomorrow` / `yesterday`
- `week` (this week) / `next-week`
- `month` / `next-month`
- `unscheduled` (only meaningful with `scheduled=`)
- ISO `YYYY-MM-DD`
- range `YYYY-MM-DD..YYYY-MM-DD`

Other flags: `overdue`, `has-deadline`, `status=todo|done|dropped`, `tag=<comma-sep>` (supports `#*象限`), `parent=<id>`, `search=<text>`, `limit=N`, `format=text|json` (JSON gives a structured array with every field — prefer it when you plan to parse).

### `better-task:show ref=<id>`

Full single-task detail — scheduled/deadline/estimate/actual/created/completed/cancelled/parent/children/raw.

### `better-task:stats [days=N] [group=<prefix>]`

Rolling-window estimate accuracy + tag minutes breakdown. Default `days=7`. `group=象限` aggregates matching tags into a section (useful for Covey quadrants). Output includes:

- `sum actual / sum estimate` ratio (calibration signal)
- `per-task mean / σ` for ratio variance
- `within band 11/18 (61%)` share inside `[0.8, 1.25]`
- per-tag minutes with ASCII bar chart

Use this to **correct planning-fallacy** when suggesting estimates. If the 7-day `ratio` is 1.3, new estimates should be scaled up by that factor vs. the user's gut feel.

### Write verbs (idempotent, safe to retry)

All write verbs return `ok <id>` with a `before / after` diff, or `unchanged` if already in the target state.

```
obsidian better-task:schedule ref=Tasks/Inbox.md:L42 date=2026-04-25
obsidian better-task:schedule ref=Tasks/Inbox.md:L42 date=null       # clear ⏳

obsidian better-task:deadline ref=… date=2026-05-15
obsidian better-task:deadline ref=… date=null

obsidian better-task:estimate ref=… minutes=90m         # set [estimate::]
obsidian better-task:estimate ref=… minutes=null        # clear
obsidian better-task:actual   ref=… minutes=45m         # set [actual::]
obsidian better-task:actual   ref=… minutes=+15m        # additive

obsidian better-task:done   ref=… [at=YYYY-MM-DD]       # [x] + ✅
obsidian better-task:undone ref=…                        # reverse a done
obsidian better-task:drop   ref=…                        # [-] + ❌, cascades to children

obsidian better-task:tag    ref=… tag='#基建'            # add
obsidian better-task:tag    ref=… tag='#基建' remove     # remove

obsidian better-task:add text="去营业厅问携号转网" tag='#3象限' scheduled=2026-04-26 [to=<path>] [deadline=…] [estimate=30m] [parent=<id>]
```

`better-task:add` target priority: explicit `to=` → parent's file (if `parent=` given) → today's daily note → settings inbox path. Default stamps `➕ today` unless `stamp-created=false`.

`drop` always cascades — dropping a parent also marks every descendant `[-] ❌`. To drop just one line, pass a leaf task.

### Error shape

Errors go to stderr as:

```
error  <code>
    <human message>
```

Codes: `task_not_found`, `file_modified`, `ambiguous_slug`, `invalid_date`, `invalid_indent`.

Recover by:
- `task_not_found` → re-run `better-task:list` to get fresh ids
- `ambiguous_slug` → the error message lists candidate ids; pick one
- `invalid_date` → convert to `YYYY-MM-DD`

## Recommended workflows

### End-of-day wrap-up

1. `obsidian better-task:list done=today` → collect what got done.
2. `toggl entry list --since today` → cross-reference actual time per task.
3. For each completed task: `obsidian better-task:actual ref=… minutes=Nm` to record real time.
4. `obsidian better-task:stats days=7 group=象限` → read today's calibration.
5. `obsidian better-task:list scheduled=unscheduled` + `obsidian better-task:list scheduled=tomorrow` → candidate pool.
6. Pick tomorrow's set (≤1 big, ≤2 small based on user's self-declared capacity), deadline-first, quadrant-2-first.
7. `obsidian better-task:schedule ref=… date=<tomorrow>` per chosen task; use `add` for anything new.

### Quick capture

User says "don't forget to X". Default to today's daily note:

```
obsidian better-task:add text="X"
```

Only set `scheduled=` / `deadline=` / `tag=` if the user specified them.

### Backfill completions

User says "I finished Y yesterday": `obsidian better-task:done ref=<id> at=<yesterday>`.

## Output contract

- Every list row starts with `<path>:L<line>` — pipe-friendly.
- Monetary / time values: minutes, no conversion. Format with `formatMinutes` convention (`90m`, `1h30m`).
- Writes print `before / after` — use this to confirm the mutation was what you intended.
- Stats output is ASCII-bar-charted; do not JSON-ify it before showing the user.

## Do not

- Do not edit task files directly with `Read` + `Write`; use the CLI so parser + locking invariants hold.
- Do not try to install a wrapper shell script called `obsidian-better-task`; the plugin uses Obsidian's native CLI.
- Do not call `obsidian task` / `obsidian tasks` (those are built-in, read-only) when you mean `better-task:…`.
- Do not stamp `✅` / `❌` / `➕` manually with `Edit` — let the plugin do it via `done` / `drop` / `add`.
