import { createHash } from "node:crypto";
import { access, lstat, mkdir, open, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_MANIFEST = "release-manifest.json";
export const MINIMUM_NODE_MAJOR = 20;
export const DEVELOPMENT_PREVIEW_RELEASE_CHANNEL = "development-preview";

export function developmentPreviewSigning() {
  return {
    status: "unsigned",
    trustLevel: "integrity-only",
    distribution: "local-development",
    macos: {
      appleCodeSigned: false,
      notarized: false
    },
    windows: {
      authenticodeSigned: false
    }
  };
}

export function releaseRoot(metaUrl) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..");
}

export function defaultDataDirectory(platform = process.platform, environment = process.env, home = os.homedir()) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Skill Designer");
  if (platform === "win32") return path.join(environment.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Skill Designer");
  return path.join(environment.XDG_DATA_HOME || path.join(home, ".local", "share"), "skill-designer");
}

export function defaultInstallDirectory(platform = process.platform, environment = process.env, home = os.homedir()) {
  if (platform === "darwin") return path.join(home, "Applications", "Skill Designer");
  if (platform === "win32") return path.join(environment.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "Skill Designer");
  return path.join(home, ".local", "opt", "skill-designer");
}

export function nodeVersionSupported(version = process.versions.node) {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR;
}

export function releasePlatformMatchesRuntime(targetPlatform, runtimePlatform = process.platform) {
  return (targetPlatform === "macos" && runtimePlatform === "darwin")
    || (targetPlatform === "windows" && runtimePlatform === "win32");
}

export function chromeExecutableCandidates(platform = process.platform, environment = process.env, home = os.homedir()) {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")
    ];
  }
  if (platform === "win32") {
    return [
      environment.PROGRAMFILES,
      environment["PROGRAMFILES(X86)"],
      environment.LOCALAPPDATA
    ].filter(Boolean).map((base) => path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
  }
  return [];
}

