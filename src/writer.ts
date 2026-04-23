import { App, TFile, normalizePath } from "obsidian";
import { ParsedTask } from "./types";
import { parseTaskLine, cleanTitle, shortHash, parseDurationToMinutes, formatMinutes } from "./parser";

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

export async function resolveTaskRef(
  app: App,
  id: string,
  allTasks: ParsedTask[],
): Promise<ParsedTask | null> {
  const parsed = parseTaskId(id);
  if (parsed.hash) {
    const matches = allTasks.filter((t) => t.hash === parsed.hash);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new TaskWriterError(
        "ambiguous_slug",
        `hash ${parsed.hash} matches ${matches.length} tasks: ${matches.map((t) => t.id).join(", ")}`,
      );
    }
    return matches[0];
  }
  if (parsed.path && parsed.line !== undefined) {
    const direct = allTasks.find(
      (t) => t.path === parsed.path && t.line === parsed.line,
    );
    if (direct) return direct;
    // fallback: try same path, closest line, but require a task line present
    const file = app.vault.getAbstractFileByPath(parsed.path);
    if (!file || !(file instanceof TFile)) {
      throw new TaskWriterError("task_not_found", `file not found: ${parsed.path}`);
    }
    throw new TaskWriterError(
      "task_not_found",
      `${parsed.path}:L${parsed.line + 1} is not a task line. Use \`better-task list\` to find valid refs.`,
    );
  }
  return null;
}

// Reparse one line to compute the updated ParsedTask
// Inject or replace an emoji+date field (⏳ / 📅 / ✅ / 🛫)
function setEmojiDate(line: string, emoji: string, date: string | null): string {
  const escaped = emoji.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const re = new RegExp(`\\s*${escaped}\\s*\\d{4}-\\d{2}-\\d{2}`);
  const stripped = line.replace(re, "");
  if (date === null) return stripped;
  // Inject before any existing inline fields + before trailing whitespace
  // Simple: append before a trailing inline field bracket or at end.
  const trailingIdx = stripped.search(/(\s*\[[a-z]+::)/i);
  const injection = ` ${emoji} ${date}`;
  if (trailingIdx === -1) {
    return stripped.trimEnd() + injection;
  }
  return stripped.slice(0, trailingIdx).trimEnd() + injection + stripped.slice(trailingIdx);
}

// Inject or replace an inline Dataview field
function setInlineField(line: string, name: string, value: string | null): string {
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const re = new RegExp(`\\s*\\[${escaped}::\\s*[^\\]]*\\]`, "i");
  const stripped = line.replace(re, "");
  if (value === null) return stripped;
  return stripped.trimEnd() + ` [${name}:: ${value}]`;
}

function setCheckbox(line: string, char: string): string {
  return line.replace(/^(\s*[-+*]\s+\[).(\])/, `$1${char}$2`);
}

function addTagIfMissing(line: string, tag: string): string {
  const bare = tag.startsWith("#") ? tag.slice(1) : tag;
  const re = new RegExp(`#${bare}(?:\\b|$)`);
  if (re.test(line)) return line;
  return line.trimEnd() + ` #${bare}`;
}

async function mutateLine(
  app: App,
  path: string,
  line: number,
  mutate: (raw: string) => string | null,
): Promise<{ before: string; after: string; mtime: number }> {
  const af = app.vault.getAbstractFileByPath(path);
  if (!af || !(af instanceof TFile)) {
    throw new TaskWriterError("task_not_found", `file missing: ${path}`);
  }
  let before = "";
  let after = "";
  await app.vault.process(af, (data) => {
    const lines = data.split("\n");
    if (line >= lines.length) {
      throw new TaskWriterError(
        "task_not_found",
        `${path}:L${line + 1} — file has only ${lines.length} lines`,
      );
    }
    const original = lines[line];
    const parsed = parseTaskLine(original);
    if (!parsed) {
      throw new TaskWriterError(
        "task_not_found",
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
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const nl = setEmojiDate(raw, "⏳", date);
    return nl === raw ? null : nl;
  });
  return { before, after, unchanged: before === after };
}

export async function setDeadline(
  app: App,
  task: ParsedTask,
  date: string | null,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const nl = setEmojiDate(raw, "📅", date);
    return nl === raw ? null : nl;
  });
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
  });
  return { before, after, unchanged: before === after };
}

export async function addToActual(
  app: App,
  task: ParsedTask,
  minutes: number,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const current = task.actual ?? 0;
  return setActual(app, task, current + minutes);
}

