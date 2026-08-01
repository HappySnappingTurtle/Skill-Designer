import process from "node:process";
import {
  defaultDataDirectory,
  findChromeExecutable,
  nodeVersionSupported,
  probeWritableDirectory,
  readReleaseManifest,
  releasePlatformMatchesRuntime,
  releaseRoot,
  releaseTrustFromManifest,
  verifyReleaseFiles
} from "./release-common.mjs";

const root = releaseRoot(import.meta.url);
const dataDir = argumentValue("--data-dir") ?? defaultDataDirectory();
let manifest;
let integrity = { valid: false, checkedFiles: 0, totalBytes: 0, mismatches: [{ code: "manifest_unreadable" }] };
try {
  manifest = await readReleaseManifest(root);
  integrity = await verifyReleaseFiles(root, manifest);
} catch (error) {
  integrity = { ...integrity, mismatches: [{ code: "manifest_unreadable", message: error instanceof Error ? error.message : String(error) }] };
}
const dataDirectory = await probeWritableDirectory(dataDir);
const platformMatchesRuntime = manifest ? releasePlatformMatchesRuntime(manifest.targetPlatform) : false;
const chromePath = await findChromeExecutable();
const result = {
  schemaVersion: "1.0",
  product: "Skill Designer",
  package: manifest ? { version: manifest.version, targetPlatform: manifest.targetPlatform, releaseChannel: manifest.releaseChannel, platformMatchesRuntime } : null,
  releaseTrust: manifest ? releaseTrustFromManifest(manifest) : null,
  runtime: { platform: process.platform, arch: process.arch, node: process.versions.node, nodeSupported: nodeVersionSupported() },
  integrity,
  dataDirectory,
  chrome: { found: Boolean(chromePath), path: chromePath },
  benchmark: {
    dockerRequired: true,
    runnerImageConfigured: Boolean(process.env.SKILL_DESIGNER_SANDBOX_IMAGE),
    providerKeyConfigured: Boolean(process.env.OPENAI_API_KEY || process.env.SKILL_DESIGNER_OPENAI_API_KEY)
  }
};
console.log(JSON.stringify(result, null, 2));
if (!result.runtime.nodeSupported || !platformMatchesRuntime || !integrity.valid || !dataDirectory.writable || !result.chrome.found) process.exitCode = 1;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