export async function findChromeExecutable({
  platform = process.platform,
  environment = process.env,
  home = os.homedir(),
  exists = pathExists
} = {}) {
  for (const candidate of chromeExecutableCandidates(platform, environment, home)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

export async function readReleaseManifest(root) {
  const value = JSON.parse(await readFile(path.join(root, RELEASE_MANIFEST), "utf8"));
  return validateReleaseManifest(value);
}

export function validateReleaseManifest(value) {
  if (!isRecord(value)) invalidManifest("根对象缺失");
  if (value.schemaVersion !== "1.0") invalidManifest("schemaVersion 仅接受 1.0");
  if (value.product !== "Skill Designer") invalidManifest("product 不匹配");
  if (typeof value.version !== "string" || value.version.trim() === "") invalidManifest("version 缺失");
  if (value.targetPlatform !== "macos" && value.targetPlatform !== "windows") invalidManifest("targetPlatform 仅接受 macos 或 windows");
  if (value.minimumNode !== "20.0.0") invalidManifest("0.1.0 的 minimumNode 必须是 20.0.0");
  if (value.entry !== "bin/skill-designer.mjs") invalidManifest("0.1.0 的 entry 必须是 bin/skill-designer.mjs");
  const expectedDataPolicy = value.targetPlatform === "macos"
    ? "~/Library/Application Support/Skill Designer"
    : "%LOCALAPPDATA%\\Skill Designer";
  if (value.dataDirectoryPolicy !== expectedDataPolicy) invalidManifest("dataDirectoryPolicy 与 targetPlatform 不一致");

  if (value.releaseChannel !== DEVELOPMENT_PREVIEW_RELEASE_CHANNEL) {
    invalidManifest(`releaseChannel 仅接受 ${DEVELOPMENT_PREVIEW_RELEASE_CHANNEL}`);
  }
  if (!isRecord(value.signing)) invalidManifest("signing 缺失");
  if (value.signing.status !== "unsigned") invalidManifest("0.1.0 只接受明确的 unsigned 开发预览，文本声明不能作为签名证明");
  if (value.signing.trustLevel !== "integrity-only") invalidManifest("signing.trustLevel 仅接受 integrity-only");
  if (value.signing.distribution !== "local-development") invalidManifest("signing.distribution 仅接受 local-development");
  if (!isRecord(value.signing.macos) || value.signing.macos.appleCodeSigned !== false || value.signing.macos.notarized !== false) {
    invalidManifest("signing.macos 必须明确声明未 Apple 签名且未公证");
  }
  if (!isRecord(value.signing.windows) || value.signing.windows.authenticodeSigned !== false) {
    invalidManifest("signing.windows 必须明确声明未 Authenticode 签名");
  }

  if (!Array.isArray(value.files) || value.files.length === 0) invalidManifest("files 必须是非空数组");
  const declaredPaths = new Set();
  for (const file of value.files) {
    if (!isRecord(file) || !safeManifestPath(file.path)) invalidManifest("files 包含不安全或无效路径");
    if (!Number.isSafeInteger(file.size) || file.size < 0) invalidManifest(`files.${file.path}.size 无效`);
    if (typeof file.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(file.sha256)) invalidManifest(`files.${file.path}.sha256 无效`);
    if (declaredPaths.has(file.path)) invalidManifest(`files 包含重复路径 ${file.path}`);
    declaredPaths.add(file.path);
  }
  if (!safeManifestPath(value.entry) || !declaredPaths.has(value.entry)) invalidManifest("entry 必须是清单内的安全路径");
  return value;
}

export function releaseTrustFromManifest(manifest) {
  return {
    releaseChannel: manifest.releaseChannel,
    signingStatus: manifest.signing.status,
    trustLevel: manifest.signing.trustLevel,
    distribution: manifest.signing.distribution,
    publisherTrustEstablished: false,
    integrityOnly: true,
    platforms: {
      macos: {
        appleCodeSigned: manifest.signing.macos.appleCodeSigned,
        notarized: manifest.signing.macos.notarized
      },
      windows: {
        authenticodeSigned: manifest.signing.windows.authenticodeSigned
      }
    },
    warnings: [
      "该发布包是未签名开发预览；SHA-256 和文件清单只验证完整性，不建立发布者身份信任。",
      "macOS 产物未进行 Apple 代码签名和公证；Windows 产物未进行 Authenticode 签名。"
    ]
  };
}

export async function collectReleaseFiles(root, excluded = new Set([RELEASE_MANIFEST])) {
  const files = [];
  await walk(root, "", files, excluded);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(root, relative, files, excluded) {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (excluded.has(childRelative)) continue;
    if (entry.isSymbolicLink()) throw new Error(`发布包不允许符号链接：${childRelative}`);
    if (entry.isDirectory()) {
      await walk(root, childRelative, files, excluded);
      continue;
    }
    if (!entry.isFile()) throw new Error(`发布包包含不支持的文件类型：${childRelative}`);
    const bytes = await readFile(path.join(root, ...childRelative.split("/")));
    files.push({ path: childRelative, size: bytes.length, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
  }
}

export async function verifyReleaseFiles(root, manifest, selectedPaths) {
  const selected = selectedPaths ? new Set(selectedPaths) : null;
  const mismatches = [];
  let checkedFiles = 0;
  let totalBytes = 0;
  for (const expected of manifest.files) {
    if (selected && !selected.has(expected.path)) continue;
    checkedFiles++;
    const target = path.resolve(root, ...expected.path.split("/"));
    if (!isInside(root, target)) {
      mismatches.push({ path: expected.path, code: "unsafe_path" });
      continue;
    }
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        mismatches.push({ path: expected.path, code: "unsupported_file_type", actualType: "symbolic_link" });
        continue;
      }
      if (!info.isFile()) {
        mismatches.push({ path: expected.path, code: "unsupported_file_type", actualType: info.isDirectory() ? "directory" : "special" });
        continue;
      }
      const bytes = await readFile(target);
      const actualHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      totalBytes += bytes.length;
      if (bytes.length !== expected.size || actualHash !== expected.sha256) {
        mismatches.push({ path: expected.path, code: "content_mismatch", expectedSize: expected.size, actualSize: bytes.length, expectedHash: expected.sha256, actualHash });
      }
    } catch (error) {
      mismatches.push({ path: expected.path, code: "missing", message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (selected) {
    for (const required of selected) {
      if (!manifest.files.some((file) => file.path === required)) mismatches.push({ path: required, code: "not_declared" });
    }
  } else {
    const inventory = await inspectReleaseTree(root);
    for (const problem of inventory.problems) {
      if (!mismatches.some((item) => item.path === problem.path && item.code === problem.code)) mismatches.push(problem);
    }
    const declared = new Set(manifest.files.map((file) => file.path));
    for (const actualPath of inventory.files) {
      if (!declared.has(actualPath)) mismatches.push({ path: actualPath, code: "undeclared_file" });
    }
  }
  return { valid: mismatches.length === 0, checkedFiles, totalBytes, mismatches };
}

async function inspectReleaseTree(root) {
  const files = [];
  const problems = [];
  await inspectDirectory(root, "", files, problems);
  return { files, problems };
}

async function inspectDirectory(root, relative, files, problems) {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (childRelative === RELEASE_MANIFEST) continue;
    if (entry.isSymbolicLink()) {
      problems.push({ path: childRelative, code: "unsupported_file_type", actualType: "symbolic_link" });
      continue;
    }
    if (entry.isDirectory()) {
      await inspectDirectory(root, childRelative, files, problems);
      continue;
    }
    if (entry.isFile()) {
      files.push(childRelative);
      continue;
    }
    problems.push({ path: childRelative, code: "unsupported_file_type", actualType: "special" });
  }
}

export async function probeWritableDirectory(directory) {
  const target = path.resolve(directory);
  const probe = path.join(target, `.write-probe-${process.pid}-${Date.now()}`);
  let handle;
  try {
    // 创建目录也可能因父目录只读或权限不足而失败，必须和写探针一起归入同一结构化结果，
    // 否则 doctor 会以未捕获异常终止，用户看不到“数据目录不可写”这条明确诊断。
    await mkdir(target, { recursive: true, mode: 0o700 });
    handle = await open(probe, "wx", 0o600);
    await handle.writeFile("ok", "utf8");
    await handle.sync();
    return { writable: true, path: target };
  } catch (error) {
    return { writable: false, path: target, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(probe).catch(() => undefined);
  }
}

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function assertSafeReleaseRoot(root) {
  const resolved = path.resolve(root);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("发布目录不是文件夹");
  return await readReleaseManifest(resolved);
}

export async function writeJson(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function removeExactDirectory(target) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  if (resolved === root || resolved === os.homedir()) throw new Error("拒绝删除系统根目录或用户主目录");
  await rm(resolved, { recursive: true, force: true });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeManifestPath(value) {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function invalidManifest(detail) {
  throw new Error(`发布清单格式无效：${detail}`);
}
