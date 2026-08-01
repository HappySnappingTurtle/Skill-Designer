import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSandboxPolicy,
  type BenchmarkCase,
  type LLMProvider,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
  type ModelProviderCapability,
  type PreparedBenchmarkExecution,
  type RuntimeArtifact,
  type SandboxCapabilityReport
} from "@skill-designer/engine";
import { BenchmarkRunnerService } from "../src/benchmark-runner.js";
import { DockerDesktopSandboxRunner, type DockerLifecycleExecutor } from "../src/sandbox-runner.js";

const workspaceId = "workspace-11111111-1111-4111-8111-111111111111";
const projectId = "project-22222222-2222-4222-8222-222222222222";
const skillId = "skill-33333333-3333-4333-8333-333333333333";
const caseId = "case-44444444-4444-4444-8444-444444444444";
const secondCaseId = "case-44444444-4444-4444-8444-444444444445";
const image = `example/runner@sha256:${"d".repeat(64)}`;
let root: string;
let snapshotRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-benchmark-runner-"));
  snapshotRoot = path.join(root, "snapshot");
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(path.join(snapshotRoot, "SKILL.md"), "# Benchmark\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("BenchmarkRunnerService", () => {
  it("persists real-provider usage, isolated snapshot evidence, fingerprint, trace, and assertions", async () => {
    const provider = new ScriptedProvider();
    const prepared = fixture();
    const store = gateway(prepared);
    const executor: DockerLifecycleExecutor = {
      run: async () => ({ exitCode: 0, stdout: Buffer.from("snapshot-ok"), stderr: Buffer.alloc(0) }),
      exec: async () => { throw new Error("No such container"); }
    };
    const sandboxRunner = new DockerDesktopSandboxRunner({
      workRoot: path.join(root, "sandbox"),
      capabilityService: { probe: async () => sandboxCapability(true) },
      executor,
      idFactory: () => "55555555-5555-4555-8555-555555555555",
      now: () => new Date("2026-07-28T07:00:00.000Z")
    });
    const service = new BenchmarkRunnerService({
      dataRoot: path.join(root, "benchmark"),
      store,
      sandboxCapabilities: { probe: async () => sandboxCapability(true) },
      provider,
      runnerImage: image,
      sandboxRunner,
      idFactory: (() => {
        const ids = ["66666666-6666-4666-8666-666666666666", "99999999-9999-4999-8999-999999999991", "99999999-9999-4999-8999-999999999992"];
        return () => ids.shift()!;
      })(),
      now: () => new Date("2026-07-28T07:00:00.000Z")
    });

    const queued = await service.start(projectId, { workspaceId, caseId, reasoningEffort: "low" });
    expect(queued.status).toBe("queued");
    const concurrentReads = await Promise.all(Array.from({ length: 32 }, () => service.get(projectId, queued.benchmarkRunId)));
    expect(concurrentReads.every((record) => record.benchmarkRunId === queued.benchmarkRunId)).toBe(true);
    const completed = await waitForRun(service, queued.benchmarkRunId, "completed");

    expect(completed).toMatchObject({
      status: "completed",
      automaticVerdict: "passed",
      modelCallCount: 1,
      usage: { inputTokens: 24, outputTokens: 8, totalTokens: 32 },
      sandboxHandleIds: ["sandbox-55555555-5555-4555-8555-555555555555"],
      fingerprint: {
        providerId: "scripted-real-provider",
        requestedModel: "real-model",
        resolvedModels: ["real-model-2026-07-01"],
        runtimeArtifactId: prepared.runtimeArtifact.artifactId,
        runnerImage: image
      }
    });
    expect(completed.events.map((event) => event.type)).toEqual(expect.arrayContaining(["sandbox.started", "model.request", "model.response", "engine.complete", "assertion.result", "benchmark.completed"]));
    expect(completed.assertions.every((assertion) => assertion.status === "pass")).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(store.prepareBenchmarkExecution).toHaveBeenCalledTimes(1);
    expect((await service.list(projectId))[0]?.benchmarkRunId).toBe(queued.benchmarkRunId);

    const firstReview = await service.review(projectId, queued.benchmarkRunId, { verdict: "passed", note: "人工检查产物正常" });
    const secondReview = await service.review(projectId, queued.benchmarkRunId, { verdict: "inconclusive", note: "需要补充外部系统证据" });
    expect(firstReview.automaticVerdict).toBe("passed");
    expect(secondReview.humanReviews).toEqual([
      expect.objectContaining({ reviewId: "benchmark-review-99999999-9999-4999-8999-999999999991", verdict: "passed" }),
      expect.objectContaining({ reviewId: "benchmark-review-99999999-9999-4999-8999-999999999992", verdict: "inconclusive" })
    ]);
    expect(secondReview.automaticVerdict).toBe("passed");
    expect(secondReview.events.at(-1)).toMatchObject({ type: "review.recorded", data: { verdict: "inconclusive" } });
  });

  it("blocks before model calls and artifact freezing when the real sandbox is unavailable", async () => {
    const provider = new ScriptedProvider();
    const store = gateway(fixture());
    const service = new BenchmarkRunnerService({
      dataRoot: path.join(root, "benchmark"),
      store,
      sandboxCapabilities: { probe: async () => sandboxCapability(false) },
      provider,
      runnerImage: image,
      idFactory: () => "77777777-7777-4777-8777-777777777777",
      now: () => new Date("2026-07-28T07:00:00.000Z")
    });

    const queued = await service.start(projectId, { workspaceId, caseId });
    const blocked = await waitForRun(service, queued.benchmarkRunId, "blocked");

    expect(blocked).toMatchObject({ status: "blocked", automaticVerdict: "not-run", failure: { category: "sandbox-unavailable" }, modelCallCount: 0, usage: { totalTokens: 0 } });
    expect(provider.calls).toEqual([]);
    expect(store.prepareBenchmarkExecution).not.toHaveBeenCalled();
    await expect(service.review(projectId, queued.benchmarkRunId, { verdict: "passed", note: "不能覆盖阻断" })).rejects.toMatchObject({ code: "benchmark_not_reviewable" });
  });

  it("creates a dedicated post-repair lineage from the report source instead of accepting an ordinary rerun", async () => {
    const provider = new ScriptedProvider();
    const prepared = fixture();
    const store = gateway(prepared);
    const runIds = ["77777777-7777-4777-8777-777777777773", "77777777-7777-4777-8777-777777777774"];
    const executor: DockerLifecycleExecutor = {
      run: async () => ({ exitCode: 0, stdout: Buffer.from("snapshot-ok"), stderr: Buffer.alloc(0) }),
      exec: async () => { throw new Error("No such container"); }
    };
    const sandboxRunner = new DockerDesktopSandboxRunner({
      workRoot: path.join(root, "sandbox-post-repair"),
      capabilityService: { probe: async () => sandboxCapability(true) },
      executor,
      idFactory: () => "55555555-5555-4555-8555-555555555556",
      now: () => new Date("2026-07-28T07:00:00.000Z")
    });
    const service = new BenchmarkRunnerService({
      dataRoot: path.join(root, "benchmark-post-repair"),
      store,
      sandboxCapabilities: { probe: async () => sandboxCapability(true) },
      provider,
      runnerImage: image,
      sandboxRunner,
      idFactory: () => runIds.shift()!,
      now: () => new Date("2026-07-28T07:00:00.000Z")
    });
    const parent = await service.start(projectId, { workspaceId, caseId, model: "source-model", reasoningEffort: "high" });
    await waitForRun(service, parent.benchmarkRunId, "completed");
    const repairId = "repair-88888888-8888-4888-8888-888888888881";
    const reportImportId = "report-import-88888888-8888-4888-8888-888888888882";
    const changeSetId = "changeset-88888888-8888-4888-8888-888888888883";
    store.preparePostRepairBenchmark.mockResolvedValue({
      projectId,
      skillId,
      caseId,
      parentBenchmarkRunId: parent.benchmarkRunId,
      sourceRevision: prepared.runtimeArtifact.revision,
      sourceArtifactId: prepared.runtimeArtifact.artifactId,
      repairId,
      changeSetId,
      appliedRevision: "rev-20260728070100-repair"
    });

    const queued = await service.startPostRepair(workspaceId, reportImportId, repairId, {});
    expect(queued).toMatchObject({
      caseId,
      fingerprint: { requestedModel: "source-model", reasoningEffort: "high" },
      lineage: {
        relation: "post-repair",
        parentBenchmarkRunId: parent.benchmarkRunId,
        repairId,
        changeSetId,
        appliedRevision: "rev-20260728070100-repair"
      }
    });
    await waitForRun(service, queued.benchmarkRunId, "completed");
    expect(store.preparePostRepairBenchmark).toHaveBeenCalledWith(workspaceId, reportImportId, repairId);
    expect(provider.calls).toHaveLength(2);
  });

  it("validates a complete batch before preserving FIFO records", async () => {
    const provider = new ScriptedProvider();
    const first = fixture();
    const second = structuredClone(first);
    second.benchmarkCase.caseId = secondCaseId;
    second.benchmarkCase.title = "第二个真实 Runner";
    const store = {
      readBenchmarkCase: vi.fn(async (_projectId: string, requestedCaseId: string) => {
        const prepared = requestedCaseId === caseId ? first : second;
        return { case: prepared.benchmarkCase, path: `benchmarks/cases/${requestedCaseId}.json`, activeRevision: prepared.runtimeArtifact.revision, issues: [] };
      }),
      prepareBenchmarkExecution: vi.fn(),
      createBenchmarkBugReport: vi.fn(),
      preparePostRepairBenchmark: vi.fn(),
      verifyDiagnosisRepairWithBenchmark: vi.fn()
    };
    const runIds = ["77777777-7777-4777-8777-777777777771", "77777777-7777-4777-8777-777777777772"];
    const service = new BenchmarkRunnerService({
      dataRoot: path.join(root, "benchmark-batch"),
      store,
      sandboxCapabilities: { probe: async () => sandboxCapability(false) },
      provider,
      runnerImage: image,
      idFactory: () => runIds.shift()!,
      now: () => new Date("2026-07-28T07:00:00.000Z")
    });

    const queued = await service.startBatch(projectId, { workspaceId, caseIds: [caseId, secondCaseId], model: "real-model", reasoningEffort: "medium" });
    expect(queued.map((record) => record.caseId)).toEqual([caseId, secondCaseId]);
    expect(queued.map((record) => record.events[0]?.data.queuePosition)).toEqual([1, 2]);
    await Promise.all(queued.map((record) => waitForRun(service, record.benchmarkRunId, "blocked")));
    expect((await service.list(projectId)).map((record) => record.caseId)).toEqual(expect.arrayContaining([caseId, secondCaseId]));
    expect(provider.calls).toHaveLength(0);
    expect(store.prepareBenchmarkExecution).not.toHaveBeenCalled();

    const invalid = structuredClone(second);
    invalid.benchmarkCase.status = "draft";
    store.readBenchmarkCase.mockImplementation(async (_projectId: string, requestedCaseId: string) => {
      const prepared = requestedCaseId === caseId ? first : invalid;
      return { case: prepared.benchmarkCase, path: `benchmarks/cases/${requestedCaseId}.json`, activeRevision: prepared.runtimeArtifact.revision, issues: [] };
    });
    await expect(service.startBatch(projectId, { workspaceId, caseIds: [caseId, secondCaseId] })).rejects.toMatchObject({ code: "benchmark_case_not_ready" });
    expect(await service.list(projectId)).toHaveLength(2);
  });
});

