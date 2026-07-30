import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildDockerDesktopRunArguments,
  type SandboxAuditEvent,
  type SandboxCapabilityReport,
  type SandboxCollectionResult,
  type SandboxExecutionRequest,
  type SandboxHandle,
  type SandboxPolicy,
  type SandboxPrepareInput,
  type SandboxRunner
} from "@skill-designer/engine";
import { AppError } from "./errors.js";
import { SandboxCapabilityService } from "./sandbox.js";

const MAX_STREAM_BYTES = 256 * 1024;
const MAX_ARTIFACT_FILES = 500;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_TEXT_BYTES = 256 * 1024;

export interface DockerProcessResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface DockerLifecycleExecutor {
  run(args: string[], signal: AbortSignal): Promise<DockerProcessResult>;
  exec(args: string[]): Promise<string>;
}

export interface DockerDesktopSandboxRunnerOptions {
  workRoot: string;
  capabilityService?: Pick<SandboxCapabilityService, "probe">;
  executor?: DockerLifecycleExecutor;
  now?: () => Date;
  idFactory?: () => string;
}

interface SandboxLifecycleRecord {
  schemaVersion: "1.0";
  handle: SandboxHandle;
  workspaceId: string;
  projectId: string;
  skillId: string;
  benchmarkCaseId: string;
  containerName: string;
  runRoot: string;
  inputRoot: string;
  outputRoot: string;
  policy: SandboxPolicy;
  auditEvents: SandboxAuditEvent[];
}

