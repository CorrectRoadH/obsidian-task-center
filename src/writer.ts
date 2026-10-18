// US-401: markdown-only — no DB, no custom on-disk format. Every write in
//          this module flows through `app.vault.process` against the same
//          `- [ ] …` text that Obsidian Tasks / Dataview / any plain-text
//          tool reads. There is no parallel store to fall out of sync.
// US-403: writes are atomic — `app.vault.process` serializes per-file
//          mutations and either commits the full new buffer or none of it.
//          A crash mid-mutation cannot leave the file in a half-written
//          state at the API layer.
// see USER_STORIES.md
import { App, TFile, normalizePath, moment } from "obsidian";
import { ParsedTask, type TaskFormatFlavor } from "./types";
import { parseTaskLine, parseTaskFromLine, formatMinutes } from "./parser";

// Re-exported so writer.test.mjs can construct TFile instances that pass
// the bundled `instanceof TFile` checks in `nestUnder` / `addTask` /
// other code paths. Same pattern as cache.ts:22 — the bundle's internal
// TFile class is distinct from any class declared in obsidian-stub.mjs,
// so test code must import from the bundle to get the right identity.
export { TFile };

export interface TaskRef {
  path: string;
  line: number;
  hash?: string;
}

export class TaskWriterError extends Error {
  code: string;
  hint: string;
  constructor(code: string, hint: string) {
    super(`${code}: ${hint}`);
    this.code = code;
    this.hint = hint;
  }
}

export function parseTaskId(id: string): { path: string; line?: number; hash?: string } {
  // Formats:
  //   "path:L42"
  //   "path:42"
  //   "hash:abcdef123456"
  //   "abcdef123456"  (12 hex chars, bare hash)
  const bareHash = id.match(/^[a-f0-9]{12}$/i);
  if (bareHash) return { path: "", hash: id };
  const hashPrefixed = id.match(/^hash:([a-f0-9]{12})$/i);
  if (hashPrefixed) return { path: "", hash: hashPrefixed[1] };
  const m = id.match(/^(.+?):L?(\d+)$/);
  if (m) return { path: m[1], line: parseInt(m[2], 10) - 1 };
  return { path: id };
}