class ScriptedProvider implements LLMProvider {
  calls: ModelInvocationRequest[] = [];
  async probe(): Promise<ModelProviderCapability> {
    return { schemaVersion: "1.0", providerId: "scripted-real-provider", label: "Scripted protocol provider", status: "ready", keyConfigured: true, defaultModel: "real-model", reason: "configured", checkedAt: "2026-07-28T07:00:00.000Z" };
  }
  async invoke<T>(request: ModelInvocationRequest): Promise<ModelInvocationResponse<T>> {
    this.calls.push(request);
    return {
      providerId: "scripted-real-provider",
      responseId: "response-real-1",
      model: "real-model-2026-07-01",
      output: { decision: "advance", nextNodeId: "flow.end", summary: "完成流程" } as T,
      usage: { inputTokens: 24, outputTokens: 8, totalTokens: 32, cachedInputTokens: 4, reasoningTokens: 2, cacheWriteTokens: 0 },
      durationMs: 120
    };
  }
}

function gateway(prepared: PreparedBenchmarkExecution) {
  return {
    readBenchmarkCase: vi.fn(async () => ({ case: prepared.benchmarkCase, path: `benchmarks/cases/${caseId}.json`, activeRevision: prepared.runtimeArtifact.revision, issues: [] })),
    prepareBenchmarkExecution: vi.fn(async () => prepared),
    createBenchmarkBugReport: vi.fn(),
    preparePostRepairBenchmark: vi.fn(),
    verifyDiagnosisRepairWithBenchmark: vi.fn()
  };
}

