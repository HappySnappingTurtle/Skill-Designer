import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultSandboxPolicy,
  type BenchmarkCase,
  type RuntimeArtifact,
  type SandboxAuditEvent,
  type SandboxCapabilityCheck,
  type SandboxCapabilityReport,
  type SandboxHandle,
  type SandboxRunner,
  type SandboxSelfTestRecord
} from "@skill-designer/engine";
import { DockerDesktopSandboxRunner } from "./sandbox-runner.js";
import { SandboxCapabilityService } from "./sandbox.js";

export interface SandboxControlServiceOptions {
  dataRoot: string;
  capabilityService?: Pick<SandboxCapabilityService, "probe">;
  runner?: SandboxLifecycleRunner;
  runnerImage?: string;
  now?: () => Date;
  idFactory?: () => string;
}

export interface SandboxLifecycleRunner extends SandboxRunner {
  getStatus(handleId: string): Promise<{ handle: SandboxHandle; auditEvents: SandboxAuditEvent[] }>;
}

export class SandboxControlService {
  private readonly dataRoot: string;
  private readonly capabilities: Pick<SandboxCapabilityService, "probe">;
  private readonly runner: SandboxLifecycleRunner;
  private readonly runnerImage: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private selfTestRunning = false;

  constructor(options: SandboxControlServiceOptions) {
    this.dataRoot = path.resolve(options.dataRoot);
    this.capabilities = options.capabilityService ?? new SandboxCapabilityService();
    this.runner = options.runner ?? new DockerDesktopSandboxRunner({ workRoot: path.join(this.dataRoot, "lifecycle"), capabilityService: this.capabilities });
    this.runnerImage = options.runnerImage?.trim() ?? "";
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async probe(): Promise<SandboxCapabilityReport> {
    const report = await this.capabilities.probe();
    const selfTest = await this.latestSelfTest();
    if (selfTest?.status !== "passed" || report.selectedBackend !== "docker-desktop") return report;
    const docker = report.backends.find((backend) => backend.backendId === "docker-desktop");
    if (!docker || docker.status !== "ready") return report;
    return {
      ...report,
      status: "ready",
      readyForBenchmark: true,
      backends: report.backends.map((backend) => backend.backendId === "docker-desktop" ? {
        ...backend,
        reason: "Docker Desktop 隔离生命周期自检已通过",
        checks: [...backend.checks.filter((check) => check.id !== "lifecycle-self-test"), { id: "lifecycle-self-test", status: "pass", message: `隔离自检 ${selfTest.selfTestId} 已通过` }],
        limitations: backend.limitations.filter((item) => !item.includes("尚未创建、取消或清理"))
      } : backend)
    };
  }

  latestSelfTest(): Promise<SandboxSelfTestRecord | null> {
    return readFile(this.latestFile(), "utf8")
      .then((value) => JSON.parse(value) as SandboxSelfTestRecord)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
  }

  async runSelfTest(): Promise<SandboxSelfTestRecord> {
    if (this.selfTestRunning) return this.unavailableRecord("已有隔离自检正在运行", []);
    this.selfTestRunning = true;
    const capability = await this.capabilities.probe();
    const startedAt = this.now().toISOString();
    const base: SandboxSelfTestRecord = {
      schemaVersion: "1.0",
      selfTestId: `sandbox-self-test-${this.idFactory()}`,
      platform: capability.platform,
      backendId: "docker-desktop",
      status: "running",
      handleIds: [],
      checks: [],
      startedAt,
      updatedAt: startedAt
    };
    let record = base;
    try {
      const docker = capability.backends.find((backend) => backend.backendId === "docker-desktop");
      if (capability.selectedBackend !== "docker-desktop" || docker?.status !== "ready") {
        return await this.finish(base, "unavailable", docker?.reason ?? "Docker Desktop 不可用", docker?.checks ?? []);
      }
      if (!/^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/iu.test(this.runnerImage)) {
        return await this.finish(base, "unavailable", "未配置固定 digest 的 SKILL_DESIGNER_SANDBOX_IMAGE", [{ id: "runner-image", status: "fail", message: "缺少固定 digest runner 镜像" }]);
      }
      record = { ...base, image: this.runnerImage };
      await this.save(record);
      return await this.executeSelfTest(record);
    } catch (error) {
      return await this.finish(record, "failed", error instanceof Error ? error.message : "隔离自检失败", [{ id: "self-test", status: "fail", message: error instanceof Error ? error.message : "隔离自检失败" }]);
    } finally {
      this.selfTestRunning = false;
    }
  }

  private async executeSelfTest(record: SandboxSelfTestRecord): Promise<SandboxSelfTestRecord> {
    const sourceRoot = path.join(this.dataRoot, "self-test-input", record.selfTestId);
    await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(sourceRoot, "input.txt"), "immutable\n", { mode: 0o600 });
    const policy = defaultSandboxPolicy();
    policy.resources.timeoutMs = 15_000;
    policy.resources.memoryMiB = 256;
    policy.process.maxProcesses = 32;
    const fixture = selfTestFixture(sourceRoot);
    let executionHandle: SandboxHandle | undefined;
    let cancellationHandle: SandboxHandle | undefined;
    try {
      executionHandle = await this.runner.prepare(fixture, policy);
      record.handleIds.push(executionHandle.handleId);
      const script = "const fs=require('node:fs'),net=require('node:net');let inputDenied=false,done=false;try{fs.writeFileSync('/workspace/input/input.txt','changed')}catch{inputDenied=true}const finish=(networkDenied)=>{if(done)return;done=true;const result={inputDenied,networkDenied};fs.writeFileSync('/workspace/output/self-test.json',JSON.stringify(result));process.stdout.write(JSON.stringify(result));};const socket=net.connect({host:'1.1.1.1',port:53});socket.once('connect',()=>{socket.destroy();finish(false)});socket.once('error',()=>finish(true));socket.setTimeout(1200,()=>{socket.destroy();finish(true)});";
      const events = [];
      for await (const event of this.runner.run(executionHandle, { image: this.runnerImage, command: { executable: "node", args: ["-e", script] } }, new AbortController().signal)) events.push(event);
      const status = await this.runner.getStatus(executionHandle.handleId);
      const stdout = events.find((event) => event.type === "sandbox.stdout")?.data.text;
      const behavioral = typeof stdout === "string" ? JSON.parse(stdout) as { inputDenied?: unknown; networkDenied?: unknown } : {};
      record.checks.push(check("input-read-only", behavioral.inputDenied === true, "容器不能修改只读 snapshot 输入"));
      record.checks.push(check("network-none", behavioral.networkDenied === true, "容器默认网络不可达"));
      record.checks.push(check("process-exit", status.handle.state === "completed", "固定自检命令正常结束"));
      const collection = await this.runner.collect(executionHandle);
      record.checks.push(check("output-collection", collection.artifacts.some((artifact) => artifact.path === "self-test.json"), "独立产物目录可收集普通文件"));
      record.checks.push(check("source-unchanged", await readFile(path.join(sourceRoot, "input.txt"), "utf8") === "immutable\n", "宿主自检输入保持不变"));

      cancellationHandle = await this.runner.prepare(fixture, policy);
      record.handleIds.push(cancellationHandle.handleId);
      const iterator = this.runner.run(cancellationHandle, { image: this.runnerImage, command: { executable: "node", args: ["-e", "setInterval(()=>{},1000)"] } }, new AbortController().signal)[Symbol.asyncIterator]();
      const started = await iterator.next();
      const running = iterator.next();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.runner.cancel(cancellationHandle);
      await running;
      const cancellation = await this.runner.getStatus(cancellationHandle.handleId);
      record.checks.push(check("cancel-no-residual", started.value?.type === "sandbox.started" && cancellation.handle.state === "cancelled", "取消会强制删除容器并检查无残留"));

      await this.runner.cleanup(executionHandle);
      await this.runner.cleanup(cancellationHandle);
      const cleaned = await Promise.all(record.handleIds.map((handleId) => this.runner.getStatus(handleId)));
      record.checks.push(check("working-copy-cleaned", cleaned.every((item) => item.handle.state === "cleaned"), "临时工作副本已删除且审计保留"));
      const passed = record.checks.every((item) => item.status === "pass");
      return await this.finish(record, passed ? "passed" : "failed", passed ? "文件、网络、取消和清理自检通过" : "至少一项隔离自检失败", record.checks);
    } finally {
      for (const handle of [executionHandle, cancellationHandle]) {
        if (!handle) continue;
        try {
          const status = await this.runner.getStatus(handle.handleId);
          if (status.handle.state !== "cleaned") await this.runner.cleanup(handle);
        } catch {
          // The primary self-test result records cleanup failures.
        }
      }
      await rm(sourceRoot, { recursive: true, force: true });
    }
  }

