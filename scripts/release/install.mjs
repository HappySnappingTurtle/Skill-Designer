import { cp, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  assertSafeReleaseRoot,
  defaultInstallDirectory,
  pathExists,
  readReleaseManifest,
  releasePlatformMatchesRuntime,
  releaseRoot,
  removeExactDirectory,
  verifyReleaseFiles
} from "./release-common.mjs";

const source = releaseRoot(import.meta.url);
const sourceManifest = await assertSafeReleaseRoot(source);
if (!releasePlatformMatchesRuntime(sourceManifest.targetPlatform)) {
  throw new Error(`发布包目标平台 ${sourceManifest.targetPlatform} 与当前运行平台 ${process.platform} 不匹配`);
}
const sourceVerification = await verifyReleaseFiles(source, sourceManifest);
if (!sourceVerification.valid) {
  throw new Error(`安装源校验失败：${sourceVerification.mismatches.map((item) => `${item.path}:${item.code}`).join(", ")}`);
}
const target = path.resolve(argumentValue("--target") ?? defaultInstallDirectory());
if (target === source || target.startsWith(`${source}${path.sep}`) || source.startsWith(`${target}${path.sep}`)) throw new Error("安装目标不能与解压目录互相包含");

const parent = path.dirname(target);
const staging = path.join(parent, `.${path.basename(target)}.install-${process.pid}`);
const backup = path.join(parent, `.${path.basename(target)}.backup-${process.pid}`);
await mkdir(parent, { recursive: true });
await removeExactDirectory(staging);
await removeExactDirectory(backup);

let previousMoved = false;
try {
  if (await pathExists(target)) {
    const existing = await readReleaseManifest(target).catch(() => null);
    if (!existing || existing.product !== "Skill Designer") throw new Error(`目标已存在且不是可识别的 Skill Designer：${target}`);
  }
  await cp(source, staging, { recursive: true, dereference: true, preserveTimestamps: false });
  const copied = await readReleaseManifest(staging);
  const verification = await verifyReleaseFiles(staging, copied);
  if (!verification.valid) throw new Error(`安装副本校验失败：${verification.mismatches.map((item) => `${item.path}:${item.code}`).join(", ")}`);
  if (await pathExists(target)) {
    await rename(target, backup);
    previousMoved = true;
  }
  await rename(staging, target);
  await removeExactDirectory(backup);
  console.log(JSON.stringify({
    installed: true,
    product: sourceManifest.product,
    version: sourceManifest.version,
    targetPlatform: sourceManifest.targetPlatform,
    platformMatchesRuntime: true,
    releaseChannel: sourceManifest.releaseChannel,
    target,
    dataPreserved: true
  }, null, 2));
} catch (error) {
  await removeExactDirectory(staging).catch(() => undefined);
  if (previousMoved && !await pathExists(target) && await pathExists(backup)) await rename(backup, target).catch(() => undefined);
  throw error;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