export class DockerDesktopSandboxRunner implements SandboxRunner {
  private readonly workRoot: string;
  private readonly capabilities: Pick<SandboxCapabilityService, "probe">;
  private readonly executor: DockerLifecycleExecutor;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: DockerDesktopSandboxRunnerOptions) {
    this.workRoot = path.resolve(options.workRoot);
    this.capabilities = options.capabilityService ?? new SandboxCapabilityService();
    this.executor = options.executor ?? new LocalDockerLifecycleExecutor();
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  probe(): Promise<SandboxCapabilityReport> {
    return this.capabilities.probe();
  }

  async prepare(input: SandboxPrepareInput, policy: SandboxPolicy): Promise<SandboxHandle> {
    const capability = await this.probe();
    const docker = capability.backends.find((backend) => backend.backendId === "docker-desktop");
    if (capability.selectedBackend !== "docker-desktop" || docker?.status !== "ready") {
      throw new AppError(409, "sandbox_unavailable", "本机没有可用的 Docker Desktop 沙箱", capability);
    }
    assertStrictPolicy(policy);
    if (input.runtimeArtifact.skillId !== input.benchmarkCase.skillId) {
      throw new AppError(409, "sandbox_identity_mismatch", "RuntimeArtifact 与 BenchmarkCase 的 Skill 身份不一致");
    }
    const snapshotRoot = await realpath(input.snapshotRoot);
    if (!(await stat(snapshotRoot)).isDirectory()) throw new AppError(400, "sandbox_snapshot_invalid", "沙箱输入必须是已冻结的 snapshot 目录");

    const handleId = `sandbox-${this.idFactory()}`;
    if (!/^sandbox-[0-9a-f-]{36}$/iu.test(handleId)) throw new AppError(500, "sandbox_handle_invalid", "沙箱 Handle ID 无效");
    const runRoot = this.runRoot(handleId);
    const inputRoot = path.join(runRoot, "input");
    const outputRoot = path.join(runRoot, "output");
    await mkdir(inputRoot, { recursive: true, mode: 0o700 });
    await mkdir(outputRoot, { recursive: true, mode: 0o777 });
    await copySnapshotTree(snapshotRoot, inputRoot);
    await makeTreeReadOnly(inputRoot);
    await chmod(outputRoot, 0o777);

    const timestamp = this.now().toISOString();
    const handle: SandboxHandle = {
      handleId,
      backendId: "docker-desktop",
      runtimeArtifactId: input.runtimeArtifact.artifactId,
      state: "prepared",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const record: SandboxLifecycleRecord = {
      schemaVersion: "1.0",
      handle,
      workspaceId: input.runtimeArtifact.workspaceId,
      projectId: input.runtimeArtifact.projectId,
      skillId: input.runtimeArtifact.skillId,
      benchmarkCaseId: input.benchmarkCase.caseId,
      containerName: `skill-benchmark-${handleId.slice(-12)}`.toLowerCase(),
      runRoot,
      inputRoot,
      outputRoot,
      policy: structuredClone(policy),
      auditEvents: []
    };
    this.appendAudit(record, "sandbox.prepared", {
      runtimeArtifactId: handle.runtimeArtifactId,
      benchmarkCaseId: record.benchmarkCaseId,
      inputMode: "read-only",
      networkMode: policy.network.mode
    });
    await this.writeRecord(record);
    return structuredClone(record.handle);
  }

  async *run(handle: SandboxHandle, request: SandboxExecutionRequest, signal: AbortSignal): AsyncIterable<SandboxAuditEvent> {
    let record = await this.readRecord(handle.handleId);
    assertHandleIdentity(record, handle);
    if (record.handle.state !== "prepared") throw new AppError(409, "sandbox_not_prepared", "沙箱不在可启动状态");
    const args = buildDockerDesktopRunArguments({
      containerName: record.containerName,
      image: request.image,
      inputRoot: record.inputRoot,
      outputRoot: record.outputRoot,
      command: [request.command.executable, ...request.command.args],
      policy: record.policy
    });

    record.handle.state = "running";
    const started = this.appendAudit(record, "sandbox.started", {
      image: request.image,
      executable: request.command.executable,
      argumentCount: request.command.args.length
    });
    await this.writeRecord(record);
    yield started;

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, record.policy.resources.timeoutMs);
    try {
      const result = await this.executor.run(args, controller.signal);
      record = await this.readRecord(handle.handleId);
      if (record.handle.state === "cancelled") {
        const event = record.auditEvents.at(-1);
        if (event?.type === "sandbox.cancelled") yield event;
        return;
      }
      for (const [type, value] of [["sandbox.stdout", result.stdout], ["sandbox.stderr", result.stderr]] as const) {
        if (!value.length) continue;
        const truncated = value.length > MAX_STREAM_BYTES;
        const event = this.appendAudit(record, type, {
          text: value.subarray(0, MAX_STREAM_BYTES).toString("utf8"),
          bytes: value.length,
          truncated
        });
        yield event;
      }
      if (controller.signal.aborted || result.exitCode === null) {
        await this.forceRemoveAndAssertGone(record.containerName);
        record.handle.state = timedOut ? "timed-out" : "cancelled";
        const event = this.appendAudit(record, timedOut ? "sandbox.timed-out" : "sandbox.cancelled", { containerRemoved: true });
        await this.writeRecord(record);
        yield event;
        return;
      }
      record.handle.state = result.exitCode === 0 ? "completed" : "failed";
      const event = this.appendAudit(record, result.exitCode === 0 ? "sandbox.completed" : "sandbox.failed", { exitCode: result.exitCode });
      await this.writeRecord(record);
      yield event;
    } catch (error) {
      record = await this.readRecord(handle.handleId);
      if (record.handle.state === "cancelled") {
        const event = record.auditEvents.at(-1);
        if (event?.type === "sandbox.cancelled") yield event;
        return;
      }
      if (controller.signal.aborted) {
        await this.forceRemoveAndAssertGone(record.containerName);
        record.handle.state = timedOut ? "timed-out" : "cancelled";
        const event = this.appendAudit(record, timedOut ? "sandbox.timed-out" : "sandbox.cancelled", { containerRemoved: true });
        await this.writeRecord(record);
        yield event;
        return;
      }
      record.handle.state = "failed";
      const event = this.appendAudit(record, "sandbox.failed", { error: error instanceof Error ? error.message : "Docker 执行失败" });
      await this.writeRecord(record);
      yield event;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async cancel(handle: SandboxHandle): Promise<void> {
    const record = await this.readRecord(handle.handleId);
    assertHandleIdentity(record, handle);
    if (["completed", "failed", "cancelled", "timed-out", "cleaned"].includes(record.handle.state)) return;
    const wasRunning = record.handle.state === "running";
    record.handle.state = "cancelled";
    this.appendAudit(record, "sandbox.cancelled", { containerRemoved: true });
    await this.writeRecord(record);
    if (wasRunning) {
      try {
        await this.forceRemoveAndAssertGone(record.containerName);
      } catch (error) {
        record.handle.state = "failed";
        this.appendAudit(record, "sandbox.failed", { error: error instanceof Error ? error.message : "容器取消清理失败" });
        await this.writeRecord(record);
        throw error;
      }
    }
  }

  async collect(handle: SandboxHandle): Promise<SandboxCollectionResult> {
    const record = await this.readRecord(handle.handleId);
    assertHandleIdentity(record, handle);
    if (record.handle.state === "running" || record.handle.state === "prepared" || record.handle.state === "cleaned") {
      throw new AppError(409, "sandbox_not_collectable", "沙箱尚未结束或已经清理，不能收集产物");
    }
    const artifacts = await collectRegularFiles(record.outputRoot);
    this.appendAudit(record, "sandbox.collected", { fileCount: artifacts.length, totalBytes: artifacts.reduce((sum, item) => sum + item.size, 0) });
    await this.writeRecord(record);
    return { handleId: handle.handleId, artifacts, auditEvents: structuredClone(record.auditEvents) };
  }

  async cleanup(handle: SandboxHandle): Promise<void> {
    let record = await this.readRecord(handle.handleId);
    assertHandleIdentity(record, handle);
    if (record.handle.state === "running") {
      await this.cancel(handle);
      record = await this.readRecord(handle.handleId);
    }
    this.assertRunPath(record.runRoot, handle.handleId);
    await makeTreeOwnerWritable(record.inputRoot);
    await rm(record.runRoot, { recursive: true, force: true });
    record.handle.state = "cleaned";
    this.appendAudit(record, "sandbox.cleaned", { workingCopyRemoved: true });
    await this.writeRecord(record);
  }

  async getStatus(handleId: string): Promise<{ handle: SandboxHandle; auditEvents: SandboxAuditEvent[] }> {
    const record = await this.readRecord(handleId);
    return { handle: structuredClone(record.handle), auditEvents: structuredClone(record.auditEvents) };
  }

  private appendAudit(record: SandboxLifecycleRecord, type: SandboxAuditEvent["type"], data: Record<string, unknown>): SandboxAuditEvent {
    const timestamp = this.now().toISOString();
    const event: SandboxAuditEvent = { seq: record.auditEvents.length + 1, type, at: timestamp, data };
    record.auditEvents.push(event);
    record.handle.updatedAt = timestamp;
    return event;
  }

  private async forceRemoveAndAssertGone(containerName: string): Promise<void> {
    try {
      await this.executor.exec(["--context", "desktop-linux", "rm", "-f", containerName]);
    } catch {
      // A --rm container may already be gone; inspect below is authoritative.
    }
    try {
      await this.executor.exec(["--context", "desktop-linux", "inspect", containerName]);
      throw new AppError(500, "sandbox_container_residual", "取消后仍检测到残留容器");
    } catch (error) {
      if (error instanceof AppError) throw error;
    }
  }

  private runRoot(handleId: string): string {
    const target = path.join(this.workRoot, "runs", handleId);
    this.assertRunPath(target, handleId);
    return target;
  }

  private recordFile(handleId: string): string {
    if (!/^sandbox-[0-9a-f-]{36}$/iu.test(handleId)) throw new AppError(400, "invalid_sandbox_handle", "Sandbox Handle ID 无效");
    return path.join(this.workRoot, "records", `${handleId}.json`);
  }

  private assertRunPath(target: string, handleId: string): void {
    const expected = path.join(this.workRoot, "runs", handleId);
    if (path.resolve(target) !== expected || !expected.startsWith(this.workRoot + path.sep)) {
      throw new AppError(500, "sandbox_path_invalid", "沙箱工作目录越界");
    }
  }

  private async readRecord(handleId: string): Promise<SandboxLifecycleRecord> {
    try {
      const record = JSON.parse(await readFile(this.recordFile(handleId), "utf8")) as SandboxLifecycleRecord;
      if (record.handle.handleId !== handleId) throw new AppError(409, "sandbox_record_identity_mismatch", "沙箱记录身份不一致");
      this.assertRunPath(record.runRoot, handleId);
      return record;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "sandbox_not_found", "沙箱记录不存在");
      throw error;
    }
  }

  private async writeRecord(record: SandboxLifecycleRecord): Promise<void> {
    const target = this.recordFile(record.handle.handleId);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, target);
  }
}