// Reparse one line to compute the updated ParsedTask
// Inject or replace an emoji+date field (⏳ / 📅 / ✅ / 🛫 / ❌ / ➕).
// Removes all occurrences (defensively — duplicates shouldn't exist but can
// creep in from manual edits) then appends a fresh one before any trailing
// Dataview inline field. Exported for unit tests.
export function setEmojiDate(line: string, emoji: string, date: string | null): string {
  const escaped = emoji.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const re = new RegExp(`\\s*${escaped}\\s*\\d{4}-\\d{2}-\\d{2}`, "g");
  const stripped = line.replace(re, "");
  if (date === null) return stripped;
  const trailingIdx = stripped.search(/(\s*\[[a-z]+::)/i);
  const injection = ` ${emoji} ${date}`;
  if (trailingIdx === -1) {
    return stripped.trimEnd() + injection;
  }
  return stripped.slice(0, trailingIdx).trimEnd() + injection + stripped.slice(trailingIdx);
}

// Inject or replace an inline Dataview field. Exported for unit tests.
export function setInlineField(line: string, name: string, value: string | null): string {
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const re = new RegExp(`\\s*\\[${escaped}::\\s*[^\\]]*\\]`, "i");
  const stripped = line.replace(re, "");
  if (value === null) return stripped;
  return stripped.trimEnd() + ` [${name}:: ${value}]`;
}

function clearInlineFieldAll(line: string, name: string): string {
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const re = new RegExp(`\\s*\\[${escaped}::\\s*[^\\]]*\\]`, "gi");
  return line.replace(re, "");
}

export function setScheduledLine(
  line: string,
  date: string | null,
  flavor: TaskFormatFlavor = "tasks",
): string {
  return setTaskDateLine(line, "scheduled", date, flavor);
}

type TaskDateField = "scheduled" | "due" | "created" | "completion" | "cancelled";

const TASK_DATE_EMOJI: Record<TaskDateField, string> = {
  scheduled: "⏳",
  due: "📅",
  created: "➕",
  completion: "✅",
  cancelled: "❌",
};

export function setTaskDateLine(
  line: string,
  field: TaskDateField,
  date: string | null,
  flavor: TaskFormatFlavor = "tasks",
): string {
  let next = setEmojiDate(line, TASK_DATE_EMOJI[field], null);
  next = clearInlineFieldAll(next, field);
  if (date === null) return next;
  return flavor === "dataview"
    ? setInlineField(next, field, date)
    : setEmojiDate(next, TASK_DATE_EMOJI[field], date);
}

// Swap the checkbox character — accepts callout `> ` prefix(es). Exported for unit tests.
export function setCheckbox(line: string, char: string): string {
  return line.replace(/^(\s*(?:>\s*)*[-+*]\s+\[).(\])/, `$1${char}$2`);
}

function tagPattern(tag: string): RegExp {
  const bare = tag.replace(/^#/, "");
  if (!/^[\p{L}\p{N}_/-]+$/u.test(bare)) throw new TaskWriterError("invalid_arg", `invalid tag: ${tag}`);
  return new RegExp(`(^|\\s)#${bare}(?=$|\\s)`, "u");
}
export function addTagIfMissing(line: string, tag: string): string {
  if (tagPattern(tag).test(line)) return line;
  return line.trimEnd() + ` #${tag.replace(/^#/, "")}`;
}

// US-147: every mutation is line-scoped — `mutate(raw)` only sees and
//          rewrites ONE line; siblings, children, and parent lines are
//          untouched. Editing a parent therefore can't accidentally
//          mutate a child's tags / [estimate::] / [actual::] / emoji.
// US-403: the surrounding `app.vault.process` is atomic at the Obsidian
//          API level — the whole file commits or nothing does.
// see USER_STORIES.md
async function mutateLine(
  app: App,
  path: string,
  line: number,
  mutate: (raw: string) => string | null,
  expected?: string,
): Promise<{ before: string; after: string; mtime: number }> {
  const af = app.vault.getAbstractFileByPath(path);
  if (!af || !(af instanceof TFile)) {
    throw new TaskWriterError("not_found", `file missing: ${path}`);
  }
  let before = "";
  let after = "";
  await app.vault.process(af, (data) => {
    const lines = data.split("\n");
    if (line >= lines.length) {
      throw new TaskWriterError(
        "write_conflict",
        `${path}:L${line + 1} — file has only ${lines.length} lines`,
      );
    }
    const original = lines[line];
    if (expected !== undefined && original !== expected) throw new TaskWriterError("write_conflict", `${path}:L${line + 1}; reload and retry`);
    const parsed = parseTaskLine(original);
    if (!parsed) {
      throw new TaskWriterError(
        "not_found",
        `${path}:L${line + 1} — not a task line: ${original.slice(0, 60)}`,
      );
    }
    before = original;
    const mutated = mutate(original);
    if (mutated === null) {
      // no-op
      after = original;
      return data;
    }
    after = mutated;
    lines[line] = mutated;
    return lines.join("\n");
  });
  return { before, after, mtime: af.stat.mtime };
}

export async function setScheduled(
  app: App,
  task: ParsedTask,
  date: string | null,
  flavor: TaskFormatFlavor = "tasks",
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const nl = setScheduledLine(raw, date, flavor);
    return nl === raw ? null : nl;
  }, task.rawLine);
  return { before, after, unchanged: before === after };
}

export async function setDeadline(
  app: App,
  task: ParsedTask,
  date: string | null,
  flavor: TaskFormatFlavor = "tasks",
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const nl = setTaskDateLine(raw, "due", date, flavor);
    return nl === raw ? null : nl;
  }, task.rawLine);
  return { before, after, unchanged: before === after };
}

export async function setActual(
  app: App,
  task: ParsedTask,
  minutes: number,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const nl = setInlineField(raw, "actual", formatMinutes(minutes));
    return nl === raw ? null : nl;
  }, task.rawLine);
  return { before, after, unchanged: before === after };
}

export async function addToActual(
  app: App,
  task: ParsedTask,
  minutes: number,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const current = parseTaskFromLine(task.path, task.line, raw, null, task.mtime);
    if (!current || current.hash !== task.hash) throw new TaskWriterError("write_conflict", task.id);
    return setInlineField(raw, "actual", formatMinutes(Math.max(0, (current.actual ?? 0) + minutes)));
  });
  return { before, after, unchanged: before === after };
}

export async function setEstimate(
  app: App,
  task: ParsedTask,
  minutes: number | null,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const nl = setInlineField(raw, "estimate", minutes === null ? null : formatMinutes(minutes));
    return nl === raw ? null : nl;
  }, task.rawLine);
  return { before, after, unchanged: before === after };
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function markDone(
  app: App,
  task: ParsedTask,
  at: string | null,
  flavor: TaskFormatFlavor = "tasks",
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const dateStr = at ?? today();
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    if (
      /^\s*(?:>\s*)*[-+*]\s+\[[xX]\]/.test(raw) &&
      (at === null || new RegExp(`✅\\s*${dateStr}`).test(raw) ||
        new RegExp(`\\[completion::\\s*${dateStr}\\]`, "i").test(raw))
    ) {
      return null;
    }
    let nl = setCheckbox(raw, "x");
    nl = setTaskDateLine(nl, "cancelled", null);
    nl = setTaskDateLine(nl, "completion", dateStr, flavor);
    return nl === raw ? null : nl;
  }, task.rawLine);
  return { before, after, unchanged: before === after };
}

