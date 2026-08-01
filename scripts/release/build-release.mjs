import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import {
  collectReleaseFiles,
  DEVELOPMENT_PREVIEW_RELEASE_CHANNEL,
  developmentPreviewSigning,
  pathExists,
  validateReleaseManifest,
  verifyReleaseFiles
} from "./release-common.mjs";
import {
  RELEASE_ENTRYPOINTS,
  macEntrypointFileName,
  macEntrypointScript,
  windowsEntrypointFileName,
  windowsEntrypointScript
} from "./entrypoints.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const serverPackage = JSON.parse(await readFile(path.join(repositoryRoot, "packages", "server", "package.json"), "utf8"));
const requestedPlatform = argumentValue("--platform") ?? "all";
const outputRoot = path.resolve(argumentValue("--output") ?? path.join(repositoryRoot, "dist", "releases"));
const platforms = requestedPlatform === "all" ? ["macos", "windows"] : [requestedPlatform];
if (platforms.some((value) => value !== "macos" && value !== "windows")) throw new Error("--platform 只接受 macos、windows 或 all");

await assertBuildOutputs();
await mkdir(outputRoot, { recursive: true });
const results = [];
for (const platform of platforms) results.push(await buildPlatform(platform));
const checksums = results.map((result) => `${result.archiveSha256.replace("sha256:", "")}  ${path.basename(result.archive)}`).join("\n");
await writeFile(path.join(outputRoot, "SHA256SUMS.txt"), `${checksums}\n`, "utf8");
console.log(JSON.stringify({ schemaVersion: "1.0", version: rootPackage.version, outputRoot, packages: results }, null, 2));

