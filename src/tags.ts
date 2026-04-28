// US-151: card tag rows display the markdown tags users actually wrote.
// Keep these helpers pure so parser, Quick Add, view rendering, and tests
// share the same de-dup / preservation rule.

const WIKILINK_RE = /\[\[[^\]]*\]\]/g;
const INLINE_CODE_RE = /`[^`]*`/g;
const TAG_BODY = String.raw`[\p{L}\p{N}_/-]+`;
const TAG_RE = new RegExp(String.raw`(^|[^\p{L}\p{N}_/-])#(${TAG_BODY})`, "gu");

function maskNonTagContexts(input: string): string {
  return input
    .replace(WIKILINK_RE, (m) => " ".repeat(m.length))
    .replace(INLINE_CODE_RE, (m) => " ".repeat(m.length));
}

// US-108/109d: tags are markdown hashtags, not every `#` fragment.
// Excludes Obsidian block refs (`#^abc`), wikilink anchors, inline code,
// and prose glued by CJK / Latin punctuation.
export function extractMarkdownTags(input: string): string[] {
  const masked = maskNonTagContexts(input);
  const out: string[] = [];
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(masked)) !== null) {
    out.push(`#${match[2]}`);
  }
  return out;
}

export function stripMarkdownTags(input: string): string {
  const masked = maskNonTagContexts(input);
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(masked)) !== null) {
    const prefix = match[1] ?? "";
    const hashIndex = match.index + prefix.length;
    out += input.slice(last, hashIndex);
    last = hashIndex + match[2].length + 1;
    while (last < input.length && "、。，,.；;：:!?！？".includes(input[last])) last++;
  }
  out += input.slice(last);
  return out;
}

export function taskDisplayTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    const display = tag.startsWith("#") ? tag : `#${tag}`;
    if (seen.has(display)) continue;
    seen.add(display);
    out.push(display);
  }
  return out;
}