export async function markUndone(
  app: App,
  task: ParsedTask,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    if (
      !raw.includes("❌") && !/\[cancelled::/i.test(raw) &&
      /^\s*(?:>\s*)*[-+*]\s+\[\s\]/.test(raw) &&
      !/✅\s*\d{4}-\d{2}-\d{2}/.test(raw) &&
      !/\[completion::\s*\d{4}-\d{2}-\d{2}\]/i.test(raw)
    ) {
      return null;
    }
    let nl = setCheckbox(raw, " ");
    nl = setTaskDateLine(nl, "cancelled", null);
    nl = setTaskDateLine(nl, "completion", null);
    return nl === raw ? null : nl;
  }, task.rawLine);
  return { before, after, unchanged: before === after };
}

// US-305: "abandon" writes `[-] ❌ <today>` — distinct from `done` so
// retros can see what the user walked away from rather than lumping it
// into a single completion bucket. Strips legacy `#dropped` tags from a
// previous convention as a side effect (one-way migration; not added
// back on undone).
// see USER_STORIES.md
export async function markDropped(
  app: App,
  task: ParsedTask,
  at: string | null = null,
  flavor: TaskFormatFlavor = "tasks",
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const dateStr = at ?? today();
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    if (
      /^\s*(?:>\s*)*[-+*]\s+\[-\]/.test(raw) &&
      (at === null || new RegExp(`❌\\s*${dateStr}`).test(raw) ||
        new RegExp(`\\[cancelled::\\s*${dateStr}\\]`, "i").test(raw))
    ) {
      return null;
    }
    let nl = setCheckbox(raw, "-");
    nl = setTaskDateLine(nl, "completion", null);
    nl = setTaskDateLine(nl, "cancelled", dateStr, flavor);
    // Cleanup legacy: strip a pre-existing #dropped tag (old convention)
    nl = nl.replace(/\s*#dropped\b/g, "");
    return nl === raw ? null : nl;
  }, task.rawLine);
  return { before, after, unchanged: before === after };
}

/**
 * Pure helper — rebuild a task line with a new title, preserving all metadata
 * (tags, Obsidian-Tasks emoji fields, priorities, recurrence, Dataview inline
 * fields, block anchors). Returns null if `raw` isn't a task line.
 * Exported for unit testing.
 *
 * US-407: byte-level preserve of Obsidian-Tasks extension fields (🛫 start,
 * 🔁 recurrence, ⏫ priority, [id::], block anchors `^id`) on rename and
 * reschedule. Tasks-plugin-only metadata must round-trip unchanged so its
 * queries keep working after Task Center rewrites.
 * US-409: same byte-level guarantee covers everything the user typed —
 * `#hashtags`, `[xxx::]` inline-field NAMES, and the Obsidian Tasks
 * emoji markers (`⏳ 📅 ✅ ❌ ➕ 🛫 🔁 🔺⏫🔼🔽⏬`). The META_TOKEN_RE
 * below is the allow-list of suffix tokens reattached after the new
 * title — anything matched is preserved verbatim, never normalized.
 * see USER_STORIES.md
 */
export function rebuildTaskLineWithNewTitle(
  raw: string,
  newTitle: string,
): string | null {
  const parsed = parseTaskLine(raw);
  if (!parsed) return null;
  const META_TOKEN_RE =
    /#[^\s#[\] ()]+|⏳\s*\d{4}-\d{2}-\d{2}|📅\s*\d{4}-\d{2}-\d{2}|🛫\s*\d{4}-\d{2}-\d{2}|✅\s*\d{4}-\d{2}-\d{2}|❌\s*\d{4}-\d{2}-\d{2}|➕\s*\d{4}-\d{2}-\d{2}|🔁\s*[^⏳📅🛫✅❌➕#[\]^]+|[🔺⏫🔼🔽⏬]|\[[^[\n:]+::\s*[^\]]+\]|\^[A-Za-z0-9_-]+/gu;
  const tokens: string[] = [];
  let m;
  while ((m = META_TOKEN_RE.exec(parsed.content)) !== null) {
    tokens.push(m[0]);
  }
  const suffix = tokens.length > 0 ? " " + tokens.join(" ") : "";
  return `${parsed.indent}${parsed.marker} [${parsed.checkbox}] ${newTitle.trim()}${suffix}`;
}

/**
 * Rename a task's title while preserving all metadata (tags, emoji dates,
 * inline fields, block anchors). Metadata tokens are collected in the order
 * they appear, then re-appended after the new title.
 */
export async function renameTask(
  app: App,
  task: ParsedTask,
  newTitle: string,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const cleanNew = newTitle.trim();
  if (cleanNew === "") {
    throw new TaskWriterError("missing_arg", "new title cannot be empty");
  }
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const rebuilt = rebuildTaskLineWithNewTitle(raw, cleanNew);
    if (rebuilt === null) return null;
    return rebuilt === raw ? null : rebuilt;
  }, task.rawLine);
  return { before, after, unchanged: before === after };
}

