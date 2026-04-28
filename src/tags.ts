// US-151: card tag rows display the markdown tags users actually wrote.
// Keep this tiny helper pure so view rendering and tests share the same
// de-dup / preservation rule.
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
