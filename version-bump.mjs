/**
 * US-601 + US-603: keep `manifest.json` and `versions.json` in lockstep
 * with `package.json`. Wired into the `version` npm lifecycle so
 * `pnpm version patch|minor|major` automatically updates all three
 * files in the version-bump commit (right before the tag commit).
 *
 * Reads:
 *   - package.json          (the canonical version after `pnpm version`)
 *   - manifest.json         (existing minAppVersion)
 *   - versions.json         (the running plugin → Obsidian version map)
 *
 * Writes:
 *   - manifest.json.version = package.json.version
 *   - versions.json[<new version>] = manifest.json.minAppVersion
 *
 * The `version` script in package.json then `git add`s these files so
 * npm folds them into the same commit as the version bump.
 */
import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`Bumped to ${targetVersion} (minAppVersion: ${manifest.minAppVersion})`);
