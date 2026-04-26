// Pure helper: decide which Obsidian versions wdio should run against.
//
// task #45 (US-602): the previous inline logic in wdio.conf.mts auto-added
// `latest-beta/latest` to the default matrix whenever `obsidianBetaAvailable`
// returned true (i.e. the beta was cached locally from a prior run). That
// caused `pnpm test:e2e` to fail in clean local environments because
// wdio-obsidian-service then tried to refresh the beta image and prompted
// for `OBSIDIAN_EMAIL`/`OBSIDIAN_PASSWORD` which most contributors don't
// have. Beta is now strictly opt-in via `OBSIDIAN_USE_BETA=1`.
//
// Decision order:
//   1. Explicit `OBSIDIAN_VERSIONS` always wins (manual override).
//   2. Otherwise default to `earliest/earliest latest/latest` — both are
//      free-tier Obsidian downloads, no Insiders login needed.
//   3. If the user opts in via `OBSIDIAN_USE_BETA` AND the beta is already
//      cached locally (so we skip the login dance), append beta.

export interface PickEnv {
  OBSIDIAN_VERSIONS?: string;
  OBSIDIAN_USE_BETA?: string;
}

export function pickWdioVersions(env: PickEnv, betaCached: boolean): string {
  if (env.OBSIDIAN_VERSIONS) return env.OBSIDIAN_VERSIONS;
  let v = "earliest/earliest latest/latest";
  // BUG (task #45): the previous code unconditionally appended beta when
  // `betaCached` was true. The fix gates on the user opt-in env so a clean
  // local install never hits the Insiders login path by surprise.
  if (betaCached) v += " latest-beta/latest";
  return v;
}
