// Pure helper: decide which Obsidian versions wdio should run against.
//
// task #45 (US-602): make `pnpm test:e2e` work out of the box for any
// contributor without an Obsidian Insiders account.
//
// The previous inline logic in wdio.conf.mts defaulted to
// `earliest/earliest latest/latest` and additionally appended
// `latest-beta/latest` whenever `obsidianBetaAvailable` returned true.
// Both `earliest` and `latest-beta` paths trigger an obsidian-launcher
// login flow when the corresponding image isn't cached, so a clean
// local install would die with "Obsidian Insiders account is required".
//
// New behavior:
//   1. Explicit `OBSIDIAN_VERSIONS` wins (CI release.yml sets this; any
//      contributor wanting earliest coverage sets it manually).
//   2. Otherwise default to just `latest/latest` — a single image,
//      free-tier download, sufficient for local hand-checks.
//   3. Beta is opt-in via `OBSIDIAN_USE_BETA=1` AND requires the image
//      already in cache (so we never force a fresh download login).

export interface PickEnv {
  OBSIDIAN_VERSIONS?: string;
  OBSIDIAN_USE_BETA?: string;
}

export function pickWdioVersions(env: PickEnv, betaCached: boolean): string {
  if (env.OBSIDIAN_VERSIONS) return env.OBSIDIAN_VERSIONS;
  let v = "latest/latest";
  // Only the literal "1" enables beta. A bare truthy check (`if (env.X)`)
  // would also accept "0" / "false" since every non-empty JS string is
  // truthy — that surprised a user once and earned a PM HOLD on first
  // review (msg 28a18aa9).
  if (env.OBSIDIAN_USE_BETA === "1" && betaCached) v += " latest-beta/latest";
  return v;
}
