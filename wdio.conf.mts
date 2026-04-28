import * as path from "path";
import { parseObsidianVersions, obsidianBetaAvailable } from "wdio-obsidian-service";
import { env } from "process";
import { pickWdioVersions } from "./wdio-versions.mts";

const cacheDir = path.resolve(".obsidian-cache");

// task #45 (US-602): default to the stable matrix only; beta is opt-in
// via `OBSIDIAN_USE_BETA=1`. See wdio-versions.mts for rationale.
const betaCached = await obsidianBetaAvailable({ cacheDir });
const defaultVersions = pickWdioVersions(env, betaCached);
const desktopVersions = await parseObsidianVersions(defaultVersions, { cacheDir });
if (env.CI) {
  console.log("obsidian-cache-key:", JSON.stringify([desktopVersions]));
}

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",

  specs: ["./test/e2e/specs/**/*.e2e.ts"],

  // task #48 (0.3.x): default to 1 worker. Two parallel workers share the
  // same vault directory (`test/e2e/vaults/simple`), so race conditions
  // surface in `obsidianPage.resetVault` + concurrent `metadataCache.changed`
  // — the subtask and mobile-coverage specs were the canaries Engineer saw
  // intermittently fail in `pnpm test:e2e`. Stable serial runs are worth
  // the ~2s wall-clock loss vs flakey parallel. Maintainers wanting the
  // old behavior can opt back in with `WDIO_MAX_INSTANCES=2 pnpm test:e2e`,
  // which is exactly the setting CI release.yml inherits today (see also
  // task #52 Xvfb POC, which depends on this serial baseline).
  maxInstances: Number(env.WDIO_MAX_INSTANCES || 1),

  capabilities: desktopVersions.map<WebdriverIO.Capabilities>(
    ([appVersion, installerVersion]) => ({
      browserName: "obsidian",
      "wdio:obsidianOptions": {
        appVersion,
        installerVersion,
        plugins: ["."],
        vault: "test/e2e/vaults/simple",
      },
    }),
  ),

  services: ["obsidian"],
  reporters: ["obsidian"],

  mochaOpts: {
    ui: "bdd",
    timeout: 60 * 1000,
  },
  waitforInterval: 250,
  waitforTimeout: 5 * 1000,
  logLevel: "warn",

  cacheDir,

  injectGlobals: false,
};
