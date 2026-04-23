import { App, TFile, ListItemCache, CachedMetadata } from "obsidian";
import { ParsedTask, TaskStatus } from "./types";

const SCHEDULED_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const DEADLINE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const START_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/;
const DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const CANCELLED_RE = /❌\s*(\d{4}-\d{2}-\d{2})/;
const CREATED_RE = /➕\s*(\d{4}-\d{2}-\d{2})/;
const ESTIMATE_RE = /\[estimate::\s*([^\]]+)\]/i;
const ACTUAL_RE = /\[actual::\s*([^\]]+)\]/i;
const CHECKBOX_RE = /^(\s*)([-+*])\s+\[(.)\]\s?(.*)$/;
const TAG_RE = /#([^\s#\[\]()]+)/g;

// Strip emoji metadata, inline fields, and tags from title for display
const META_STRIP_RE = /(⏳|📅|🛫|✅|❌|⌛|🔁|🔺|⏫|🔼|🔽|⏬|➕)\s*(\d{4}-\d{2}-\d{2})?/g;
const INLINE_FIELD_STRIP_RE = /\[(estimate|actual|priority|id|recurrence)::\s*[^\]]+\]/gi;
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
  const estimate = parseDurationToMinutes(content.match(ESTIMATE_RE)?.[1] ?? null);
  const actual = parseDurationToMinutes(content.match(ACTUAL_RE)?.[1] ?? null);

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
    estimate,
    actual,
    parentLine: null,
    parentIndex: null,
    childrenLines: [],
    hash,
    mtime,
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
  const lines = raw.split("\n");
  const mtime = file.stat.mtime;
  const tasks: ParsedTask[] = [];

  if (listItems && listItems.length > 0) {
    const byLine = new Map<number, ParsedTask>();
    for (const li of listItems) {
      if (li.task === undefined) continue;
      const lineNum = li.position.start.line;
      const line = lines[lineNum];
      if (line === undefined) continue;
      const task = parseTaskFromLine(file.path, lineNum, line, li, mtime);
      if (task) {
        // Obsidian convention: `li.parent` is the parent's LINE NUMBER.
        //   Non-negative → parent exists at that line
        //   Negative     → no parent; `-(line+1)` encodes the first item of the list
        task.parentIndex = li.parent;
        byLine.set(lineNum, task);
      }
    }
    // Resolve parents/children using line numbers
    for (const [lineNum, task] of byLine) {
      if (task.parentIndex !== null && task.parentIndex !== undefined && task.parentIndex >= 0) {
        const parentLine = task.parentIndex;
        task.parentLine = parentLine;
        const parent = byLine.get(parentLine);
        if (parent) parent.childrenLines.push(lineNum);
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

export async function parseVaultTasks(app: App): Promise<ParsedTask[]> {
  const files = app.vault.getMarkdownFiles();
  const all: ParsedTask[] = [];
  for (const f of files) {
    try {
      const fileTasks = await parseFileTasks(app, f);
      all.push(...fileTasks);
    } catch (e) {
      console.warn(`[better-task] parse failed for ${f.path}:`, e);
    }
  }
  return all;
}
