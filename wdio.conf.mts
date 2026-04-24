import * as path from "path";
import { parseObsidianVersions, obsidianBetaAvailable } from "wdio-obsidian-service";
import { env } from "process";

const cacheDir = path.resolve(".obsidian-cache");

let defaultVersions = "earliest/earliest latest/latest";
if (await obsidianBetaAvailable({ cacheDir })) {
  defaultVersions += " latest-beta/latest";
}
const desktopVersions = await parseObsidianVersions(
  env.OBSIDIAN_VERSIONS ?? defaultVersions,
  { cacheDir },
);
if (env.CI) {
  console.log("obsidian-cache-key:", JSON.stringify([desktopVersions]));
}

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",

  specs: ["./test/e2e/specs/**/*.e2e.ts"],

  maxInstances: Number(env.WDIO_MAX_INSTANCES || 2),

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