class LocalDockerLifecycleExecutor implements DockerLifecycleExecutor {
  async run(args: string[], signal: AbortSignal): Promise<DockerProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { shell: false, windowsHide: true, env: cleanDockerEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      const onAbort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ exitCode: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
    });
  }

  async exec(args: string[]): Promise<string> {
    const result = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("docker", args, { shell: false, windowsHide: true, env: cleanDockerEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve(Buffer.concat(stdout)) : reject(new Error(Buffer.concat(stderr).toString("utf8") || `docker exit ${code}`)));
    });
    return result.toString("utf8");
  }
}

function cleanDockerEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "HOME", "USERPROFILE", "SystemRoot", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key) && value !== undefined)) as NodeJS.ProcessEnv;
}

function assertStrictPolicy(policy: SandboxPolicy): void {
  if (policy.schemaVersion !== "1.0" || policy.filesystem.root !== "read-only" || policy.filesystem.input !== "read-only" || policy.filesystem.output !== "read-write" || policy.filesystem.hostAccess !== "deny") {
    throw new AppError(400, "sandbox_policy_weakened", "文件系统策略不能弱化");
  }
  if (policy.network.mode !== "none" || policy.network.allowedHosts.length) throw new AppError(400, "sandbox_network_unsupported", "当前只支持完全禁用网络");
  if (!policy.process.allowedCommands.length || policy.process.allowedCommands.some((item) => !/^[a-z0-9._-]+$/iu.test(item))) throw new AppError(400, "sandbox_command_policy_invalid", "命令允许列表无效");
  if (!Number.isInteger(policy.process.maxProcesses) || policy.process.maxProcesses < 2 || policy.process.maxProcesses > 256) throw new AppError(400, "sandbox_process_limit_invalid", "进程上限必须在 2 到 256 之间");
  if (!Number.isInteger(policy.resources.timeoutMs) || policy.resources.timeoutMs < 1_000 || policy.resources.timeoutMs > 30 * 60_000) throw new AppError(400, "sandbox_timeout_invalid", "超时必须在 1 秒到 30 分钟之间");
  if (!Number.isInteger(policy.resources.memoryMiB) || policy.resources.memoryMiB < 128 || policy.resources.memoryMiB > 8_192) throw new AppError(400, "sandbox_memory_invalid", "内存限制必须在 128 到 8192 MiB 之间");
  if (!Number.isFinite(policy.resources.cpuCores) || policy.resources.cpuCores < 0.25 || policy.resources.cpuCores > 8) throw new AppError(400, "sandbox_cpu_invalid", "CPU 限制必须在 0.25 到 8 之间");
}

