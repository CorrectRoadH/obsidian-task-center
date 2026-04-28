import { App, TFile, ListItemCache, CachedMetadata } from "obsidian";
import { ParsedTask, TaskStatus } from "./types";

const SCHEDULED_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const DEADLINE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const START_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/;
const DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const CANCELLED_RE = /❌\s*(\d{4}-\d{2}-\d{2})/;
const CREATED_RE = /➕\s*(\d{4}-\d{2}-\d{2})/;
// US-406: accept optional callout prefix (`> ` or `>> ` etc. with
// interleaved whitespace) so tasks living inside Obsidian callouts are
// first-class citizens — parsed, rendered on the board, and written
// back correctly. Multi-level (`>>`) callout nesting is supported by
// the `(?:>\s*)*` repetition. Writer-side callout awareness lives in
// `src/writer.ts:setCheckbox` (callout-prefix-tolerant checkbox swap).
//
// US-125 task #33: trailing `\r?` before `$` strips the carriage return
// when the line came from CRLF input (paste from external source, copy
// from a browser tab, etc.). Without this, the `\r` would land inside
// the `content` capture group, taint the task's title hash, and the
// renderer's de-dup / children filter would silently drop the task.
// see USER_STORIES.md
const CHECKBOX_RE = /^(\s*(?:>\s*)*)([-+*])\s+\[(.)\]\s?(.*?)\r?$/;
const TAG_RE = /#([^\s#\[\]()]+)/g;

// Strip emoji metadata, inline fields, tags, block anchors, and recurrence
// (`🔁 every week` style — consumed greedily to the next metadata boundary).
const META_STRIP_RE = /🔁\s*[^⏳📅🛫✅❌➕#\[\^]+|(⏳|📅|🛫|✅|❌|⌛|🔺|⏫|🔼|🔽|⏬|➕)\s*(\d{4}-\d{2}-\d{2})?/gu;
// US-108: inline-field syntax is `[fieldname:: value]` (Dataview-
// compatible). Field names are user data, not application knowledge, so
// cleanTitle strips every inline field from the rendered title while
// parseInlineFields preserves the exact field names for summaries.
// see USER_STORIES.md
const INLINE_FIELD_RE = /\[([^\[\]\n:]+)::\s*([^\]]*)\]/g;
const INLINE_FIELD_STRIP_RE = /\[[^\[\]\n:]+::\s*[^\]]*\]/g;
const TAG_STRIP_RE = /(?:^|\s)#[^\s#\[\]()]+/g;
// Obsidian block reference anchors: `^blockid` at a word boundary
const BLOCK_REF_STRIP_RE = /(?:^|\s)\^[A-Za-z0-9_-]+(?=\s|$)/g;

export function parseDurationToMinutes(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  // "90m" / "1h30m" / "1.5h" / "90" (default minutes) / "2h" / "45min"
  let total = 0;
  const hMatch = s.match(/(\d+(?:\.\d+)?)\s*h/);
  if (hMatch) total += parseFloat(hMatch[1]) * 60;
  const mMatch = s.match(/(\d+(?:\.\d+)?)\s*m(?:in)?/);
  if (mMatch) total += parseFloat(mMatch[1]);
  if (total === 0) {
    const bare = s.match(/^(\d+(?:\.\d+)?)$/);
    if (bare) total = parseFloat(bare[1]);
  }
  return total > 0 ? Math.round(total) : null;
}

export function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m - h * 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

export function parseInlineFields(content: string): {
  inlineFields: Record<string, string[]>;
  durationFields: Record<string, number>;
} {
  const inlineFields: Record<string, string[]> = {};
  const durationFields: Record<string, number> = {};
  let match: RegExpExecArray | null;
  INLINE_FIELD_RE.lastIndex = 0;
  while ((match = INLINE_FIELD_RE.exec(content)) !== null) {
    const name = match[1].trim();
    const value = match[2].trim();
    if (!name) continue;
    if (!inlineFields[name]) inlineFields[name] = [];
    inlineFields[name].push(value);
    const minutes = parseDurationToMinutes(value);
    if (minutes !== null) {
      durationFields[name] = (durationFields[name] ?? 0) + minutes;
    }
  }
  return { inlineFields, durationFields };
}

export function parseTaskLine(line: string): {
  indent: string;
  marker: string;
  checkbox: string;
  content: string;
} | null {
  const m = CHECKBOX_RE.exec(line);
  if (!m) return null;
  return { indent: m[1], marker: m[2], checkbox: m[3], content: m[4] };
}

export function statusFromCheckbox(char: string): TaskStatus {
  switch (char) {
    case " ":
      return "todo";
    case "x":
    case "X":
      return "done";
    case "-":
      return "dropped";
    case "/":
      return "in_progress";
    case ">":
      return "cancelled";
    default:
      return "custom";
  }
}

export function shortHash(input: string): string {
  // Deterministic 12-char hash (FNV-1a-ish) to avoid crypto dep
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hi = (h2 >>> 0).toString(16).padStart(8, "0");
  const lo = (h1 >>> 0).toString(16).padStart(8, "0");
  return (hi + lo).slice(0, 12);
}