export async function addTag(
  app: App,
  task: ParsedTask,
  tag: string,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const nl = addTagIfMissing(raw, tag);
    return nl === raw ? null : nl;
  }, task.rawLine);
  return { before, after, unchanged: before === after };
}

export async function removeTag(
  app: App,
  task: ParsedTask,
  tag: string,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const re = tagPattern(tag);
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const nl = raw.replace(re, "");
    return nl === raw ? null : nl;
  }, task.rawLine);
  return { before, after, unchanged: before === after };
}

export interface AddTaskOpts {
  text: string;
  targetPath?: string;
  tags?: string[];
  scheduled?: string | null;
  taskFormat?: TaskFormatFlavor;
  deadline?: string | null;
  estimate?: number | null;
  parent?: ParsedTask | null;
  checkbox?: string;
  stampCreated?: boolean;
  // Legacy no-op: kept so old callers compile, but new tasks without an
  // explicit target require a configured Daily Notes plugin.
  inboxFallback?: string;
}

function todayFilename(folder: string, format?: string): string {
  const name = moment().format(format || "YYYY-MM-DD") + ".md";
  return normalizePath(folder ? `${folder}/${name}` : name);
}

function buildTaskLine(opts: AddTaskOpts, indent: string): string {
  const parts: string[] = [`${indent}- [${opts.checkbox ?? " "}] ${opts.text.trim()}`];
  const flavor = opts.taskFormat ?? "tasks";
  if (opts.tags && opts.tags.length > 0) {
    for (const t of opts.tags) {
      const bare = t.startsWith("#") ? t.slice(1) : t;
      parts.push(`#${bare}`);
    }
  }
  if (opts.stampCreated) {
    const stamp = today();
    // US-146: skip the ➕ stamp when the parent already carries the same
    // date — the parent's stamp implies the child was created the same
    // day, so repeating it on every subtask is just noise. Cross-day
    // children still get their own ➕ for accurate retros.
    // see USER_STORIES.md
    if (opts.parent?.created !== stamp) {
      parts.push(flavor === "dataview" ? `[created:: ${stamp}]` : `➕ ${stamp}`);
    }
  }
  if (opts.deadline) {
    parts.push(flavor === "dataview" ? `[due:: ${opts.deadline}]` : `📅 ${opts.deadline}`);
  }
  if (opts.scheduled) {
    if (flavor === "dataview") parts.push(`[scheduled:: ${opts.scheduled}]`);
    else parts.push(`⏳ ${opts.scheduled}`);
  }
  if (opts.estimate) parts.push(`[estimate:: ${formatMinutes(opts.estimate)}]`);
  return parts.join(" ");
}