function fixture(): PreparedBenchmarkExecution {
  const graph: RuntimeArtifact["graph"] = {
    schemaVersion: "1.0",
    skillId,
    capability: "workflow",
    entry: "flow.start",
    nodes: [
      { id: "flow.start", kind: "start", title: "开始" },
      { id: "flow.step", kind: "step", title: "处理" },
      { id: "flow.end", kind: "end", title: "完成" }
    ],
    edges: [
      { id: "edge.start-step", from: "flow.start", to: "flow.step", kind: "flow" },
      { id: "edge.step-end", from: "flow.step", to: "flow.end", kind: "flow" }
    ]
  };
  const benchmarkCase: BenchmarkCase = {
    schemaVersion: "1.0",
    caseId,
    skillId,
    title: "真实 Runner",
    status: "ready",
    intent: "走完整条路径",
    fixture: { initialVariables: {}, userReplies: [] },
    expected: { path: { mode: "exact", nodeIds: ["flow.start", "flow.step", "flow.end"] }, terminal: { status: "completed", nodeId: "flow.end" }, variables: {}, artifacts: [], toolResults: [], forbiddenEffects: ["host-write", "network-access"] },
    tags: ["runner"]
  };
  return {
    benchmarkCase,
    snapshotRoot,
    documents: {},
    runtimeArtifact: {
      schemaVersion: "1.0",
      artifactId: "artifact-88888888-8888-4888-8888-888888888888",
      workspaceId,
      projectId,
      skillId,
      revision: "rev-20260728070000-test",
      contentHash: `sha256:${"a".repeat(64)}`,
      initialVariables: {},
      fingerprint: { schemaVersion: "1.0", algorithm: "sha256", projectContentHash: `sha256:${"a".repeat(64)}`, inputHash: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", value: `sha256:${"b".repeat(64)}` },
      graph,
      createdAt: "2026-07-28T07:00:00.000Z"
    }
  };
}

function sandboxCapability(ready: boolean): SandboxCapabilityReport {
  return {
    schemaVersion: "1.0",
    platform: "macos",
    arch: "arm64",
    status: ready ? "ready" : "unavailable",
    readyForBenchmark: ready,
    ...(ready ? { selectedBackend: "docker-desktop" as const } : {}),
    policy: defaultSandboxPolicy(),
    backends: [{ backendId: "docker-desktop", label: "Docker Desktop", status: ready ? "ready" : "unavailable", isolationLevel: ready ? "container-vm-standard" : "none", reason: ready ? "self-test passed" : "Docker unavailable", checks: [], limitations: [] }],
    checkedAt: "2026-07-28T07:00:00.000Z"
  };
}

async function waitForRun(service: BenchmarkRunnerService, runId: string, status: "completed" | "blocked") {
  const started = Date.now();
  for (;;) {
    const record = await service.get(projectId, runId);
    if (record.status === status) return record;
    if (Date.now() - started > 2_000) throw new Error(`timed out waiting for ${status}, got ${record.status}: ${JSON.stringify(record.failure ?? null)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