async function buildPlatform(platform) {
  const baseName = `skill-designer-${rootPackage.version}-${platform}`;
  const stage = path.join(outputRoot, baseName);
  const archivePath = `${stage}.zip`;
  await rm(stage, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await mkdir(stage, { recursive: true });

  await copyApplication(stage);
  await copyRuntimeDependencies(stage);
  await copyRuntimeTools(stage);
  await copyDocumentation(stage);
  await writePlatformEntrypoints(stage, platform);

  const files = await collectReleaseFiles(stage);
  const manifest = {
    schemaVersion: "1.0",
    product: "Skill Designer",
    version: rootPackage.version,
    targetPlatform: platform,
    releaseChannel: DEVELOPMENT_PREVIEW_RELEASE_CHANNEL,
    signing: developmentPreviewSigning(),
    minimumNode: "20.0.0",
    entry: "bin/skill-designer.mjs",
    dataDirectoryPolicy: platform === "macos" ? "~/Library/Application Support/Skill Designer" : "%LOCALAPPDATA%\\Skill Designer",
    files
  };
  validateReleaseManifest(manifest);
  await writeFile(path.join(stage, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const verification = await verifyReleaseFiles(stage, manifest);
  if (!verification.valid) throw new Error(`发布目录校验失败：${JSON.stringify(verification.mismatches)}`);

  await zipDirectory(stage, archivePath, baseName);
  const archiveBytes = await readFile(archivePath);
  return {
    platform,
    directory: stage,
    archive: archivePath,
    archiveSize: archiveBytes.length,
    archiveSha256: `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`,
    releaseChannel: manifest.releaseChannel,
    signingStatus: manifest.signing.status,
    trustLevel: manifest.signing.trustLevel,
    declaredFiles: manifest.files.length,
    declaredBytes: manifest.files.reduce((sum, file) => sum + file.size, 0)
  };
}

async function copyApplication(stage) {
  await copyDirectory(path.join(repositoryRoot, "packages", "server", "dist"), path.join(stage, "app", "server", "dist"));
  await cp(path.join(repositoryRoot, "packages", "server", "package.json"), path.join(stage, "app", "server", "package.json"));
  await copyDirectory(path.join(repositoryRoot, "packages", "web", "dist"), path.join(stage, "app", "web", "dist"));
  const engineTarget = path.join(stage, "node_modules", "@skill-designer", "engine");
  await copyDirectory(path.join(repositoryRoot, "packages", "engine", "dist"), path.join(engineTarget, "dist"));
  await cp(path.join(repositoryRoot, "packages", "engine", "package.json"), path.join(engineTarget, "package.json"));
}

async function copyRuntimeDependencies(stage) {
  const queue = Object.keys(serverPackage.dependencies ?? {})
    .filter((name) => name !== "@skill-designer/engine")
    .map((name) => ({ name, from: path.join(repositoryRoot, "packages", "server"), optional: false }));
  const copied = new Set();
  while (queue.length) {
    const request = queue.shift();
    let source;
    try {
      source = await resolveDependency(request.name, request.from);
    } catch (error) {
      if (request.optional) continue;
      throw error;
    }
    const key = await realpath(source);
    if (copied.has(key)) continue;
    copied.add(key);
    const destination = path.join(stage, destinationForDependency(source));
    await copyDirectory(source, destination);
    const packageJson = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    for (const name of Object.keys(packageJson.dependencies ?? {})) queue.push({ name, from: source, optional: false });
    for (const name of Object.keys(packageJson.optionalDependencies ?? {})) {
      if (!(name in (packageJson.dependencies ?? {}))) queue.push({ name, from: source, optional: true });
    }
  }
}

async function resolveDependency(name, from) {
  let cursor = path.resolve(from);
  const segments = name.split("/");
  while (true) {
    const candidate = path.join(cursor, "node_modules", ...segments);
    if (await pathExists(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`无法解析生产依赖 ${name}（来源 ${from}）`);
}

function destinationForDependency(source) {
  const relative = path.relative(repositoryRoot, source);
  if (relative.startsWith(`node_modules${path.sep}`)) return relative;
  const serverNested = path.join("packages", "server", "node_modules") + path.sep;
  if (relative.startsWith(serverNested)) return path.join("app", "server", "node_modules", relative.slice(serverNested.length));
  throw new Error(`生产依赖不在受支持的 node_modules 中：${source}`);
}

async function copyRuntimeTools(stage) {
  const tools = [
    ["runtime-launcher.mjs", "skill-designer.mjs"],
    ["doctor.mjs", "doctor.mjs"],
    ["install.mjs", "install.mjs"],
    ["uninstall.mjs", "uninstall.mjs"],
    ["release-common.mjs", "release-common.mjs"]
  ];
  await mkdir(path.join(stage, "bin"), { recursive: true });
  for (const [source, destination] of tools) await cp(path.join(repositoryRoot, "scripts", "release", source), path.join(stage, "bin", destination));
}

async function copyDocumentation(stage) {
  await cp(path.join(repositoryRoot, "README.md"), path.join(stage, "README.md"));
  await mkdir(path.join(stage, "docs"), { recursive: true });
  for (const file of ["Skill-Designer-1.0-用户指南.md", "Skill-Designer-1.0-已知限制.md"]) {
    await cp(path.join(repositoryRoot, "docs", file), path.join(stage, "docs", file));
  }
}

async function writePlatformEntrypoints(stage, platform) {
  for (const entrypoint of RELEASE_ENTRYPOINTS) {
    if (platform === "macos") {
      await writeExecutable(
        path.join(stage, macEntrypointFileName(entrypoint.id)),
        macEntrypointScript(entrypoint.script, entrypoint.pauseAlways)
      );
      continue;
    }
    await writeFile(
      path.join(stage, windowsEntrypointFileName(entrypoint.id)),
      windowsEntrypointScript(entrypoint.script, entrypoint.pauseAlways),
      "utf8"
    );
  }
}

async function writeExecutable(target, contents) {
  await writeFile(target, contents, "utf8");
  await chmod(target, 0o755);
}

async function copyDirectory(source, destination) {
  const info = await stat(source).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`构建产物缺失：${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: true, preserveTimestamps: false });
}

async function zipDirectory(source, target, baseName) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(target, { mode: 0o600 });
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("warning", reject);
    archive.once("error", reject);
    archive.pipe(output);
    archive.directory(source, baseName);
    void archive.finalize();
  });
}

async function assertBuildOutputs() {
  for (const target of [
    path.join(repositoryRoot, "packages", "engine", "dist", "index.js"),
    path.join(repositoryRoot, "packages", "server", "dist", "index.js"),
    path.join(repositoryRoot, "packages", "web", "dist", "index.html")
  ]) {
    if (!await pathExists(target)) throw new Error(`缺少构建产物 ${target}；请先运行 npm run build`);
  }
}

function argumentValue(name) {
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex >= 0) return process.argv[exactIndex + 1];
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}