export async function addTask(
  app: App,
  opts: AddTaskOpts,
): Promise<{ path: string; line: number; created: string }> {
  if (!opts.text || !opts.text.trim()) {
    throw new TaskWriterError("missing_arg", "task text cannot be empty");
  }
  if (opts.parent && opts.targetPath && normalizePath(opts.targetPath) !== opts.parent.path) throw new TaskWriterError("invalid_arg", "to and parent must target the same file");
  for (const tag of opts.tags ?? []) tagPattern(tag);
  let template = "";
  let targetPath = opts.targetPath;
  if (!targetPath) {
    if (opts.parent) {
      targetPath = opts.parent.path;
    } else {
      // Priority: today's daily note. US-163 / US-701 removed the old inbox
      // fallback: when Daily Notes is disabled or has no folder, creation
      // must fail without writing to an arbitrary file.
      const dailyNotes =
        (app as unknown as {
          internalPlugins?: {
            plugins?: Record<
              string,
              { enabled?: boolean; instance?: { options?: { folder?: string; format?: string; template?: string } } }
            >;
          };
        }).internalPlugins?.plugins?.["daily-notes"];
      const dnOpts = dailyNotes?.enabled === false ? undefined : dailyNotes?.instance?.options;
      if (!dnOpts) {
        throw new TaskWriterError(
          "daily_notes_missing",
          "Daily Notes plugin is disabled; enable and configure Daily Notes before adding tasks.",
        );
      }
      if (!dnOpts.folder) {
        throw new TaskWriterError(
          "daily_notes_folder_missing",
          "Daily Notes folder is not configured; set New file location before adding tasks.",
        );
      }
      targetPath = todayFilename(dnOpts.folder, dnOpts.format);
      if (dnOpts.template && !app.vault.getAbstractFileByPath(targetPath)) {
        const templateFile = app.vault.getAbstractFileByPath(dnOpts.template.endsWith(".md") ? dnOpts.template : `${dnOpts.template}.md`);
        if (templateFile instanceof TFile) template = (await app.vault.cachedRead(templateFile)).replace(/\{\{date(?::([^}]+))?\}\}/g, (_match, format: string | undefined) => moment().format(format || dnOpts.format || "YYYY-MM-DD")).replace(/\{\{time(?::([^}]+))?\}\}/g, (_match, format: string | undefined) => moment().format(format || "HH:mm"));
      }
    }
  }
  targetPath = normalizePath(targetPath);

  const af = app.vault.getAbstractFileByPath(targetPath);
  let file: TFile;
  if (!af) {
    // Ensure folder exists
    const folder = targetPath.split("/").slice(0, -1).join("/");
    if (folder) {
      const folderObj = app.vault.getAbstractFileByPath(folder);
      if (!folderObj) {
        await app.vault.createFolder(folder).catch(() => undefined);
      }
    }
    file = await app.vault.create(targetPath, template);
  } else if (!(af instanceof TFile)) {
    throw new TaskWriterError("not_found", `target is not a file: ${targetPath}`);
  } else {
    file = af;
  }

  let insertedLine = -1;
  let createdLine = "";
  await app.vault.process(file, (data) => {
    const lines = data.split("\n");
    const indent = opts.parent
      ? pickChildIndent(lines, opts.parent.line, opts.parent.indent, opts.parent.indent.length)
      : "";
    const newLine = buildTaskLine(opts, indent);
    createdLine = newLine;
    if (opts.parent) {
      // Insert right after the parent's last descendant — `findChildrenEnd`
      // stops before any trailing blank lines so the new item stays inside
      // the parent's list (a blank gap would detach it into a sibling).
      const parent = opts.parent;
      if (lines[parent.line] !== parent.rawLine) throw new TaskWriterError("write_conflict", parent.id);
      const i = findChildrenEnd(lines, parent.line, parent.indent.length);
      insertedLine = i;
      lines.splice(i, 0, newLine);
    } else {
      // Append to end, ensuring trailing newline separation
      if (lines.length === 1 && lines[0] === "") {
        lines[0] = newLine;
        insertedLine = 0;
      } else {
        if (lines[lines.length - 1].trim() !== "") {
          lines.push(newLine);
          insertedLine = lines.length - 1;
        } else {
          lines[lines.length - 1] = newLine;
          insertedLine = lines.length - 1;
        }
      }
    }
    return lines.join("\n");
  });

  return { path: targetPath, line: insertedLine, created: createdLine };
}

// ---------- Nest (move a task to become a subtask of another) ----------

/**
 * Length of the leading indent prefix, counting whitespace AND any callout
 * markers (`>` chains). Used to compare nesting depth between lines.
 */
export function indentLen(line: string): number {
  const m = line.match(/^(\s*(?:>\s*)*)/);
  return m ? m[0].length : 0;
}

/**
 * Slice out a task's full subtree: starting at `startLine`, every following
 * line whose indent depth is greater than `parentIndentLen`. Blank lines
 * interspersed *between* descendants are kept; trailing blanks are trimmed
 * (they belong to the file structure, not the subtree).
 */
export function extractTaskBlock(
  lines: string[],
  startLine: number,
  parentIndentLen: number,
): string[] {
  let cursor = startLine + 1;
  let lastDescendantEnd = startLine + 1;
  while (cursor < lines.length) {
    const l = lines[cursor];
    if (l.trim() === "") {
      cursor++;
      continue;
    }
    if (indentLen(l) <= parentIndentLen) break;
    cursor++;
    lastDescendantEnd = cursor;
  }
  return lines.slice(startLine, lastDescendantEnd);
}

/**
 * Index in `lines` immediately after `parentLine`'s last descendant — i.e.
 * the right place to splice in a new child so it stays inside the parent's
 * list. Trailing blank lines AFTER the descendants are *not* skipped past:
 * inserting after a blank makes Obsidian's markdown parser detach the new
 * item from the list, turning it into a sibling instead of a child.
 *
 * Blank lines BETWEEN descendants are kept (we only stop on a non-blank
 * line whose indent reaches the parent's level).
 */
export function findChildrenEnd(
  lines: string[],
  parentLine: number,
  parentIndentLen: number,
): number {
  let i = parentLine + 1;
  let lastDescendantEnd = parentLine + 1;
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === "") {
      i++;
      continue;
    }
    if (indentLen(l) <= parentIndentLen) break;
    i++;
    lastDescendantEnd = i;
  }
  return lastDescendantEnd;
}

/**
 * Re-indent every line in `block`: drop the first `oldIndentLen` chars (the
 * old common prefix) and prepend `newIndent`. Descendants keep their relative
 * extra indent because we only touch the prefix portion shared with the root.
 */