  private unavailableRecord(reason: string, checks: SandboxCapabilityCheck[]): SandboxSelfTestRecord {
    const timestamp = this.now().toISOString();
    return {
      schemaVersion: "1.0",
      selfTestId: `sandbox-self-test-${this.idFactory()}`,
      platform: "unsupported",
      backendId: "docker-desktop",
      status: "unavailable",
      handleIds: [],
      checks,
      startedAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
      reason
    };
  }

  private async finish(record: SandboxSelfTestRecord, status: "unavailable" | "passed" | "failed", reason: string, checks: SandboxCapabilityCheck[]): Promise<SandboxSelfTestRecord> {
    const timestamp = this.now().toISOString();
    const finished: SandboxSelfTestRecord = { ...record, status, checks, reason, updatedAt: timestamp, completedAt: timestamp };
    await this.save(finished);
    return finished;
  }

  private async save(record: SandboxSelfTestRecord): Promise<void> {
    const target = this.latestFile();
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, target);
  }

  private latestFile(): string {
    return path.join(this.dataRoot, "self-tests", "latest.json");
  }
}

function check(id: string, passed: boolean, message: string): SandboxCapabilityCheck {
  return { id, status: passed ? "pass" : "fail", message };
}

function selfTestFixture(snapshotRoot: string): { runtimeArtifact: RuntimeArtifact; benchmarkCase: BenchmarkCase; snapshotRoot: string } {
  const skillId = "skill-00000000-0000-4000-8000-000000000035";
  return {
    snapshotRoot,
    runtimeArtifact: {
      schemaVersion: "1.0",
      artifactId: "artifact-00000000-0000-4000-8000-000000000035",
      workspaceId: "workspace-00000000-0000-4000-8000-000000000035",
      projectId: "project-00000000-0000-4000-8000-000000000035",
      skillId,
      revision: "rev-sandbox-self-test",
      contentHash: `sha256:${"0".repeat(64)}`,
      initialVariables: {},
      fingerprint: { schemaVersion: "1.0", algorithm: "sha256", projectContentHash: `sha256:${"0".repeat(64)}`, inputHash: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", value: `sha256:${"1".repeat(64)}` },
      graph: { schemaVersion: "1.0", skillId, capability: "workflow", entry: "self-test", nodes: [{ id: "self-test", title: "Self test", kind: "start" }], edges: [] },
      createdAt: "1970-01-01T00:00:00.000Z"
    },
    benchmarkCase: {
      schemaVersion: "1.0",
      caseId: "case-00000000-0000-4000-8000-000000000035",
      skillId,
      title: "Sandbox isolation self-test",
      status: "ready",
      intent: "Verify fixed isolation behavior",
      fixture: { initialVariables: {}, userReplies: [] },
      expected: { path: { mode: "subsequence", nodeIds: ["self-test"] }, variables: {}, artifacts: [], toolResults: [], forbiddenEffects: [] },
      tags: ["internal", "sandbox"]
    }
  };
}
