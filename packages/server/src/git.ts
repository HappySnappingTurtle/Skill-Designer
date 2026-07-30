import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  GitBinaryChange,
  GitCapability,
  GitComparisonReference,
  GitDiffResult,
  GitFileChange,
  GitFileStatus,
  GitReferencesResult
} from "@skill-designer/engine";
import { AppError } from "./errors.js";

const execFileAsync = promisify(execFile);
const PATCH_LIMIT = 1024 * 1024;
const BINARY_SUMMARY_LIMIT = 200;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/iu;

export interface GitStatusResult {
  capability: GitCapability;
  files: GitFileChange[];
}

export class GitDiffService {
  async status(projectRoot: string, mode: "managed-copy" | "in-place"): Promise<GitStatusResult> {
    if (mode !== "in-place") return { capability: { available: false, reason: "管理副本不关联用户 Git 仓库" }, files: [] };
    const capability = await this.inspect(projectRoot);
    if (!capability.available) return { capability, files: [] };
    const output = await runGit(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
    const projectPrefix = capability.repositoryRoot
      ? path.relative(capability.repositoryRoot, projectRoot).split(path.sep).join("/")
      : "";
    return { capability, files: parsePorcelain(output, projectPrefix) };
  }

  async listReferences(projectRoot: string, mode: "managed-copy" | "in-place"): Promise<GitReferencesResult> {
    if (mode !== "in-place") return { capability: { available: false, reason: "管理副本不关联用户 Git 仓库" }, refs: [] };
    const capability = await this.inspect(projectRoot);
    if (!capability.available || !capability.head) return { capability, refs: [] };
    const [commitOutput, tagOutput] = await Promise.all([
      runGit(projectRoot, ["log", "-n", "50", "--format=%H%x00%h%x00%ct%x00%s%x00", "--", "."]),
      runGit(projectRoot, ["for-each-ref", "--count=100", "--sort=-creatordate", "--format=%(refname:short)%00%(objectname)%00%(creatordate:unix)%00%(subject)%00", "refs/tags"])
    ]);
    const commits = parseCommitReferences(commitOutput);
    const tags = await parseTagReferences(projectRoot, tagOutput);
    const headCommit = commits.find((item) => item.oid === capability.head);
    const head: GitComparisonReference = {
      kind: "head",
      name: "HEAD",
      oid: capability.head,
      shortOid: capability.head.slice(0, 12),
      ...(headCommit?.subject ? { subject: headCommit.subject } : {}),
      ...(headCommit?.committedAt ? { committedAt: headCommit.committedAt } : {})
    };
    return { capability, refs: [head, ...tags, ...commits] };
  }

  async compare(projectRoot: string, mode: "managed-copy" | "in-place", requestedBase = "HEAD"): Promise<GitDiffResult> {
    const status = await this.status(projectRoot, mode);
    if (!status.capability.available) return emptyDiff(status.capability, requestedBase);
    const baseOid = await resolveBase(projectRoot, requestedBase, status.capability.head);
    const commonArgs = ["--no-ext-diff", "--no-textconv", "--relative", baseOid, "--", "."];
    const [patchOutput, nameStatusOutput, numstatOutput] = await Promise.all([
      runGit(projectRoot, ["diff", "--no-color", "--unified=3", ...commonArgs]),
      runGit(projectRoot, ["diff", "--name-status", "-z", "--find-renames", ...commonArgs]),
      runGit(projectRoot, ["diff", "--numstat", "-z", "--find-renames", ...commonArgs])
    ]);
    const comparedFiles = parseNameStatus(nameStatusOutput);
    const files = mergeFileChanges(comparedFiles, status.files);
    const binaryPaths = parseBinaryNumstat(numstatOutput);
    for (const file of status.files) {
      if (file.status === "untracked" && await isBinaryFile(path.join(projectRoot, file.path))) binaryPaths.add(file.path);
    }
    for (const file of files) {
      if (binaryPaths.has(file.path)) file.binary = true;
    }
    const binaryCandidates = files.filter((file) => file.binary).slice(0, BINARY_SUMMARY_LIMIT);
    const projectPrefix = status.capability.repositoryRoot
      ? path.relative(status.capability.repositoryRoot, projectRoot).split(path.sep).join("/")
      : "";
    const binaryChanges = await Promise.all(binaryCandidates.map((file) => summarizeBinaryChange(projectRoot, projectPrefix, baseOid, file)));
    return {
      capability: status.capability,
      base: requestedBase,
      baseOid,
      files,
      patch: patchOutput.length > PATCH_LIMIT ? patchOutput.slice(0, PATCH_LIMIT) : patchOutput,
      truncated: patchOutput.length > PATCH_LIMIT,
      binaryChanges,
      binaryTruncated: files.filter((file) => file.binary).length > BINARY_SUMMARY_LIMIT
    };
  }

  private async inspect(projectRoot: string): Promise<GitCapability> {
    let repositoryRoot: string;
    try {
      repositoryRoot = (await runGit(projectRoot, ["rev-parse", "--show-toplevel"])).trim();
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "系统未安装 Git" : "项目不在 Git 仓库中";
      return { available: false, reason };
    }
    const relative = path.relative(path.resolve(repositoryRoot), path.resolve(projectRoot));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { available: false, reason: "Git 仓库边界与已授权项目路径不一致" };
    }
    try {
      const [head, branch] = await Promise.all([
        runGit(projectRoot, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim()),
        runGit(projectRoot, ["symbolic-ref", "--short", "-q", "HEAD"]).then((value) => value.trim()).catch(() => "detached")
      ]);
      return { available: true, repositoryRoot, branch: branch || "detached", head };
    } catch {
      return { available: false, reason: "Git 仓库还没有可比较的 HEAD" };
    }
  }
}