export function reindentBlock(
  block: string[],
  oldIndentLen: number,
  newIndent: string,
): string[] {
  return block.map((l) => newIndent + l.slice(oldIndentLen));
}

/**
 * A reversible mutation. The forward operation replaced `before` with `after`
 * at (path, line). To undo, replace `after` with `before` — matching drift
 * is detected via the `after` lines. Empty `before`/`after` arrays model
 * pure insertions / pure deletions.
 */
export interface UndoOp {
  path: string;
  line: number;
  before: string[];
  after: string[];
}

/**
 * task #57: pick the indent string a new direct child should use under
 * `parent`. If the parent already has at least one direct child, use
 * that first child's indent verbatim — this is the only safe way to
 * survive mixed-indent files (e.g. a subtree where existing siblings
 * use `\t` but a stray sibling uses `    `; CommonMark's "deepest
 * preceding match wins" rule means any new child whose indent column
 * doesn't match the established pattern gets re-parented under the
 * last sibling whose column is `<=` the new line's column).
 *
 * If the parent has NO existing direct children, fall back to
 * `parentIndent + "    "` to preserve the prior single-child default
 * (which task #37's existing fixture relies on).
 *
 * "Direct child" here = the FIRST line below `parent.line` whose
 * `indentLen` is strictly greater than `parent.indentLen` and whose
 * indent depth would put it at parent + 1 nesting level. We just take
 * the first descendant for simplicity — deeper grandchildren are
 * always indented further than a direct child, so the first descendant
 * line is by construction either a direct child OR a grandchild. We
 * don't try to distinguish: if the first descendant is a grandchild,
 * matching its indent would over-indent and we still get the bug. The
 * heuristic that works in practice: copy whatever the FIRST line below
 * the parent uses, because in real notes that's almost always a direct
 * child line. The `parentIndent + "    "` fallback handles the empty
 * case.
 */
function pickChildIndent(
  lines: string[],
  parentLine: number,
  parentIndent: string,
  parentIndentLen: number,
): string {
  for (let i = parentLine + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (indentLen(l) <= parentIndentLen) break;
    const m = l.match(/^(\s*(?:>\s*)*)/);
    if (m) return m[0];
  }
  return parentIndent + "    ";
}

/**
 * Pure planner for the same-file nest case. Returns the post-nest file lines
 * plus the forward ops that produced them — callers feed the ops into
 * `applyUndoOps` (in reverse) to undo the change.
 *
 * US-126: rejects nests that would create a cycle — if the chosen
 * `parent.line` falls inside the child's own subtree window, throw
 * `invalid_nest` rather than reorder bytes into a self-referencing
 * tree. The `nestUnder` entry point also guards against the trivial
 * self-nest (child === parent) before reaching here.
 * see USER_STORIES.md
 */
export function planSameFileNest(
  lines: string[],
  childLine: number,
  childIndentLen: number,
  parent: { line: number; indentLen: number },
): { newLines: string[]; undoOps: Array<Omit<UndoOp, "path">> } {
  const parentIndent = (lines[parent.line] ?? "").match(/^(\s*(?:>\s*)*)/)?.[0] ?? "";
  // task #57: match existing children's indent style to survive mixed
  // tab+space files. See `pickChildIndent` for the rationale.
  const newIndent = pickChildIndent(lines, parent.line, parentIndent, parent.indentLen);
  const block = extractTaskBlock(lines, childLine, childIndentLen);
  if (parent.line >= childLine && parent.line < childLine + block.length) {
    throw new TaskWriterError("invalid_nest", "cannot nest a task under its own descendant");
  }
  // VAL-CORE-011: clear ⏳ from the moved root task only; descendants keep theirs.
  // Uses a copy so the undo ops' `before` still carries the original ⏳ for restore.
  const clearedBlock = [setScheduledLine(block[0], null), ...block.slice(1)];
  const reindented = reindentBlock(clearedBlock, childIndentLen, newIndent);
  const without = lines.slice(0, childLine).concat(lines.slice(childLine + block.length));
  const adjustedParentLine =
    childLine < parent.line ? parent.line - block.length : parent.line;
  const insertIndex = findChildrenEnd(without, adjustedParentLine, parent.indentLen);
  const newLines = without
    .slice(0, insertIndex)
    .concat(reindented)
    .concat(without.slice(insertIndex));
  return {
    newLines,
    undoOps: [
      { line: childLine, before: block, after: [] },
      { line: insertIndex, before: [], after: reindented },
    ],
  };
}

/**
 * Pure planner for the cross-file nest case. Computes both files' new content
 * and the ordered forward ops tagged by which file they touch.
 */