export function cleanTitle(content: string): string {
  return content
    .replace(META_STRIP_RE, "")
    .replace(INLINE_FIELD_STRIP_RE, "")
    .replace(BLOCK_REF_STRIP_RE, " ")
    .replace(TAG_STRIP_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTaskFromLine(
  path: string,
  lineNumber: number,
  rawLine: string,
  listItem: ListItemCache | null,
  mtime: number,
): ParsedTask | null {
  const parsed = parseTaskLine(rawLine);
  if (!parsed) return null;
  if (listItem && listItem.task === undefined) return null;

  const content = parsed.content;
  const tagMatches = Array.from(content.matchAll(TAG_RE)).map((m) => "#" + m[1]);
  const scheduled = content.match(SCHEDULED_RE)?.[1] ?? null;
  const deadline = content.match(DEADLINE_RE)?.[1] ?? null;
  const start = content.match(START_RE)?.[1] ?? null;
  const completed = content.match(DONE_RE)?.[1] ?? null;
  const cancelled = content.match(CANCELLED_RE)?.[1] ?? null;
  const created = content.match(CREATED_RE)?.[1] ?? null;
  const { inlineFields, durationFields } = parseInlineFields(content);
  const estimate = durationFields.estimate ?? null;
  const actual = durationFields.actual ?? null;

  const cleaned = cleanTitle(content);
  const status = statusFromCheckbox(parsed.checkbox);
  const hash = shortHash(`${path}::${cleaned}`);

  return {
    id: `${path}:L${lineNumber + 1}`,
    path,
    line: lineNumber,
    indent: parsed.indent,
    checkbox: parsed.checkbox,
    status,
    title: cleaned,
    rawTitle: content,
    rawLine,
    tags: tagMatches,
    scheduled,
    deadline,
    start,
    completed,
    cancelled,
    created,
    inlineFields,
    durationFields,
    estimate,
    actual,
    parentLine: null,
    parentIndex: null,
    childrenLines: [],
    hash,
    mtime,
    inheritsTerminal: false,
  };
}

export async function parseFileTasks(
  app: App,
  file: TFile,
  content?: string,
): Promise<ParsedTask[]> {
  const cache: CachedMetadata | null = app.metadataCache.getFileCache(file);
  const listItems = cache?.listItems;
  const raw = content ?? (await app.vault.cachedRead(file));
  // US-125 task #33: split on `\r?\n` so CRLF-terminated lines don't
  // carry a trailing `\r` into per-line parsing. Belt-and-suspenders
  // with CHECKBOX_RE's `\r?$` — either alone catches the bug, both
  // together survives any future intermediate transformation that
  // re-introduces CR.
  const lines = raw.split(/\r?\n/);
  const mtime = file.stat.mtime;
  const tasks: ParsedTask[] = [];

  if (listItems && listItems.length > 0) {
    const byLine = new Map<number, ParsedTask>();
    // Include non-task list items too so we can walk ancestor status / tags for
    // `inheritsTerminal` propagation through bullet-list section headers.
    interface AncestorNode {
      line: number;
      parentLine: number; // non-negative or -1 for root
      task: string | undefined; // checkbox char or undefined for bullets
      tags: string[];
      content: string;
    }
    const allNodes = new Map<number, AncestorNode>();
    for (const li of listItems) {
      const lineNum = li.position.start.line;
      const raw = lines[lineNum];
      if (raw === undefined) continue;
      // Extract content after bullet marker (for parsing tags on non-tasks too).
      const bulletMatch = raw.match(/^\s*[-+*]\s+(?:\[.\]\s*)?(.*)$/);
      const content = bulletMatch ? bulletMatch[1] : raw;
      const tags = Array.from(content.matchAll(/#([^\s#\[\]()]+)/g)).map((m) => "#" + m[1]);
      const parent = li.parent !== undefined && li.parent >= 0 ? li.parent : -1;
      allNodes.set(lineNum, { line: lineNum, parentLine: parent, task: li.task, tags, content });

      if (li.task !== undefined) {
        const task = parseTaskFromLine(file.path, lineNum, raw, li, mtime);
        if (task) {
          task.parentIndex = li.parent;
          byLine.set(lineNum, task);
        }
      }
    }
    // Resolve parents/children among tasks only (for nested rendering)
    for (const [lineNum, task] of byLine) {
      if (task.parentIndex !== null && task.parentIndex !== undefined && task.parentIndex >= 0) {
        const parentLine = task.parentIndex;
        task.parentLine = parentLine;
        const parent = byLine.get(parentLine);
        if (parent) parent.childrenLines.push(lineNum);
      }
    }
    // Compute inheritsTerminal by walking ancestor chain through ALL list items
    const isTerminal = (node: AncestorNode): boolean => {
      if (node.task === "x" || node.task === "X" || node.task === "-") return true;
      if (node.tags.includes("#dropped")) return true;
      return false;
    };
    for (const [, task] of byLine) {
      let cursor = task.parentIndex;
      while (cursor !== null && cursor !== undefined && cursor >= 0) {
        const node = allNodes.get(cursor);
        if (!node) break;
        if (isTerminal(node)) {
          task.inheritsTerminal = true;
          break;
        }
        cursor = node.parentLine >= 0 ? node.parentLine : null;
      }
    }
    tasks.push(...Array.from(byLine.values()).sort((a, b) => a.line - b.line));
  } else {
    // Fallback: scan raw lines
    for (let i = 0; i < lines.length; i++) {
      const task = parseTaskFromLine(file.path, i, lines[i], null, mtime);
      if (task) tasks.push(task);
    }
  }
  return tasks;
}

// `parseVaultTasks` was removed in Phase 1 — vault-wide scans now live in
// `cache.ts/TaskCache.ensureAll`. Per ARCHITECTURE.md §3.3, only `cache.ts`
// is allowed to enumerate `app.vault.getMarkdownFiles()`. This module exposes
// only per-line / per-file pure parsing primitives.