function emptyDiff(capability: GitCapability, base: string): GitDiffResult {
  return { capability, base, files: [], patch: "", truncated: false, binaryChanges: [], binaryTruncated: false };
}

async function resolveBase(projectRoot: string, requestedBase: string, head?: string): Promise<string> {
  if (requestedBase === "HEAD") {
    if (!head) throw new AppError(422, "git_head_unavailable", "Git 仓库没有可比较的 HEAD");
    return head;
  }
  if (!OBJECT_ID_PATTERN.test(requestedBase)) throw new AppError(400, "invalid_git_base", "Git 对比基准必须是已枚举的 commit OID");
  try {
    return (await runGit(projectRoot, ["rev-parse", "--verify", `${requestedBase}^{commit}`])).trim();
  } catch {
    throw new AppError(422, "git_base_not_found", "Git 对比基准不存在或不是 commit");
  }
}

function parseCommitReferences(output: string): GitComparisonReference[] {
  const fields = output.split("\0");
  const refs: GitComparisonReference[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const oid = fields[index]?.trim();
    const shortOid = fields[index + 1]?.trim();
    const timestamp = Number(fields[index + 2]);
    const subject = fields[index + 3]?.trim();
    if (!oid || !OBJECT_ID_PATTERN.test(oid) || !shortOid) continue;
    refs.push({
      kind: "commit",
      name: shortOid,
      oid,
      shortOid,
      ...(subject ? { subject } : {}),
      ...(Number.isFinite(timestamp) ? { committedAt: new Date(timestamp * 1000).toISOString() } : {})
    });
  }
  return refs;
}

async function parseTagReferences(projectRoot: string, output: string): Promise<GitComparisonReference[]> {
  const fields = output.split("\0");
  const refs: GitComparisonReference[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const name = fields[index]?.trim();
    const objectOid = fields[index + 1]?.trim();
    const timestamp = Number(fields[index + 2]);
    const subject = fields[index + 3]?.trim();
    if (!name || !objectOid || !OBJECT_ID_PATTERN.test(objectOid)) continue;
    try {
      const oid = (await runGit(projectRoot, ["rev-parse", "--verify", `${objectOid}^{commit}`])).trim();
      refs.push({
        kind: "tag",
        name,
        oid,
        shortOid: oid.slice(0, 12),
        ...(subject ? { subject } : {}),
        ...(Number.isFinite(timestamp) ? { committedAt: new Date(timestamp * 1000).toISOString() } : {})
      });
    } catch {
      // Tags pointing to blobs or trees are not valid comparison bases.
    }
  }
  return refs;
}

function parseNameStatus(output: string): GitFileChange[] {
  const fields = output.split("\0");
  const changes: GitFileChange[] = [];
  for (let index = 0; index < fields.length;) {
    const token = fields[index++]?.trim();
    if (!token) continue;
    const code = token[0]!;
    if (code === "R" || code === "C") {
      const previousPath = normalizeDiffPath(fields[index++]);
      const currentPath = normalizeDiffPath(fields[index++]);
      if (currentPath) changes.push({ path: currentPath, ...(previousPath ? { previousPath } : {}), status: "renamed", staged: false, worktree: false });
      continue;
    }
    const filePath = normalizeDiffPath(fields[index++]);
    if (filePath) changes.push({ path: filePath, status: mapDiffStatus(code), staged: false, worktree: false });
  }
  return changes;
}

function parseBinaryNumstat(output: string): Set<string> {
  const fields = output.split("\0");
  const binary = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let filePath = record.slice(secondTab + 1);
    if (!filePath) {
      index++;
      filePath = fields[index++] ?? "";
    }
    const normalized = normalizeDiffPath(filePath);
    if (normalized && added === "-" && deleted === "-") binary.add(normalized);
  }
  return binary;
}

function normalizeDiffPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, "/");
  return isProjectRelative(normalized) ? normalized : undefined;
}

function mapDiffStatus(code: string): GitFileStatus {
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "U") return "conflicted";
  return "modified";
}

function mergeFileChanges(compared: GitFileChange[], status: GitFileChange[]): GitFileChange[] {
  const merged = new Map(compared.map((file) => [file.path, { ...file }]));
  for (const current of status) {
    const existing = merged.get(current.path);
    if (!existing) {
      if (current.status === "untracked" || current.status === "conflicted") merged.set(current.path, { ...current });
      continue;
    }
    merged.set(current.path, {
      ...existing,
      staged: current.staged,
      worktree: current.worktree,
      ...(current.status === "conflicted" ? { status: "conflicted" as const } : {})
    });
  }
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const sample = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    if (!bytesRead) return false;
    let controls = 0;
    for (let index = 0; index < bytesRead; index++) {
      const byte = sample[index]!;
      if (byte === 0) return true;
      if (byte < 7 || (byte > 13 && byte < 32)) controls++;
    }
    return controls / bytesRead > 0.2;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function summarizeBinaryChange(projectRoot: string, projectPrefix: string, baseOid: string, file: GitFileChange): Promise<GitBinaryChange> {
  const basePath = file.previousPath ?? file.path;
  const repositoryPath = projectPrefix && projectPrefix !== "." ? `${projectPrefix}/${basePath}` : basePath;
  const [baseBytes, currentBytes] = await Promise.all([
    file.status === "added" || file.status === "untracked"
      ? Promise.resolve(null)
      : runGit(projectRoot, ["cat-file", "-s", `${baseOid}:${repositoryPath}`]).then((value) => Number(value.trim())).catch(() => null),
    file.status === "deleted"
      ? Promise.resolve(null)
      : stat(path.join(projectRoot, file.path)).then((info) => info.size).catch(() => null)
  ]);
  return {
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    status: file.status,
    baseBytes: Number.isFinite(baseBytes) ? baseBytes : null,
    currentBytes: Number.isFinite(currentBytes) ? currentBytes : null
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
  );
  try {
    const result = await execFileAsync("git", [
      "-c", "core.quotepath=false",
      "-c", "core.fsmonitor=false",
      "-c", "status.relativePaths=true",
      "-c", "submodule.recurse=false",
      ...args
    ], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...cleanEnvironment,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: os.platform() === "win32" ? "NUL" : "/dev/null",
        GIT_PAGER: "cat",
        PAGER: "cat",
        GIT_EXTERNAL_DIFF: "",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C"
      }
    });
    return result.stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    const details = error as { stderr?: string; code?: number | string };
    throw new AppError(422, "git_command_failed", "Git 只读命令执行失败", {
      command: args[0],
      exitCode: details.code,
      stderr: details.stderr?.slice(0, 2000)
    });
  }
}

function parsePorcelain(output: string, projectPrefix: string): GitFileChange[] {
  const records = output.split("\0").filter(Boolean);
  const changes: GitFileChange[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const x = record[0]!;
    const y = record[1]!;
    const rawPath = record.slice(3).replace(/\\/g, "/");
    const renamed = x === "R" || y === "R" || x === "C" || y === "C";
    const rawPrevious = renamed ? records[++index]?.replace(/\\/g, "/") : undefined;
    const projectPath = toProjectRelative(rawPath, projectPrefix);
    if (!projectPath) continue;
    const previousPath = rawPrevious ? toProjectRelative(rawPrevious, projectPrefix) : undefined;
    const status = mapStatus(x, y);
    changes.push({
      path: projectPath,
      ...(previousPath ? { previousPath } : {}),
      status,
      staged: x !== " " && x !== "?",
      worktree: y !== " " || x === "?"
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function toProjectRelative(value: string, projectPrefix: string): string | undefined {
  if (!isProjectRelative(value)) return undefined;
  if (!projectPrefix || projectPrefix === ".") return value;
  const normalizedPrefix = projectPrefix.replace(/\/+$/u, "");
  return value.startsWith(`${normalizedPrefix}/`) ? value.slice(normalizedPrefix.length + 1) : undefined;
}

function isProjectRelative(value: string): boolean {
  return Boolean(value) && !value.startsWith("../") && !value.startsWith("/") && !path.posix.isAbsolute(value);
}

function mapStatus(x: string, y: string): GitFileStatus {
  const pair = `${x}${y}`;
  if (pair === "??") return "untracked";
  if (x === "U" || y === "U" || pair === "AA" || pair === "DD") return "conflicted";
  if (x === "R" || y === "R" || x === "C" || y === "C") return "renamed";
  if (x === "D" || y === "D") return "deleted";
  if (x === "A" || y === "A") return "added";
  return "modified";
}
