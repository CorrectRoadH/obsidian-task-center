# I18n Hardcoded English Audit

Date: 2026-04-27

This document is the report-only output for US-703. It proposes a scanner,
lists the first high-signal findings, and records why this should not become a
blocking lint gate yet.

## Goal

Find user-visible English strings in `src` that bypass the `tr(...)` / locale
table flow. The first pass should focus on high-signal UI entry points:

- `createEl`, `createDiv`, `createSpan` `text` or `placeholder` values
- `.setText(...)`
- `.setTitle(...)` / menu item titles
- `new Notice(...)`
- DOM `title` tooltips

The scanner should ignore `src/i18n.ts`, tests, comments, data attributes, CSS
class names, icons, symbols, hotkey labels, dynamic user content, and task file
content.

## First Scan

High-signal raw English candidates found by a source scan:

| File | Line | Candidate | Classification |
| --- | ---: | --- | --- |
| `src/quickadd.ts` | 183 | `text: "Esc"` | Keyboard token. Allowlist candidate. |
| `src/quickadd.ts` | 275 | `"error: " + note` | User-visible error prefix. Should move to i18n. |
| `src/view.ts` | 858 | `"scheduled estimate (hours)"` | User-visible tooltip. Should move to i18n. |
| `src/view.ts` | 1704 | `"Toggle done (Space)"` | User-visible tooltip. Should move to i18n. |
| `src/view.ts` | 1979 | `"Toggle done"` | User-visible tooltip. Should move to i18n. |

Command used for the high-signal scan:

```bash
node <<'EOF'
const fs = require("fs");
const path = require("path");
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith(".ts") && !file.endsWith("i18n.ts")) files.push(file);
  }
}
walk("src");
const patterns = [
  /\.setText\(\s*([`'"])([A-Za-z][^`'"]*)\1/g,
  /new Notice\(\s*([`'"])([A-Za-z][^`'"]*)\1/g,
  /\btitle\s*=\s*([`'"])([A-Za-z][^`'"]*)\1/g,
  /\btext\s*:\s*([`'"])([A-Za-z][^`'"]*)\1/g,
  /\bplaceholder\s*:\s*([`'"])([A-Za-z][^`'"]*)\1/g,
  /\.setTitle\(\s*([`'"])([A-Za-z][^`'"]*)\1/g,
];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (patterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(line);
    })) {
      console.log(`${file}:${i + 1}:${line.trim()}`);
    }
  }
}
EOF
```

## False Positive Buckets

A broader grep-style scan catches too much noise to be a gate today:

- Dynamic user content: task titles, saved-view names, paths, tags, grouping
  labels, source Markdown, dates, and counts.
- Icons, symbols, and keyboard tokens: `Esc`, arrows, checkboxes, emoji,
  `Space`, and shortcut hints.
- Stable machine/API strings: `data-*` attributes, command IDs, CLI verbs,
  JSON keys, CSS classes, and test selectors.
- Existing localized strings already routed through `tr(...)`.
- Tests and comments.
- Internal diagnostics that are not stable user-facing UI.

## Proposed Rule Set

Add a report-only script, for example `npm run audit:i18n`, that:

1. Parses TypeScript with an AST instead of raw regex.
2. Flags raw string literals in known user-visible sinks:
   `createEl`/`createDiv`/`createSpan` text and placeholder options,
   `.setText`, `.setTitle`, `new Notice`, and `element.title`.
3. Ignores `src/i18n.ts`, tests, non-UI infrastructure, data attributes,
   CSS classes, command IDs, and strings without alphabetic words.
4. Supports a small explicit allowlist for keyboard tokens such as `Esc` and
   symbol-only UI.
5. Prints file, line, sink type, and suggested action.

## Gate Decision

Do not add a blocking lint gate yet. The current rule set needs an AST
implementation and an allowlist before it can avoid false positives.

Recommended next step:

- Add the report-only `audit:i18n` script and commit an initial allowlist.
- Move the three tooltip/error-prefix findings above into `src/i18n.ts`.
- After the report-only output is clean and stable, decide whether to include
  it in `pnpm lint` or keep it as a release-review checklist.

