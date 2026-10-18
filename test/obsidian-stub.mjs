// Minimal shim so Obsidian-dependent modules can be bundled outside Obsidian
// for unit tests. Only the pure exports we actually test need to work; the
// rest are stubs so module load doesn't throw.
export class TFile {}
export class App {}
export class Modal {}
export class PluginSettingTab {}
export class Setting {}
export class TextComponent {}
export class Notice {
  constructor() {}
}
export class Menu {}
export class ItemView {}
export class Scope {
  register() {}
  unregister() {}
}
export class Plugin {}
export function normalizePath(p) {
  return p;
}
// `Platform` is consulted in places like quickadd.ts to branch UI by
// device. For unit-testing the pure parsing logic we don't care, so the
// stub reports "desktop" — quickadd.ts's mobile branch never runs.
export const Platform = { isMobile: false, isMobileApp: false, isDesktop: true };
export function getLanguage() {
  try {
    const stored = globalThis.window?.localStorage?.getItem("language");
    if (stored) return stored;
  } catch { /* ignore */ }
  return "en";
}

// External Daily Notes date-formatting boundary.
export function moment() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return { format(pattern) {
    const tokens = { YYYY: String(d.getFullYear()), YY: String(d.getFullYear()).slice(-2), MM: pad(d.getMonth()+1), DD: pad(d.getDate()), D: String(d.getDate()), ddd: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()], HH: pad(d.getHours()), mm: pad(d.getMinutes()) };
    return pattern.replace(/YYYY|YY|MM|DD|ddd|HH|mm|D/g, token => tokens[token]);
  }};
}
