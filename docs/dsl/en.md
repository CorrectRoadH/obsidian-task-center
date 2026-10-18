# Task Center Query DSL Reference

**English** · [中文](zh.md)

Every Tab in Task Center is a **Query DSL** (a single `QueryPreset` object). The same DSL drives all of: the graphical filters, the view layout, and CLI queries. Click **Edit Query** on any Tab to see and edit this JSON directly.

> This is the **SSOT (single source of truth)** for the DSL. If anything else (README, the skill, AI prompts) disagrees with this document, this document wins; change the DSL behaviour here first.
>
> Markdown is the single source of truth for data. The DSL only decides *how to filter, sort, and arrange*; the task data itself always lives in the Markdown lines of your vault. Views and filters are all derived from Markdown.
>
> For the field-by-field TypeScript types, see [`ARCHITECTURE.md` §1.3](../../ARCHITECTURE.md#13-querypreset); the runtime shape is whatever `QueryPreset` in `src/types.ts` says.

---

## 1. The shape of a preset

```jsonc
{
  "id": "preset-today",
  "name": "Today",
  "builtin": true,
  "hidden": false,
  "view": { "layout": { /* the layout tree: how to arrange, and what each block filters */ } }
}
```

| Field | Role |
| --- | --- |
| `id` | Stable id; locate presets by this, not the display name. Optional (generated if missing). CLI `query-create` always assigns a new id and `query-update` always keeps the existing one, so an `id` in the DSL has no effect on either path. |
| `name` | Display name, **required** (on `query-update` it falls back to the existing name). |
| `builtin` / `hidden` | Built-in / hidden from the Tab bar. Optional, default `false`. |
| `view.layout` | The **layout tree**: which components to show, how they nest, and **what each component filters**. Without `view` you get a single unfiltered `list`. |

The whole DSL may also be wrapped as `{ "query": { … } }`; it behaves the same.

> ⚠️ A preset is **identity + one `view.layout`, nothing more**. There is **no** tab-level `filters`, **no** `summary`, and **no** "view type" enum; all were removed in 1.0 (US-109z2).
>
> Submitting any of these pre-1.0 shapes through **Edit Query** or the CLI (`query-create` / `query-update`) is **rejected outright** (the CLI returns `invalid_query` and tells you to update the skill and use `view.layout` + area `when`, US-217a):
> - a top-level `filters` or `summary` (even an empty `{}`);
> - flat top-level `search` / `tag` / `time` / `status`;
> - a `view` with no `layout` but with `type` / `preset` / `sections` / `tray` / `matrix`.
>
> Only legacy data **already stored** in `data.json` is migrated into a `{ layout }` tree, by the upgrade gate on plugin load (US-414 / US-415). Hand-written input is not.

What a view looks like is **decided entirely by the `view.layout` tree**.

---

## 2. Filtering: each area's own `when`

There is no "base set for the whole Tab". Every list / grid / week / month area carries its **own `when`**, which is that block's entire filter. The graphical filter UI edits exactly this `when`; it is the same data as editing the DSL by hand.

```jsonc
"when": {
  "search": "report",                                  // title or any tag contains this text (case-insensitive)
  "tags": { "expr": "#work and not #someday" },        // tag boolean expression, see below
  "status": ["todo"],                                  // see below; omit = all
  "time": {
    "scheduled": "today",                              // ⏳ scheduled
    "deadline":  "next-7-days",                        // 📅 deadline
    "completed": "week",                               // ✅ completed
    "created":   "2026-01-01..2026-06-30"              // ➕ created
  }
}
```

All conditions are **AND-ed**: to enter this block a task must satisfy every key in `when`. Omitted keys don't filter.

> Values inside `when` are currently **not validated**: a wrong value doesn't raise an error, it is silently dropped or matches nothing (see each subsection). Double-check spelling before submitting.

### search

A string, trimmed, matched as a case-insensitive substring: a task matches if its **title** or **any of its tags** contains it.

### status

Accepted values:

| Value | Checkbox |
| --- | --- |
| `todo` | `- [ ]` |
| `done` | `- [x]` |
| `dropped` | `- [-]` |
| `in_progress` | `- [/]` |
| `cancelled` | `- [>]` |
| `custom` | any other character |

Forms: an array (multi-select, any match), a single string, or `"all"`; omit = all. It matches the post-inheritance `effectiveStatus` (when a parent is done / dropped, its children count as that terminal status). The GUI status picker only offers All / TODO / Done / Dropped.

> Unknown values are dropped; if none are recognised it falls back to `"all"` (no status filter), without an error. After normalization every `when` carries an explicit `"status": "all"` or status array.

### tags: tag expression

Tag filtering is a **boolean expression**; the canonical form is `{ "expr": "…" }` (US-109d4).

- Syntax: tags, `and`, `or`, `not`, parentheses `( )`.
- Precedence `not` > `and` > `or`; use parentheses to group.
- Keywords are case-insensitive, and only **bare** `and` / `or` / `not` (no `#`) are keywords; `#and` is a tag named "and".
- The leading `#` on a tag is optional; tags are case-insensitive and match the **whole tag** exactly (`#a` doesn't match `#a/b`, and vice versa).
- Operators are required: `#a #b` is a syntax error, not an implicit AND.
- Tag names can't contain spaces or parentheses (they are separators).

Example: `"tags": { "expr": "(#a or #b) and not #c" }` means "has a or b, and does not have c".

On a syntax error (e.g. `#a and (`) the expression is saved as written, but that area **does no tag filtering** (fail-open), so tasks are never silently lost; the GUI input highlights the error in place.

**Legacy forms** are still accepted and rewritten into the equivalent `{ expr }` on normalization, so `query-show` always shows an expression:

| Legacy form | Equivalent expression |
| --- | --- |
| `["#a", "#b"]` or `"a, b"` | `#a and #b` |
| `{ "values": ["#a", "#b"], "mode": "or" }` | `#a or #b` |
| `{ "values": ["#a"], "exclude": ["#c"] }` | `#a and not #c` |

`tags` of any other type (a number, say) is silently ignored.

The GUI tag popover has an expression input (live validation, with examples) plus a tag list; clicking a tag in the list appends `#tag` to the expression with `and`.

### time: fields and date vocabulary

`time` is an object with 4 fields:

| Field | Value source |
| --- | --- |
| `scheduled` | ⏳ scheduled date (including one inherited from a parent) |
| `deadline` | 📅 deadline (including one inherited from a parent) |
| `completed` | ✅ completion date (the task's own line) |
| `created` | ➕ created date (inherited when missing) |

Each field takes one date token:

| Token | Meaning |
| --- | --- |
| `all` | no restriction |
| `today` / `tomorrow` | today / tomorrow |
| `week` / `next-week` | this week / next week (week start follows the plugin setting) |
| `month` | this month |
| `unscheduled` | **the field is empty** (e.g. "not scheduled" = `scheduled: "unscheduled"`, "no deadline" = `deadline: "unscheduled"`) |
| `overdue` | before today (**`deadline` only**) |
| `next-7-days` | today through 7 days from now, inclusive (**`deadline` only**) |
| `2026-06-23` | a single day (`YYYY-MM-DD`) |
| `2026-06-01..2026-06-30` | inclusive range (`from..to`, either end may be empty, e.g. `2026-06-01..`) |

- Apart from `all` and `unscheduled`, a task whose field is empty never matches.
- "Today" for relative tokens: list / grid use the real today; week / month use the anchor date you've navigated to (`anchor=` on the CLI).
- `overdue` / `next-7-days` on any field other than `deadline` **match nothing**.
- **There is no `yesterday` / `next-month`** (that's the vocabulary of the `task-center:list` CLI verb). Unknown tokens don't error, they just match nothing.
- Field names other than the 4 above are dropped.

---

## 3. view.layout: a SwiftUI-style layout tree

The layout tree is made of two kinds of node:

- **Container node (Stack)**: `row` (≈ HStack, horizontal) or `col` (≈ VStack, vertical), nesting children via `children`, with an optional `weight` for flex ratio.
- **Leaf node (Area)**: the component that actually renders content (`list` / `grid` / `week` / `month` / `drop`).

```jsonc
"layout": {
  "dir": "col",                      // col = vertical; row = horizontal
  "children": [
    { "type": "week" },              // leaf: week grid
    { "type": "list", "weight": 1 }  // leaf: list, takes 1 flex share
  ]
}
```

Structural validation (any failure rejects the whole DSL):

| Rule | Error code |
| --- | --- |
| Every node must be an object | `invalid_layout` |
| A node with `dir` or `children` is a Stack; `dir` must be `"row"` / `"col"` | `invalid_stack_dir` |
| A Stack's `children` must be a non-empty array | `invalid_stack_children` |
| An area's `type` must be a string (omitted = `list`) | `invalid_area_type` |
| A `drop` area must have an `onDrop` object | `drop_requires_on_drop` |

`weight` must be a positive number, otherwise it's ignored.

The root can be a Stack, or **directly a single area** (no wrapper needed). For example, the TODO view's root is just one `list`:

```jsonc
"layout": { "type": "list", "when": { "status": ["todo"] } }
```

A view isn't "one type"; it freely combines several areas: Week = `col[ week grid, row[unscheduled, drop zone] ]`, Unscheduled = `col[ list ]`, or roll your own side-by-side `row[ work list, personal list ]`.

---

## 4. Area types, one by one

Optional fields shared by every area:

| Field | Description |
| --- | --- |
| `id` | Stable identifier. The built-in ids `overdue` / `today` / `unscheduled-rec` / `unscheduled-tray` show a title localized to the UI language, overriding `title`. |
| `title` | Area title. If omitted, the first content area borrows the Tab name and the rest show the area type's label. |
| `weight` | Flex ratio (positive number). |
| `onDrop` | Write action on drop, see §5.2. |

### 4.1 list: task list

The most common component: `when` selects a column of task cards. When a parent and its child both match, the child is nested inside the parent card instead of appearing twice.

![list view](../assets/dsl/todo.png)

```jsonc
{
  "type": "list",
  "when": { "tags": { "expr": "#work" } },
  "orderBy": ["deadline_risk", "created_desc"],
  "limit": 50
}
```

| Field | Description |
| --- | --- |
| `when` | This block's filter (see §2). The graphical filter UI edits exactly this `when`. |
| `orderBy` | Sorting, see [§5.3](#53-orderby-sorting). Omitted = original vault order. |
| `limit` | Max number of items (positive number; strings, 0 and negatives are ignored). |
| `emptyText` | Saved, but **not used by the UI today**: empty areas always show the built-in empty-state text. |

#### Multi-segment lists: stack several lists in a col

`list` has no internal grouping. To split a list into overdue / today / unscheduled segments like Today does, stack 3 `list` areas in a `col`; each carries a full `when` and filters itself (see Today in §6). Shared conditions are simply repeated in each block's `when`.

### 4.2 grid: card grid

Same fields, filtering and sorting as `list`, but cards are laid out in a **responsive multi-column grid**. Two-dimensional categorization (four quadrants) is expressed by nesting several grids with a `title` + `when` inside `row` / `col`; **there is no dedicated matrix type**:

![four quadrants = row/col of nested grids](../assets/dsl/quadrant.png)

```jsonc
"layout": {
  "dir": "col",
  "children": [
    { "dir": "row", "children": [
      { "type": "grid", "title": "Important & Urgent",     "when": { "tags": { "expr": "#important and #urgent" } } },
      { "type": "grid", "title": "Important & Not urgent", "when": { "tags": { "expr": "#important and not #urgent" } } }
    ] },
    { "dir": "row", "children": [
      { "type": "grid", "title": "Not important & Urgent",     "when": { "tags": { "expr": "not #important and #urgent" } } },
      { "type": "grid", "title": "Not important & Not urgent", "when": { "tags": { "expr": "not #important and not #urgent" } } }
    ] }
  ]
}
```

### 4.3 week: week grid

A date grid shown by week, with `◀ week ▶` navigation. Tasks land in the day cell of their ⏳ scheduled date (including inherited ones); unscheduled tasks don't appear here. Every day cell is a drop target: drag a card onto a day to write that day's ⏳. `when` decides which tasks this week grid shows.

![Week view = col[ week, unscheduled, drop zone ]](../assets/dsl/week.png)

```jsonc
{ "type": "week", "when": { "status": ["todo"] } }
```

- The week start follows the plugin setting. `firstDayOfWeek` (`monday` / `sunday`) is saved but **has no effect yet**.
- An `onDrop` on a week area is saved but ignored; day cells always "reschedule to that day".

> The full layout from the screenshot is in [§6 Week](#week): below the week grid sit the "Unscheduled" tray and the drop zone, side by side.

### 4.4 month: month grid

A date grid shown by month, used like `week`, with month navigation.

![Month view](../assets/dsl/month.png)

```jsonc
{ "type": "month", "when": { "status": ["todo"] } }
```

`firstDayOfWeek` and `density` (`compact` / `cards`) are saved but **have no effect yet**; on mobile the month view is always a calendar grid with dot density.

### 4.5 drop: drop zone

A drop target with no query and no task cards; `onDrop` is required (missing it raises `drop_requires_on_drop`).

```jsonc
{ "type": "drop", "onDrop": { "setStatus": "dropped" } }
```

> In the current implementation a drop area **has exactly one behaviour: mark the dropped task as dropped** (cascading to children that are still todo). Any object passes validation, so `{}`, `{ "setStatus": "done" }` or `{ "clearScheduled": true }` are all treated as "drop". Only write `{ "setStatus": "dropped" }`. A drop area's `title` is not shown.

### 4.6 unknown: the fallback

An unsupported area `type` (a typo, or a removed legacy type such as `matrix`) is **not an error**: it normalizes to `unknown`, keeps the raw JSON, and the view renders "unknown type + JSON" instead of failing to load the whole config. So a misspelled `type` won't error; it just renders a useless unknown block.

---

## 5. Mechanics

### 5.1 Filtering belongs to the area

Each list / grid / week / month area's filter is **its own `when`**, independent of the others.

- There is no Tab-wide "base set / global filter". To make a whole Tab show only `todo`, write `"status": ["todo"]` in every area's `when` (that's what the built-in views do).
- The graphical filter UI edits that area's `when` directly; it is the same data as editing the DSL.

### 5.2 onDrop: drag-and-drop writes

The write action performed when a card is dragged into an area. Write **one** key per area:

| Form | Effect | Works on |
| --- | --- | --- |
| `{ "setStatus": "dropped" }` | mark the task as dropped | `drop` |
| `{ "clearScheduled": true }` | clear the ⏳ on the dragged task's own line (the unscheduled tray) | `list` / `grid` |
| `{ "setScheduled": "2026-06-23" }` | reschedule ⏳ to that day | `list` / `grid` |

- `setScheduled` currently only takes a literal `YYYY-MM-DD`; tokens like `today` / `tomorrow` fail with an invalid-date notice on drop.
- `setStatus` on a `list` / `grid` has no effect.
- `week` / `month` don't read `onDrop`; their day cells are reschedule targets already.
- A card whose schedule is inherited from its parent (no ⏳ on its own line) is not rewritten when dropped into a `clearScheduled` area; you get a notice instead.
- `setStatus` only accepts `"dropped"`; other values are dropped. Mutual exclusion isn't validated; with several keys the "works on" rules above decide, which is hard to predict, so don't.

### 5.3 orderBy sorting

`orderBy` takes an array of tokens, applied in order as multi-level sort keys:

| Token | Meaning |
| --- | --- |
| `deadline_asc` / `deadline_desc` | by deadline, ascending / descending (no deadline last) |
| `scheduled_asc` / `scheduled_desc` | by scheduled date, ascending / descending (unscheduled last) |
| `created_desc` | by created date, newest first |
| `completed_desc` | by completion date, newest first |
| `deadline_risk` | by deadline risk: overdue → due within 3 days → later → no deadline, then by deadline ascending within a tier |
| `priority_desc` | by priority, highest first (🔺 ⏫ 🔼 🔽 ⏬, none last) |
| `title_asc` / `title_desc` | by title, alphabetical |

Tokens not in the table (e.g. `created_asc`) are saved as written but ignored when sorting.

---

## 6. Built-in views: complete examples

Below is the **actual factory DSL** of the 7 built-in views (from `src/builtin-views/*.json`, identity fields like `id` / `name` omitted); use them as templates. None has a tab-level filter; status and other conditions all live on each area's `when`.

### TODO

A single ungrouped `list`:

```jsonc
{ "view": { "layout": { "type": "list", "when": { "status": ["todo"] } } } }
```

### Today

A `col` stacking 3 lists (overdue / today / unscheduled picks), each with its own `when`:

```jsonc
{ "view": { "layout": {
  "dir": "col",
  "children": [
    { "type": "list", "id": "overdue", "title": "Overdue",
      "when": { "status": ["todo"], "time": { "deadline": "overdue" } },
      "orderBy": ["deadline_asc"], "limit": 3 },
    { "type": "list", "id": "today", "title": "Today",
      "when": { "status": ["todo"], "time": { "scheduled": "today" } }, "limit": 3 },
    { "type": "list", "id": "unscheduled-rec", "title": "Unscheduled",
      "when": { "status": ["todo"], "time": { "scheduled": "unscheduled", "deadline": "unscheduled" } },
      "orderBy": ["created_desc"], "limit": 3 }
  ]
} } }
```

### Unscheduled

`col[ list ]`, the list's `when` selecting "no schedule and todo":

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "list",
    "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
    "orderBy": ["deadline_risk", "created_desc"] }
] } } }
```

### Week

`col[ week, row[ grid(unscheduled tray), drop ] ]`:

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "week", "when": { "status": ["todo"] } },
  { "dir": "row", "children": [
    { "type": "grid", "id": "unscheduled-tray", "title": "Unscheduled",
      "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
      "onDrop": { "clearScheduled": true } },
    { "type": "drop", "title": "Drop",
      "onDrop": { "setStatus": "dropped" } }
  ] }
] } } }
```