function assertHandleIdentity(record: SandboxLifecycleRecord, handle: SandboxHandle): void {
  if (record.handle.handleId !== handle.handleId || record.handle.runtimeArtifactId !== handle.runtimeArtifactId || record.handle.backendId !== handle.backendId) {
    throw new AppError(409, "sandbox_handle_identity_mismatch", "Sandbox Handle 身份不一致");
  }
}

async function copySnapshotTree(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new AppError(403, "sandbox_snapshot_special_file", "Snapshot 包含不支持的符号链接或特殊文件");
    if (info.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      await copySnapshotTree(from, to);
    } else {
      const sourceFile = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const buffer = await sourceFile.readFile();
        await writeFile(to, buffer, { mode: 0o600, flag: "wx" });
      } finally {
        await sourceFile.close();
      }
    }
  }
}

async function makeTreeReadOnly(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeTreeReadOnly(target);
      await chmod(target, 0o555);
    } else await chmod(target, 0o444);
  }
  await chmod(directory, 0o555);
}

async function makeTreeOwnerWritable(directory: string): Promise<void> {
  try {
    await chmod(directory, 0o700);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await makeTreeOwnerWritable(target);
      else await chmod(target, 0o600);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function collectRegularFiles(root: string): Promise<SandboxCollectionResult["artifacts"]> {
  const artifacts: SandboxCollectionResult["artifacts"] = [];
  let totalBytes = 0;
  let fileCount = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new AppError(422, "sandbox_artifact_special_file", `产物 ${entry.name} 不是普通文件`);
      if (info.isDirectory()) {
        await walk(target);
        continue;
      }
      if (++fileCount > MAX_ARTIFACT_FILES) throw new AppError(413, "sandbox_artifact_count_exceeded", "沙箱产物文件数量超过限制");
      totalBytes += info.size;
      if (totalBytes > MAX_ARTIFACT_BYTES) throw new AppError(413, "sandbox_artifact_size_exceeded", "沙箱产物总大小超过限制");
      const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const checked = await file.stat();
        if (!checked.isFile()) throw new AppError(422, "sandbox_artifact_not_regular", `产物 ${entry.name} 不是普通文件`);
        if (checked.nlink !== 1) throw new AppError(422, "sandbox_artifact_hardlink", `产物 ${entry.name} 不能是硬链接`);
        const buffer = await file.readFile();
        const text = decodeArtifactText(buffer);
        artifacts.push({
          path: path.relative(root, target).split(path.sep).join("/").normalize("NFC"),
          size: buffer.length,
          sha256: `sha256:${createHash("sha256").update(buffer).digest("hex")}`,
          ...(text === undefined ? {} : { text })
        });
      } finally {
        await file.close();
      }
    }
  };
  await walk(root);
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

function decodeArtifactText(buffer: Buffer): string | undefined {
  if (buffer.length > MAX_ARTIFACT_TEXT_BYTES || buffer.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}
