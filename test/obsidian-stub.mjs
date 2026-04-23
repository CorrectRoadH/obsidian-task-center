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
