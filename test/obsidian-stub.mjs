// Minimal shim so writer.ts can be bundled outside Obsidian for unit tests.
// None of the symbols here are reached by the pure string helpers under test.
export class TFile {}
export class App {}
export function normalizePath(p) {
  return p;
}
