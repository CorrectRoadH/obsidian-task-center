function normalizeTag(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

export function parseGroupingTagsInput(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\s]+/)) {
    const tag = normalizeTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 9) break;
  }
  return out;
}

export function normalizeGroupingTags(tags: string[] | undefined | null): string[] {
  if (tags == null) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 9) break;
  }
  return out;
}

export function findGroupingTag(taskTags: string[], groupingTags: string[]): string | null {
  for (const tag of groupingTags) {
    if (taskTags.includes(tag)) return tag;
  }
  return null;
}

export function groupingTagIndex(taskTags: string[], groupingTags: string[]): number {
  const tag = findGroupingTag(taskTags, groupingTags);
  return tag ? groupingTags.indexOf(tag) : -1;
}

export function groupingTagForKey(key: string, groupingTags: string[]): string | null {
  const index = Number(key) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= groupingTags.length) return null;
  return groupingTags[index] ?? null;
}

export function groupingChipLabel(tag: string, index: number): string {
  const legacy = tag.match(/^#([1-9])象限$/);
  if (legacy) return `Q${legacy[1]}`;
  const plain = tag.replace(/^#/, "");
  return plain || `Group ${index + 1}`;
}

export function cliGroupingLabel(taskTags: string[], groupingTags: string[]): string {
  const index = groupingTagIndex(taskTags, groupingTags);
  if (index < 0) return "  ";
  return `#${index + 1}`;
}