export function planCrossFileNest(
  childLines: string[],
  childLine: number,
  childIndentLen: number,
  parentLines: string[],
  parent: { line: number; indentLen: number },
): {
  newChildLines: string[];
  newParentLines: string[];
  undoOps: Array<{ which: "child" | "parent" } & Omit<UndoOp, "path">>;
} {
  const parentIndent = (parentLines[parent.line] ?? "").match(/^(\s*(?:>\s*)*)/)?.[0] ?? "";
  // task #57: match existing children's indent style; see same comment
  // in planSameFileNest above.
  const newIndent = pickChildIndent(parentLines, parent.line, parentIndent, parent.indentLen);
  const block = extractTaskBlock(childLines, childLine, childIndentLen);
  // VAL-CORE-011: clear ⏳ from the moved root task only; descendants keep theirs.
  // Uses a copy so the undo ops' `before` still carries the original ⏳ for restore.
  const clearedBlock = [setScheduledLine(block[0], null), ...block.slice(1)];
  const reindented = reindentBlock(clearedBlock, childIndentLen, newIndent);
  const insertIndex = findChildrenEnd(parentLines, parent.line, parent.indentLen);
  const newParentLines = parentLines
    .slice(0, insertIndex)
    .concat(reindented)
    .concat(parentLines.slice(insertIndex));
  const newChildLines = childLines
    .slice(0, childLine)
    .concat(childLines.slice(childLine + block.length));
  return {
    newChildLines,
    newParentLines,
    undoOps: [
      { which: "parent", line: insertIndex, before: [], after: reindented },
      { which: "child", line: childLine, before: block, after: [] },
    ],
  };
}

/**
 * Apply a list of forward ops *in reverse* to undo them. `files` maps path →
 * current lines; returns a new map with the ops reversed. Throws if the
 * current content at any op's line no longer matches `after` (drift guard).
 */
export function applyUndoOps(
  files: Record<string, string[]>,
  ops: UndoOp[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of Object.keys(files)) out[p] = [...files[p]];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    const lines = out[op.path];
    if (!lines) {
      throw new TaskWriterError("not_found", `undo: file missing ${op.path}`);
    }
    for (let j = 0; j < op.after.length; j++) {
      if (lines[op.line + j] !== op.after[j]) {
        throw new TaskWriterError(
          "undo_diverged",
          `content diverged at ${op.path}:L${op.line + j + 1}; mismatch during undo`,
        );
      }
    }
    out[op.path] = [
      ...lines.slice(0, op.line),
      ...op.before,
      ...lines.slice(op.line + op.after.length),
    ];
  }
  return out;
}

/**
 * Move `child` (and its entire subtree) to become a direct subtask of `parent`.
 *
 * Same-file: single atomic vault.process — cut, re-indent, insert at parent's
 * children-end, accounting for the line-number shift if child was above parent.
 *
 * Cross-file: insert into parent file FIRST, then delete from child file.
 * If the second step fails (file diverged mid-flight), the parent ends up with
 * a duplicate — the lesser evil compared to losing the source. The error
 * message names both files so the user can manually resolve.
 *
 * Cycles (parent ∈ child's subtree) and self-nest are rejected. Already a
 * direct child → unchanged.
 */