### Month

Same as Week, with `month` on top instead:

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "month", "when": { "status": ["todo"] } },
  { "dir": "row", "children": [
    { "type": "grid", "id": "unscheduled-tray", "title": "Unscheduled",
      "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
      "onDrop": { "clearScheduled": true } },
    { "type": "drop", "title": "Drop", "onDrop": { "setStatus": "dropped" } }
  ] }
] } } }
```

### Completed

A `list`, newest-completed first:

```jsonc
{ "view": { "layout": {
  "type": "list",
  "when": { "status": ["done"] },
  "orderBy": ["completed_desc"]
} } }
```

### Dropped

A `list`, filtered on `dropped`:

```jsonc
{ "view": { "layout": { "type": "list", "when": { "status": ["dropped"] } } } }
```

---

## 7. Graphical editing ↔ DSL ↔ CLI (one shared schema)

The graphical filter UI, editing the JSON directly via "Edit Query", and managing queries from the CLI all share the same parsing and validation (US-219): changing a filter in the UI edits some area's `when`, which is exactly equivalent to writing it by hand in this JSON.

CLI commands (`obsidian task-center:<command>`, always targeting stable ids):

| Command | Purpose |
| --- | --- |
| `query-list [hidden=true] [format=json]` | list presets |
| `query-show id=<id>` | print the full normalized DSL |
| `query-run id=<id> [view=list\|week\|month] [anchor=YYYY-MM-DD] [format=json]` | run the query and show the result |
| `query-create dsl=<json>` (same as `query-save`) | create a preset, always with a new id |
| `query-update id=<id> dsl=<json>` | replace a preset wholesale, keeping its id and builtin flag |
| `query-rename` / `query-copy` / `query-hide` / `query-delete` / `query-set-default` | rename / duplicate / hide / delete / set default |

Current `query-run` behaviour:

- It only runs the **first content area** of the layout (depth-first, skipping `drop`); other areas are ignored. For a multi-segment view like Today, the CLI only prints the first segment.
- `view=` temporarily swaps the layout for a single list / week / month, reusing the first content area's `when`.
- `anchor=` picks which week / month a week or month view shows, and is the "today" for their relative tokens.

If the DSL can't be parsed or fails validation, `query-create` / `query-update` return `invalid_query` and leave existing presets untouched.

> 🖼️ **Figure TODO**: show the graphical filter popover next to the corresponding `when` JSON snippet, with the one-to-one mapping called out.

---

## 8. Design principles in brief

1. **Markdown is the single source of truth**; the DSL is only a derived layer.
2. **One view = one layout tree**; no view-type enum, and the renderer never branches on names like today / completed.
3. **Filtering belongs to the area**: each area's `when` is its entire filter, with no tab-level base set and no global filter state.
4. **Actions are general capabilities**: reschedule / clear schedule / drop are provided by cards and drop targets, not bound to a view.
5. **Unknown types don't error**: they normalize to an `unknown` fallback.
6. **No `summary`**: top-of-view metrics were removed; estimate / retro stats live in the `task-center:stats` / `review` CLI.

---

> Screenshots are from the desktop Task Center; tag names, group titles, and other text reflect each vault's real data.