export async function setEstimate(
  app: App,
  task: ParsedTask,
  minutes: number | null,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const nl = setInlineField(raw, "estimate", minutes === null ? null : formatMinutes(minutes));
    return nl === raw ? null : nl;
  });
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
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const dateStr = at ?? today();
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    if (/^\s*[-+*]\s+\[[xX]\]/.test(raw) && new RegExp(`✅\\s*${dateStr}`).test(raw)) {
      return null;
    }
    let nl = setCheckbox(raw, "x");
    nl = setEmojiDate(nl, "✅", dateStr);
    return nl === raw ? null : nl;
  });
  return { before, after, unchanged: before === after };
}

export async function markUndone(
  app: App,
  task: ParsedTask,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    if (/^\s*[-+*]\s+\[\s\]/.test(raw) && !/✅\s*\d{4}-\d{2}-\d{2}/.test(raw)) {
      return null;
    }
    let nl = setCheckbox(raw, " ");
    nl = setEmojiDate(nl, "✅", null);
    return nl === raw ? null : nl;
  });
  return { before, after, unchanged: before === after };
}

export async function markDropped(
  app: App,
  task: ParsedTask,
  at: string | null = null,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const dateStr = at ?? today();
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    if (
      /^\s*[-+*]\s+\[-\]/.test(raw) &&
      new RegExp(`❌\\s*${dateStr}`).test(raw)
    ) {
      return null;
    }
    let nl = setCheckbox(raw, "-");
    nl = setEmojiDate(nl, "❌", dateStr);
    // Cleanup legacy: strip a pre-existing #dropped tag (old convention)
    nl = nl.replace(/\s*#dropped\b/g, "");
    return nl === raw ? null : nl;
  });
  return { before, after, unchanged: before === after };
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
    throw new TaskWriterError("invalid_date", "new title cannot be empty");
  }
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const parsed = parseTaskLine(raw);
    if (!parsed) return null;
    // Preserve-in-order tokens: tags, Obsidian-Tasks emoji fields, priority
    // markers (🔺⏫🔼🔽⏬), recurrence (🔁 … until next metadata), Dataview
    // inline fields, and block reference anchors. Order within the line is
    // kept from the original.
    const META_TOKEN_RE =
      /#[^\s#\[\]()]+|⏳\s*\d{4}-\d{2}-\d{2}|📅\s*\d{4}-\d{2}-\d{2}|🛫\s*\d{4}-\d{2}-\d{2}|✅\s*\d{4}-\d{2}-\d{2}|❌\s*\d{4}-\d{2}-\d{2}|➕\s*\d{4}-\d{2}-\d{2}|🔁\s*[^⏳📅🛫✅❌➕#\[\^]+|[🔺⏫🔼🔽⏬]|\[(?:estimate|actual|priority|id|recurrence)::\s*[^\]]+\]|\^[A-Za-z0-9_-]+/gu;
    const tokens: string[] = [];
    let m;
    while ((m = META_TOKEN_RE.exec(parsed.content)) !== null) {
      tokens.push(m[0]);
    }
    const suffix = tokens.length > 0 ? " " + tokens.join(" ") : "";
    const rebuilt = `${parsed.indent}${parsed.marker} [${parsed.checkbox}] ${cleanNew}${suffix}`;
    return rebuilt === raw ? null : rebuilt;
  });
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
  });
  return { before, after, unchanged: before === after };
}

export async function removeTag(
  app: App,
  task: ParsedTask,
  tag: string,
): Promise<{ before: string; after: string; unchanged: boolean }> {
  const bare = tag.startsWith("#") ? tag.slice(1) : tag;
  const re = new RegExp(`\\s*#${bare.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?=\\b|$)`);
  const { before, after } = await mutateLine(app, task.path, task.line, (raw) => {
    const nl = raw.replace(re, "");
    return nl === raw ? null : nl;
  });
  return { before, after, unchanged: before === after };
}

