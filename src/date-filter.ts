export interface DateFilterLabelOptions {
  emptyLabel: string;
  openStartLabel: string;
  openEndLabel: string;
  presets: ReadonlyMap<string, string>;
}

function compactISODate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  return `${match[2]}-${match[3]}`;
}

export function formatDateFilterLabel(value: string, options: DateFilterLabelOptions): string {
  const token = value.trim();
  if (!token) return options.emptyLabel;
  const preset = options.presets.get(token);
  if (preset) return preset;
  if (token.includes("..")) {
    const [from, to] = token.split("..", 2);
    return `${from ? compactISODate(from) : options.openStartLabel} - ${to ? compactISODate(to) : options.openEndLabel}`;
  }
  return compactISODate(token);
}
