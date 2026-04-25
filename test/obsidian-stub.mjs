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
export class Plugin {}
export function normalizePath(p) {
  return p;
}
// `Platform` is consulted in places like quickadd.ts to branch UI by
// device. For unit-testing the pure parsing logic we don't care, so the
// stub reports "desktop" — quickadd.ts's mobile branch never runs.
export const Platform = { isMobile: false, isMobileApp: false, isDesktop: true };