export interface AddTaskOpts {
  text: string;
  targetPath?: string;
  tags?: string[];
  scheduled?: string | null;
  deadline?: string | null;
  estimate?: number | null;
  parent?: ParsedTask | null;
  checkbox?: string;
  stampCreated?: boolean;
  // Fallback target when no targetPath, no parent, and no daily note exists.
  // Typically plugin.settings.inboxPath (default "Tasks/Inbox.md").
  inboxFallback?: string;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function todayFilename(folder: string, format?: string): string {
  const d = new Date();
  // Respect the daily-notes plugin's moment-style format if provided. Subset
  // of tokens that covers virtually all real-world daily-note formats.
  // Unsupported tokens fall through to a literal YYYY-MM-DD.
  let name: string;
  if (format) {
    name = format
      .replace(/YYYY/g, d.getFullYear().toString())
      .replace(/YY/g, String(d.getFullYear()).slice(-2))
      .replace(/MM/g, pad(d.getMonth() + 1))
      .replace(/DD/g, pad(d.getDate()))
      .replace(/D/g, String(d.getDate()))
      .replace(/ddd/g, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()])
      + ".md";
  } else {
    name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`;
  }
  return normalizePath(folder ? `${folder}/${name}` : name);
}

function buildTaskLine(opts: AddTaskOpts, indent: string): string {
  const parts: string[] = [`${indent}- [${opts.checkbox ?? " "}] ${opts.text.trim()}`];
  if (opts.tags && opts.tags.length > 0) {
    for (const t of opts.tags) {
      const bare = t.startsWith("#") ? t.slice(1) : t;
      parts.push(`#${bare}`);
    }
  }
  if (opts.stampCreated) parts.push(`➕ ${today()}`);
  if (opts.deadline) parts.push(`📅 ${opts.deadline}`);
  if (opts.scheduled) parts.push(`⏳ ${opts.scheduled}`);
  if (opts.estimate) parts.push(`[estimate:: ${formatMinutes(opts.estimate)}]`);
  return parts.join(" ");
}

export async function addTask(
  app: App,
  opts: AddTaskOpts,
): Promise<{ path: string; line: number; created: string }> {
  let targetPath = opts.targetPath;
  if (!targetPath) {
    if (opts.parent) {
      targetPath = opts.parent.path;
    } else {
      // Priority: today's daily note → inbox fallback ("Tasks/Inbox.md")
      const dnOpts =
        (app as unknown as {
          internalPlugins?: {
            plugins?: Record<
              string,
              { instance?: { options?: { folder?: string; format?: string } } }
            >;
          };
        }).internalPlugins?.plugins?.["daily-notes"]?.instance?.options;
      const dailyEnabled = !!dnOpts;
      if (dailyEnabled) {
        targetPath = todayFilename(dnOpts?.folder ?? "", dnOpts?.format);
      } else {
        targetPath = opts.inboxFallback ?? "Tasks/Inbox.md";
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
    file = await app.vault.create(targetPath, "");
  } else if (!(af instanceof TFile)) {
    throw new TaskWriterError("task_not_found", `target is not a file: ${targetPath}`);
  } else {
    file = af;
  }

  let indent = "";
  if (opts.parent) {
    indent = opts.parent.indent + "    ";
  }
  const newLine = buildTaskLine(opts, indent);

  let insertedLine = -1;
  await app.vault.process(file, (data) => {
    const lines = data.split("\n");
    if (opts.parent) {
      // Insert right after parent's children block
      const parent = opts.parent;
      // Find last descendant line by scanning forward while indent depth >= parent indent + 1
      const parentIndentLen = parent.indent.length;
      let i = parent.line + 1;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") {
          i++;
          continue;
        }
        const m = l.match(/^(\s*)/);
        const lineIndent = m ? m[1].length : 0;
        if (lineIndent <= parentIndentLen) break;
        i++;
      }
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

  return { path: targetPath, line: insertedLine, created: newLine };
}

export async function moveSubtaskToDate(
  app: App,
  subtask: ParsedTask,
  targetDate: string,
  allTasks: ParsedTask[],
  dailyFolder: string,
): Promise<{ newPath: string; newLine: number }> {
  // Find parent
  const parent = subtask.parentLine !== null
    ? allTasks.find((t) => t.path === subtask.path && t.line === subtask.parentLine)
    : null;

  const targetPath = normalizePath(`${dailyFolder}/${targetDate}.md`);
  // Strike old
  await mutateLine(app, subtask.path, subtask.line, (raw) => {
    if (/^\s*[-+*]\s+\[-\]/.test(raw)) return null;
    return setCheckbox(raw, "-");
  });

  // Add new in target daily with parent wikilink
  const newTitle = parent
    ? `[[${parent.path.replace(/\.md$/, "")}]] > ${subtask.title}`
    : subtask.title;
  return addTask(app, {
    text: newTitle,
    targetPath,
    scheduled: targetDate,
    estimate: subtask.estimate,
    tags: subtask.tags,
  }).then((r) => ({ newPath: r.path, newLine: r.line }));
}

export { parseDurationToMinutes, formatMinutes } from "./parser";