export async function nestUnder(
  app: App,
  child: ParsedTask,
  parent: ParsedTask,
): Promise<{
  before: string;
  after: string;
  unchanged: boolean;
  crossFile: boolean;
  undoOps: UndoOp[];
}> {
  if (child.id === parent.id) {
    throw new TaskWriterError("invalid_nest", "cannot nest a task under itself");
  }
  if (child.path === parent.path && child.parentLine === parent.line) {
    // US-125 / US-148: dragging an already-nested independent-date child
    // back onto its visible parent means "ride with the parent again".
    // The physical parent is already correct, but the child's own ⏳ still
    // breaks it out as a standalone card, so clear only that root line.
    if (child.scheduled !== null) {
      const r = await setScheduled(app, child, null);
      return {
        before: r.before,
        after: r.after,
        unchanged: r.unchanged,
        crossFile: false,
        undoOps: r.unchanged
          ? []
          : [{ path: child.path, line: child.line, before: [r.before], after: [r.after] }],
      };
    }
    return {
      before: child.rawLine,
      after: child.rawLine,
      unchanged: true,
      crossFile: false,
      undoOps: [],
    };
  }

  const childIndentLen = child.indent.length;

  if (child.path === parent.path) {
    const file = app.vault.getAbstractFileByPath(child.path);
    if (!(file instanceof TFile)) {
      throw new TaskWriterError("not_found", `file: ${child.path}`);
    }
    let before = "";
    let after = "";
    let capturedOps: UndoOp[] = [];
    await app.vault.process(file, (data) => {
      const lines = data.split("\n");
      if (lines[child.line] !== child.rawLine || lines[parent.line] !== parent.rawLine) throw new TaskWriterError("write_conflict", child.id);
      const plan = planSameFileNest(lines, child.line, childIndentLen, {
        line: parent.line,
        indentLen: parent.indent.length,
      });
      const block = extractTaskBlock(lines, child.line, childIndentLen);
      const reindented = plan.undoOps[1].after;
      before = block.join("\n");
      after = reindented.join("\n");
      capturedOps = plan.undoOps.map((op) => ({ ...op, path: child.path }));
      return plan.newLines.join("\n");
    });
    return { before, after, unchanged: false, crossFile: false, undoOps: capturedOps };
  }

  // Cross-file: read source snapshot, insert into target, then delete from source.
  const childFile = app.vault.getAbstractFileByPath(child.path);
  const parentFile = app.vault.getAbstractFileByPath(parent.path);
  if (!(childFile instanceof TFile)) {
    throw new TaskWriterError("not_found", `child file: ${child.path}`);
  }
  if (!(parentFile instanceof TFile)) {
    throw new TaskWriterError("not_found", `parent file: ${parent.path}`);
  }

  const childData = await app.vault.cachedRead(childFile);
  const childLinesSnapshot = childData.split("\n");
  if (childLinesSnapshot[child.line] !== child.rawLine) {
    throw new TaskWriterError(
      "write_conflict",
      `${child.path}:L${child.line + 1} content drifted; reload tasks and retry`,
    );
  }
  const block = extractTaskBlock(childLinesSnapshot, child.line, childIndentLen);
  // VAL-CORE-011: clear ⏳ from the moved root task only; descendants keep theirs.
  // Uses a copy so the child-file delete step still matches the original block.
  const clearedBlock = [setScheduledLine(block[0], null), ...block.slice(1)];

  // Step 1: append to parent file (verifies parent line still matches).
  // task #57: defer the new-child indent decision until we have the
  // parent file's lines in hand so `pickChildIndent` can match the
  // existing children's indent style (TAB vs 4-space) instead of
  // hard-coding `parent.indent + "    "`. This was the runtime
  // duplicate path that the planner-only fix in 087fcbc missed —
  // reviewer caught it in mandatory review (msg `1e4304ab`).
  let parentInsertIndex = -1;
  let reindented: string[] = [];
  await app.vault.process(parentFile, (data) => {
    const lines = data.split("\n");
    if (lines[parent.line] !== parent.rawLine) {
      throw new TaskWriterError(
        "write_conflict",
        `${parent.path}:L${parent.line + 1} content drifted; reload tasks and retry`,
      );
    }
    const newIndent = pickChildIndent(
      lines,
      parent.line,
      parent.indent,
      parent.indent.length,
    );
    reindented = reindentBlock(clearedBlock, childIndentLen, newIndent);
    const insertIndex = findChildrenEnd(lines, parent.line, parent.indent.length);
    parentInsertIndex = insertIndex;
    return lines
      .slice(0, insertIndex)
      .concat(reindented)
      .concat(lines.slice(insertIndex))
      .join("\n");
  });

  // Step 2: delete from child file. If the lines diverged since the snapshot,
  // bail out with a message naming both files — the parent now has a duplicate
  // the user must reconcile manually.
  try {
    await app.vault.process(childFile, (data) => {
      const lines = data.split("\n");
      for (let i = 0; i < block.length; i++) {
        if (lines[child.line + i] !== block[i]) {
          throw new TaskWriterError(
            "nest_partial",
            `nested into ${parent.path}:L${parentInsertIndex + 1} but ${child.path}:L${child.line + i + 1} drifted; remove the old duplicate manually`,
          );
        }
      }
      return lines
        .slice(0, child.line)
        .concat(lines.slice(child.line + block.length))
        .join("\n");
    });
  } catch (e) {
    if (e instanceof TaskWriterError) throw e;
    throw new TaskWriterError(
      "nest_partial",
      `nested into ${parent.path}:L${parentInsertIndex + 1} but failed to remove ${child.path}:L${child.line + 1}; remove the old duplicate manually: ${(e as Error).message}`,
    );
  }

  return {
    before: block.join("\n"),
    after: reindented.join("\n"),
    unchanged: false,
    crossFile: true,
    undoOps: [
      { path: parent.path, line: parentInsertIndex, before: [], after: reindented },
      { path: child.path, line: child.line, before: block, after: [] },
    ],
  };
}

// task #32 (0.3.0 breaking): the previous `moveSubtaskToDate(app, subtask,
// targetDate, allTasks, dailyFolder)` helper required a `dailyFolder`
// string parameter — the only call-site path was the now-removed
// `settings.dailyFolder`. The helper was already unused (no in-tree
// caller) by 0.2.x, so 0.3.0 deletes it entirely rather than leaving a
// deprecated-but-callable export. If a future flow needs the same move,
// reintroduce it reading the daily-notes folder via the same lookup as
// `addTask` (see `dailyFolderFromObsidian`-style accessor on `app`).

export { parseDurationToMinutes, formatMinutes } from "./parser";
