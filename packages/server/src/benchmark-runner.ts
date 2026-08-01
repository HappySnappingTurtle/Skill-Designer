import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  advanceRuntime,
  availableTransitions,
  createRuntimeState,
  defaultSandboxPolicy,
  evaluateTransitionConditions,
  evaluateBenchmarkAssertions,
  executeProjectFactQueries,
  sliceDocument,
  stopRuntime,
  type BenchmarkCapabilityReport,
  type BenchmarkFailureCategory,
  type BenchmarkModelDecision,
  type BenchmarkHumanReview,
  type BenchmarkHumanVerdict,
  type BenchmarkObservedResult,
  type BenchmarkRunRecord,
  type BenchmarkTraceEvent,
  type BugReportRecord,
  type DiagnosisRepairRecord,
  type LLMProvider,
  type ModelReasoningEffort,
  type ModelUsage,
  type PreparedBenchmarkExecution,
  type ProjectBenchmarkCase,
  type RuntimeEngineEvent,
  type SandboxAuditEvent,
  type SandboxCapabilityReport,
  type SandboxHandle,
  type SandboxRunner
} from "@skill-designer/engine";
import { AppError } from "./errors.js";
import { ModelProviderError } from "./model-provider.js";
import { DockerDesktopSandboxRunner } from "./sandbox-runner.js";

const PROMPT_TEMPLATE_VERSION = "benchmark-decision/1";
const MAX_STEPS = 40;
const MAX_NODE_CONTEXT_CHARS = 24_000;
const ZERO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 };
const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["advance", "stop"] },
    nextNodeId: { type: ["string", "null"] },
    summary: { type: "string", maxLength: 2000 }
  },
  required: ["decision", "nextNodeId", "summary"]
};

export interface BenchmarkProjectGateway {
  readBenchmarkCase(projectId: string, caseId: string): Promise<ProjectBenchmarkCase>;
  prepareBenchmarkExecution(projectId: string, workspaceId: string, caseId: string): Promise<PreparedBenchmarkExecution>;
  createBenchmarkBugReport(projectId: string, benchmarkRun: BenchmarkRunRecord, input: unknown): Promise<BugReportRecord>;
  preparePostRepairBenchmark(workspaceId: string, reportImportId: string, repairId: string, requireCurrentRevision?: boolean): Promise<{ projectId: string; skillId: string; caseId: string; parentBenchmarkRunId: string; sourceRevision: string; sourceArtifactId: string; repairId: string; changeSetId: string; appliedRevision: string }>;
  verifyDiagnosisRepairWithBenchmark(workspaceId: string, reportImportId: string, repairId: string, run: BenchmarkRunRecord, parent: BenchmarkRunRecord): Promise<DiagnosisRepairRecord>;
}

export interface BenchmarkRunnerServiceOptions {
  dataRoot: string;
  store: BenchmarkProjectGateway;
  sandboxCapabilities: { probe(): Promise<SandboxCapabilityReport> };
  provider: LLMProvider;
  runnerImage?: string;
  sandboxRunner?: BenchmarkSandboxRunner;
  now?: () => Date;
  idFactory?: () => string;
}

export interface BenchmarkSandboxRunner extends SandboxRunner {
  getStatus(handleId: string): Promise<{ handle: SandboxHandle; auditEvents: SandboxAuditEvent[] }>;
}

interface StartBenchmarkInput {
  workspaceId: string;
  caseId: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
}

interface StartBenchmarkBatchInput {
  workspaceId: string;
  caseIds: string[];
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  lineage?: BenchmarkRunRecord["lineage"];
}

export class BenchmarkRunnerService {
  private readonly dataRoot: string;
  private readonly store: BenchmarkProjectGateway;
  private readonly sandboxCapabilities: { probe(): Promise<SandboxCapabilityReport> };
  private readonly provider: LLMProvider;
  private readonly runnerImage: string;
  private readonly sandboxRunner: BenchmarkSandboxRunner;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private draining = false;

  constructor(options: BenchmarkRunnerServiceOptions) {
    this.dataRoot = path.resolve(options.dataRoot);
    this.store = options.store;
    this.sandboxCapabilities = options.sandboxCapabilities;
    this.provider = options.provider;
    this.runnerImage = options.runnerImage?.trim() ?? "";
    this.sandboxRunner = options.sandboxRunner ?? new DockerDesktopSandboxRunner({ workRoot: path.join(this.dataRoot, "sandboxes") });
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async initialize(): Promise<void> {
    await mkdir(this.runRoot(), { recursive: true, mode: 0o700 });
    for (const project of await readdir(this.runRoot(), { withFileTypes: true })) {
      if (!project.isDirectory() || !/^project-[0-9a-f-]{36}$/iu.test(project.name)) continue;
      for (const entry of await readdir(path.join(this.runRoot(), project.name), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const record = JSON.parse(await readFile(path.join(this.runRoot(), project.name, entry.name), "utf8")) as BenchmarkRunRecord;
        if (record.status !== "queued" && record.status !== "preparing" && record.status !== "running") continue;
        record.status = "failed";
        record.automaticVerdict = "not-run";
        record.failure = { category: "internal-error", message: "服务重启中断了未完成的 Benchmark" };
        this.append(record, "benchmark.failed", { category: record.failure.category, message: record.failure.message });
        record.completedAt = record.updatedAt;
        await this.save(record);
      }
    }
  }

  async capabilities(): Promise<BenchmarkCapabilityReport> {
    const [provider, sandbox] = await Promise.all([this.provider.probe(), this.sandboxCapabilities.probe()]);
    const blockers: string[] = [];
    if (provider.status !== "ready") blockers.push(provider.reason);
    if (!sandbox.readyForBenchmark) blockers.push("真实沙箱生命周期自检未通过");
    if (!validRunnerImage(this.runnerImage)) blockers.push("未配置固定 digest 的 runner 镜像");
    return { schemaVersion: "1.0", ready: blockers.length === 0, provider, sandbox, blockers, checkedAt: this.now().toISOString() };
  }

  async start(projectId: string, input: unknown): Promise<BenchmarkRunRecord> {
    assertProjectId(projectId);
    const value = asRecord(input);
    if (!value || typeof value.workspaceId !== "string" || typeof value.caseId !== "string") throw new AppError(400, "invalid_benchmark_start", "启动 Benchmark 需要 workspaceId 和 caseId");
    let lineage: BenchmarkRunRecord["lineage"];
    if (value.parentBenchmarkRunId !== undefined) {
      if (typeof value.parentBenchmarkRunId !== "string" || !/^benchmark-run-[0-9a-f-]{36}$/iu.test(value.parentBenchmarkRunId)) throw new AppError(400, "invalid_benchmark_parent", "父 Benchmark Run ID 无效");
      const parent = await this.read(projectId, value.parentBenchmarkRunId);
      if (parent.workspaceId !== value.workspaceId || parent.caseId !== value.caseId || activeBenchmarkStatus(parent.status)) throw new AppError(409, "benchmark_parent_mismatch", "只能基于同一 Workspace、同一用例的已结束运行重跑");
      lineage = { parentBenchmarkRunId: parent.benchmarkRunId, relation: "rerun" };
    }
    const [record] = await this.enqueue(projectId, {
      workspaceId: value.workspaceId,
      caseIds: [value.caseId],
      ...(lineage ? { lineage } : {}),
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(value.reasoningEffort !== undefined ? { reasoningEffort: value.reasoningEffort as ModelReasoningEffort } : {})
    });
    return record!;
  }

  async startBatch(projectId: string, input: unknown): Promise<BenchmarkRunRecord[]> {
    assertProjectId(projectId);
    const value = asRecord(input);
    if (!value || typeof value.workspaceId !== "string" || !Array.isArray(value.caseIds)) throw new AppError(400, "invalid_benchmark_batch", "批量 Benchmark 需要 workspaceId 和 caseIds");
    if (value.caseIds.length < 1 || value.caseIds.length > 50 || value.caseIds.some((caseId) => typeof caseId !== "string")) {
      throw new AppError(400, "invalid_benchmark_batch", "每批必须选择 1 到 50 个用例");
    }
    const caseIds = value.caseIds as string[];
    if (new Set(caseIds).size !== caseIds.length) throw new AppError(400, "duplicate_benchmark_case", "同一批次不能重复选择用例");
    return this.enqueue(projectId, {
      workspaceId: value.workspaceId,
      caseIds,
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(value.reasoningEffort !== undefined ? { reasoningEffort: value.reasoningEffort as ModelReasoningEffort } : {})
    });
  }

  async list(projectId: string): Promise<BenchmarkRunRecord[]> {
    assertProjectId(projectId);
    try {
      const entries = await readdir(path.join(this.runRoot(), projectId), { withFileTypes: true });
      const records = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => this.read(projectId, entry.name.slice(0, -5))));
      return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async get(projectId: string, benchmarkRunId: string): Promise<BenchmarkRunRecord> {
    assertProjectId(projectId);
    assertBenchmarkRunId(benchmarkRunId);
    return structuredClone(await this.read(projectId, benchmarkRunId));
  }

  async cancel(projectId: string, benchmarkRunId: string): Promise<BenchmarkRunRecord> {
    const record = await this.read(projectId, benchmarkRunId);
    if (["completed", "failed", "cancelled", "blocked"].includes(record.status)) return structuredClone(record);
    const queueIndex = this.queue.indexOf(benchmarkRunId);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    const controller = this.controllers.get(benchmarkRunId);
    if (controller) {
      controller.abort();
      return structuredClone(record);
    }
    record.status = "cancelled";
    record.failure = { category: "cancelled", message: "Benchmark 已在启动前取消" };
    this.append(record, "benchmark.cancelled", {});
    record.completedAt = record.updatedAt;
    await this.save(record);
    return structuredClone(record);
  }

  async review(projectId: string, benchmarkRunId: string, input: unknown): Promise<BenchmarkRunRecord> {
    const record = await this.read(projectId, benchmarkRunId);
    if (record.status !== "completed") throw new AppError(409, "benchmark_not_reviewable", "只有技术执行完成的 Benchmark 才能保存人工判定");
    const value = asRecord(input);
    if (!value || !isHumanVerdict(value.verdict) || typeof value.note !== "string" || value.note.length > 4000) {
      throw new AppError(400, "invalid_benchmark_review", "人工判定需要有效 verdict 和不超过 4000 字的备注");
    }
    const reviewId = `benchmark-review-${this.idFactory()}`;
    if (!/^benchmark-review-[0-9a-f-]{36}$/iu.test(reviewId)) throw new AppError(500, "invalid_benchmark_review_id", "Benchmark Review ID 无效");
    const review: BenchmarkHumanReview = { reviewId, verdict: value.verdict, note: value.note.trim(), createdAt: this.now().toISOString() };
    record.humanReviews.push(review);
    this.append(record, "review.recorded", { reviewId, verdict: review.verdict, noteLength: review.note.length });
    await this.save(record);
    return structuredClone(record);
  }

  async createReport(projectId: string, benchmarkRunId: string, input: unknown): Promise<BugReportRecord> {
    const record = await this.read(projectId, benchmarkRunId);
    return this.store.createBenchmarkBugReport(projectId, record, input);
  }

  async startPostRepair(workspaceId: string, reportImportId: string, repairId: string, input: unknown): Promise<BenchmarkRunRecord> {
    const context = await this.store.preparePostRepairBenchmark(workspaceId, reportImportId, repairId);
    const parent = await this.read(context.projectId, context.parentBenchmarkRunId);
    if (parent.workspaceId !== workspaceId || parent.projectId !== context.projectId || parent.skillId !== context.skillId || parent.caseId !== context.caseId
      || parent.fingerprint.revision !== context.sourceRevision || parent.fingerprint.runtimeArtifactId !== context.sourceArtifactId || activeBenchmarkStatus(parent.status)) {
      throw new AppError(409, "post_repair_parent_mismatch", "报告来源 Benchmark 记录不存在或身份不一致");
    }
    const value = asRecord(input) ?? {};
    const [record] = await this.enqueue(context.projectId, {
      workspaceId,
      caseIds: [context.caseId],
      model: typeof value.model === "string" && value.model.trim() ? value.model : parent.fingerprint.requestedModel,
      reasoningEffort: value.reasoningEffort === undefined ? parent.fingerprint.reasoningEffort : value.reasoningEffort as ModelReasoningEffort,
      lineage: {
        parentBenchmarkRunId: parent.benchmarkRunId,
        relation: "post-repair",
        repairId: context.repairId,
        changeSetId: context.changeSetId,
        appliedRevision: context.appliedRevision
      }
    });
    return record!;
  }

  async verifyPostRepair(workspaceId: string, reportImportId: string, repairId: string, benchmarkRunId: string): Promise<DiagnosisRepairRecord> {
    assertBenchmarkRunId(benchmarkRunId);
    const context = await this.store.preparePostRepairBenchmark(workspaceId, reportImportId, repairId, false);
    const run = await this.read(context.projectId, benchmarkRunId);
    if (!run.lineage || run.lineage.relation !== "post-repair") throw new AppError(409, "post_repair_lineage_mismatch", "该 Benchmark 不是由修复记录发起的验证运行");
    const parent = await this.read(context.projectId, run.lineage.parentBenchmarkRunId);
    return this.store.verifyDiagnosisRepairWithBenchmark(workspaceId, reportImportId, repairId, run, parent);
  }

  private async enqueue(projectId: string, input: StartBenchmarkBatchInput): Promise<BenchmarkRunRecord[]> {
    assertWorkspaceId(input.workspaceId);
    for (const caseId of input.caseIds) assertCaseId(caseId);
    const reasoningEffort = input.reasoningEffort ?? "low";
    if (!isReasoningEffort(reasoningEffort)) throw new AppError(400, "invalid_reasoning_effort", "模型 reasoning effort 无效");
    const [projectCases, provider, sandbox] = await Promise.all([
      Promise.all(input.caseIds.map((caseId) => this.store.readBenchmarkCase(projectId, caseId))),
      this.provider.probe(),
      this.sandboxCapabilities.probe()
    ]);
    const invalidCases = projectCases.filter((projectCase) => projectCase.case.status !== "ready" || projectCase.issues.some((issue) => issue.severity === "error"));
    if (invalidCases.length) {
      throw new AppError(422, "benchmark_case_not_ready", "批次中的所有用例都必须是校验通过的 ready 用例", invalidCases.map((item) => ({ caseId: item.case.caseId, issues: item.issues })));
    }
    const model = input.model?.trim() || provider.defaultModel;
    if (!/^[a-z0-9][a-z0-9._-]{1,120}$/iu.test(model)) throw new AppError(400, "invalid_model", "模型 ID 无效");
    const records = projectCases.map((projectCase, index) => {
      const timestamp = this.now().toISOString();
      const benchmarkRunId = `benchmark-run-${this.idFactory()}`;
      if (!/^benchmark-run-[0-9a-f-]{36}$/iu.test(benchmarkRunId)) throw new AppError(500, "invalid_benchmark_run_id", "Benchmark Run ID 无效");
      const record: BenchmarkRunRecord = {
        schemaVersion: "1.0",
        benchmarkRunId,
        workspaceId: input.workspaceId,
        projectId,
        skillId: projectCase.case.skillId,
        caseId: projectCase.case.caseId,
        status: "queued",
        automaticVerdict: "not-run",
        fingerprint: {
          schemaVersion: "1.0",
          providerId: provider.providerId,
          requestedModel: model,
          resolvedModels: [],
          reasoningEffort,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
          runnerImage: this.runnerImage,
          sandboxBackendId: "docker-desktop",
          sandboxPolicyHash: hash(defaultSandboxPolicy())
        },
        usage: { ...ZERO_USAGE },
        modelCallCount: 0,
        sandboxHandleIds: [],
        events: [],
        assertions: [],
        humanReviews: [],
        ...(input.lineage ? { lineage: input.lineage } : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.append(record, "benchmark.queued", { queuePosition: this.queue.length + index + 1, sandboxReady: sandbox.readyForBenchmark, providerConfigured: provider.keyConfigured, ...(input.lineage ? { parentBenchmarkRunId: input.lineage.parentBenchmarkRunId, relation: input.lineage.relation } : {}) });
      return record;
    });
    await Promise.all(records.map((record) => this.save(record)));
    this.queue.push(...records.map((record) => record.benchmarkRunId));
    void this.drain();
    return structuredClone(records);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const benchmarkRunId = this.queue.shift()!;
        const record = await this.find(benchmarkRunId);
        if (!record || record.status !== "queued") continue;
        const controller = new AbortController();
        this.controllers.set(benchmarkRunId, controller);
        try {
          await this.execute(record, controller.signal);
        } finally {
          this.controllers.delete(benchmarkRunId);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(record: BenchmarkRunRecord, signal: AbortSignal): Promise<void> {
    const handles: SandboxHandle[] = [];
    try {
      record.status = "preparing";
      record.startedAt = this.now().toISOString();
      this.append(record, "benchmark.preflight", {});
      await this.save(record);
      const capabilities = await this.capabilities();
      if (!capabilities.ready) return await this.block(record, capabilities.blockers.join("；"), capabilities.provider.status !== "ready" ? "provider-unavailable" : "sandbox-unavailable");
      throwIfCancelled(signal);
      const prepared = await this.store.prepareBenchmarkExecution(record.projectId, record.workspaceId, record.caseId);
      Object.assign(record.fingerprint, {
        runtimeArtifactId: prepared.runtimeArtifact.artifactId,
        revision: prepared.runtimeArtifact.revision,
        contentHash: prepared.runtimeArtifact.contentHash
      });
      record.status = "running";
      await this.save(record);

      const policy = defaultSandboxPolicy();
      const baselineHandle = await this.sandboxRunner.prepare({ runtimeArtifact: prepared.runtimeArtifact, benchmarkCase: prepared.benchmarkCase, snapshotRoot: prepared.snapshotRoot }, policy);
      handles.push(baselineHandle);
      record.sandboxHandleIds.push(baselineHandle.handleId);
      this.append(record, "sandbox.prepared", { handleId: baselineHandle.handleId, purpose: "snapshot-read" });
      await this.consumeSandbox(record, baselineHandle, ["-e", "require('node:fs').accessSync('/workspace/input/SKILL.md')"], signal);
      const baselineCollection = await this.sandboxRunner.collect(baselineHandle);
      this.append(record, "sandbox.collected", { handleId: baselineHandle.handleId, fileCount: baselineCollection.artifacts.length });
      await this.sandboxRunner.cleanup(baselineHandle);
      await this.appendSandboxStatus(record, baselineHandle.handleId);

      const initialized = createRuntimeState(prepared.runtimeArtifact.graph, prepared.benchmarkCase.fixture.initialVariables);
      let state = initialized.state;
      this.appendEngine(record, initialized.events);
      const artifacts: BenchmarkObservedResult["artifacts"] = [];
      const toolResults: BenchmarkObservedResult["toolResults"] = [];
      const observedEffects: string[] = [];
      const summaries: string[] = [];

      for (let step = 0; state.status === "running"; step++) {
        throwIfCancelled(signal);
        if (step >= MAX_STEPS) throw new BenchmarkExecutionError("engine-error", `运行超过 ${MAX_STEPS} 个节点步骤`);
        const graph = prepared.runtimeArtifact.graph;
        const node = graph.nodes.find((item) => item.id === state.currentNodeId);
        if (!node) throw new BenchmarkExecutionError("engine-error", "当前节点不存在");
        const command = parseBenchmarkCommand(node.extensions?.benchmarkCommand);
        if (command) {
          const toolHandle = await this.sandboxRunner.prepare({ runtimeArtifact: prepared.runtimeArtifact, benchmarkCase: prepared.benchmarkCase, snapshotRoot: prepared.snapshotRoot }, policy);
          handles.push(toolHandle);
          record.sandboxHandleIds.push(toolHandle.handleId);
          this.append(record, "sandbox.prepared", { handleId: toolHandle.handleId, purpose: "action", nodeId: node.id }, node.id);
          const toolEvents = await this.consumeSandbox(record, toolHandle, command.args, signal, command.executable);
          const collection = await this.sandboxRunner.collect(toolHandle);
          artifacts.push(...collection.artifacts);
          this.append(record, "sandbox.collected", { handleId: toolHandle.handleId, fileCount: collection.artifacts.length }, node.id);
          const stdout = toolEvents.filter((event) => event.type === "sandbox.stdout").map((event) => String(event.data.text ?? "")).join("");
          const stderr = toolEvents.filter((event) => event.type === "sandbox.stderr").map((event) => String(event.data.text ?? "")).join("");
          const result = { stdout, stderr, handleId: toolHandle.handleId };
          toolResults.push({ tool: command.tool, result });
          this.append(record, "tool.result", { nodeId: node.id, tool: command.tool, handleId: toolHandle.handleId, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) }, node.id);
          await this.sandboxRunner.cleanup(toolHandle);
          await this.appendSandboxStatus(record, toolHandle.handleId);
        }

        const conditionEvaluations = evaluateTransitionConditions(graph, state);
        if (conditionEvaluations.length) this.append(record, "condition.evaluated", { evaluations: conditionEvaluations }, node.id);
        const context = nodeContext(prepared, node.id);
        if (context.path) this.append(record, "document.context", { path: context.path, anchor: context.anchor, status: context.status, contentCharacters: context.content.length, truncated: context.truncated }, node.id);
        const projectFacts = executeProjectFactQueries(graph, prepared.documents, node.lookup ?? []);
        if (projectFacts.length) this.append(record, "context.queried", {
          queries: projectFacts.map((fact) => ({
            queryId: fact.queryId,
            kind: fact.kind,
            status: fact.status,
            valueCharacters: fact.value === undefined ? 0 : JSON.stringify(fact.value).length,
            ...(fact.degradation ? { degradation: fact.degradation } : {})
          }))
        }, node.id);
        const transitions = availableTransitions(graph, state);
        if (!transitions.length) {
          const stopped = stopRuntime(graph, state);
          state = stopped.state;
          this.appendEngine(record, stopped.events);
          break;
        }
        const target = transitions.length === 1 ? graph.nodes.find((item) => item.id === transitions[0]!.to) : undefined;
        const deterministicStart = node.kind === "start" && transitions.length === 1 && target?.kind !== "end";
        let nextNodeId: string;
        if (deterministicStart) {
          nextNodeId = transitions[0]!.to;
        } else {
          this.append(record, "model.request", { nodeId: node.id, allowedNodeIds: transitions.map((item) => item.to), contextCharacters: context.content.length }, node.id);
          await this.save(record);
          const response = await this.provider.invoke<BenchmarkModelDecision>({
            model: record.fingerprint.requestedModel,
            reasoningEffort: record.fingerprint.reasoningEffort,
            instructions: "你正在执行一个通用 Skill 的真实 Benchmark。只能从 allowedTransitions 选择下一节点，不能发明节点、命令或工具。证据不足时选择 stop。只返回给定结构。",
            input: {
              caseIntent: prepared.benchmarkCase.intent,
              currentNode: { id: node.id, kind: node.kind, title: node.title, description: node.description ?? "" },
              allowedTransitions: transitions.map((item) => ({ ...item, targetTitle: graph.nodes.find((candidate) => candidate.id === item.to)?.title ?? item.to })),
              nodeContext: context.content,
              projectFacts: boundedProjectFacts(projectFacts),
              userReplies: prepared.benchmarkCase.fixture.userReplies.filter((reply) => !reply.nodeId || reply.nodeId === node.id),
              priorSummaries: summaries.slice(-4),
              variables: state.skillVariables,
              toolResults: compactToolResults(toolResults.slice(-2))
            },
            responseSchema: { name: "skill_benchmark_decision", schema: DECISION_SCHEMA }
          }, signal);
          record.modelCallCount++;
          addUsage(record.usage, response.usage);
          if (!record.fingerprint.resolvedModels.includes(response.model)) record.fingerprint.resolvedModels.push(response.model);
          const decision = validateDecision(response.output, transitions.map((item) => item.to));
          summaries.push(decision.summary);
          this.append(record, "model.response", { nodeId: node.id, responseId: response.responseId, model: response.model, decision: decision.decision, nextNodeId: decision.nextNodeId, summary: decision.summary, usage: response.usage, durationMs: response.durationMs }, node.id);
          if (decision.decision === "stop") {
            const stopped = stopRuntime(graph, state);
            state = stopped.state;
            this.appendEngine(record, stopped.events);
            break;
          }
          nextNodeId = decision.nextNodeId!;
        }
        const advanced = advanceRuntime(graph, state, nextNodeId);
        state = advanced.state;
        this.appendEngine(record, advanced.events);
        if (!advanced.accepted) throw new BenchmarkExecutionError("model-protocol-error", advanced.rejection?.message ?? "模型提交了非法下一节点");
        await this.save(record);
      }

      if (record.modelCallCount < 1 || record.usage.totalTokens < 1) throw new BenchmarkExecutionError("usage-missing", "真实模型调用没有返回可验证的 token usage");
      const evaluated = evaluateBenchmarkAssertions(prepared.benchmarkCase, {
        visitedNodeIds: state.visitedNodeIds,
        terminal: { status: state.status === "completed" ? "completed" : "stopped", nodeId: state.currentNodeId },
        variables: state.skillVariables,
        artifacts,
        toolResults,
        observedEffects
      });
      record.assertions = evaluated.assertions;
      record.automaticVerdict = evaluated.verdict;
      for (const assertion of evaluated.assertions) this.append(record, "assertion.result", { assertionId: assertion.assertionId, kind: assertion.kind, status: assertion.status, message: assertion.message });
      record.status = "completed";
      this.append(record, "benchmark.completed", { automaticVerdict: evaluated.verdict, modelCallCount: record.modelCallCount, totalTokens: record.usage.totalTokens });
      record.completedAt = record.updatedAt;
      await this.save(record);
    } catch (error) {
      if (signal.aborted || (error instanceof ModelProviderError && error.category === "cancelled")) {
        record.status = "cancelled";
        record.automaticVerdict = "not-run";
        record.failure = { category: "cancelled", message: "Benchmark 已取消" };
        this.append(record, "benchmark.cancelled", {});
      } else {
        const failure = classifyFailure(error);
        record.status = "failed";
        record.automaticVerdict = "not-run";
        record.failure = failure;
        this.append(record, "benchmark.failed", failure);
      }
      record.completedAt = record.updatedAt;
      await this.save(record);
    } finally {
      for (const handle of handles) {
        try {
          const status = await this.sandboxRunner.getStatus(handle.handleId);
          if (status.handle.state !== "cleaned") await this.sandboxRunner.cleanup(handle);
        } catch {
          // The run record retains the handle for follow-up diagnostics.
        }
      }
    }
  }

  private async consumeSandbox(record: BenchmarkRunRecord, handle: SandboxHandle, args: string[], signal: AbortSignal, executable = "node"): Promise<SandboxAuditEvent[]> {
    const events: SandboxAuditEvent[] = [];
    for await (const event of this.sandboxRunner.run(handle, { image: this.runnerImage, command: { executable, args } }, signal)) {
      events.push(event);
      this.append(record, event.type, { handleId: handle.handleId, ...event.data });
      await this.save(record);
    }
    const status = await this.sandboxRunner.getStatus?.(handle.handleId);
    if (status && status.handle.state !== "completed") throw new BenchmarkExecutionError("tool-error", `沙箱命令未成功完成：${status.handle.state}`);
    return events;
  }

  private async appendSandboxStatus(record: BenchmarkRunRecord, handleId: string): Promise<void> {
    const status = await this.sandboxRunner.getStatus?.(handleId);
    if (!status) return;
    const last = status.auditEvents.at(-1);
    if (last?.type === "sandbox.cleaned") this.append(record, last.type, { handleId, ...last.data });
    await this.save(record);
  }

  private async block(record: BenchmarkRunRecord, message: string, category: "sandbox-unavailable" | "provider-unavailable"): Promise<void> {
    record.status = "blocked";
    record.automaticVerdict = "not-run";
    record.failure = { category, message };
    this.append(record, "benchmark.blocked", { category, message });
    record.completedAt = record.updatedAt;
    await this.save(record);
  }

  private appendEngine(record: BenchmarkRunRecord, events: RuntimeEngineEvent[]): void {
    for (const event of events) this.append(record, event.type, event.data, event.nodeId);
  }

  private append(record: BenchmarkRunRecord, type: BenchmarkTraceEvent["type"], data: Record<string, unknown>, nodeId?: string): void {
    const timestamp = this.now().toISOString();
    record.events.push({ seq: record.events.length + 1, at: timestamp, type, ...(nodeId ? { nodeId } : {}), data });
    record.updatedAt = timestamp;
  }

  private async save(record: BenchmarkRunRecord): Promise<void> {
    const target = this.recordFile(record.projectId, record.benchmarkRunId);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    await replaceFile(temporary, target);
  }

  private async read(projectId: string, benchmarkRunId: string): Promise<BenchmarkRunRecord> {
    try {
      const record = JSON.parse(await readFile(this.recordFile(projectId, benchmarkRunId), "utf8")) as BenchmarkRunRecord;
      if (record.projectId !== projectId || record.benchmarkRunId !== benchmarkRunId) throw new AppError(409, "benchmark_run_identity_mismatch", "Benchmark Run 身份不一致");
      record.humanReviews ??= [];
      return record;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "benchmark_run_not_found", "Benchmark Run 不存在");
      throw error;
    }
  }

  private async find(benchmarkRunId: string): Promise<BenchmarkRunRecord | null> {
    for (const project of await readdir(this.runRoot(), { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      try {
        return await this.read(project.name, benchmarkRunId);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "benchmark_run_not_found") throw error;
      }
    }
    return null;
  }

  private runRoot(): string { return path.join(this.dataRoot, "runs"); }
  private recordFile(projectId: string, benchmarkRunId: string): string {
    assertProjectId(projectId);
    assertBenchmarkRunId(benchmarkRunId);
    return path.join(this.runRoot(), projectId, `${benchmarkRunId}.json`);
  }
}

function boundedProjectFacts(facts: ReturnType<typeof executeProjectFactQueries>) {
  let remaining = MAX_NODE_CONTEXT_CHARS;
  return facts.map((fact) => {
    if (fact.value === undefined || remaining <= 0) return structuredClone(fact);
    const serialized = JSON.stringify(fact.value);
    if (serialized.length <= remaining) {
      remaining -= serialized.length;
      return structuredClone(fact);
    }
    const excerpt = serialized.slice(0, remaining);
    remaining = 0;
    return { ...structuredClone(fact), value: { truncated: true, serialized: excerpt } };
  });
}

class BenchmarkExecutionError extends Error {
  constructor(public readonly category: BenchmarkFailureCategory, message: string) {
    super(message);
    this.name = "BenchmarkExecutionError";
  }
}

function nodeContext(prepared: PreparedBenchmarkExecution, nodeId: string): { content: string; path: string | null; anchor: string | null; status: "found" | "whole-document" | "missing" | "ambiguous" | null; truncated: boolean } {
  const node = prepared.runtimeArtifact.graph.nodes.find((item) => item.id === nodeId);
  if (!node?.doc) return { content: "", path: null, anchor: null, status: null, truncated: false };
  const content = prepared.documents[node.doc];
  if (!content) return { content: "", path: node.doc, anchor: node.docAnchor ?? null, status: "missing", truncated: false };
  const sliced = sliceDocument(content, node.docAnchor ?? "");
  const selected = sliced.content ?? content;
  return {
    content: selected.length <= MAX_NODE_CONTEXT_CHARS ? selected : selected.slice(0, MAX_NODE_CONTEXT_CHARS),
    path: node.doc,
    anchor: node.docAnchor ?? null,
    status: sliced.status,
    truncated: selected.length > MAX_NODE_CONTEXT_CHARS
  };
}

function parseBenchmarkCommand(value: unknown): { tool: string; executable: string; args: string[] } | null {
  if (value === undefined) return null;
  const command = asRecord(value);
  if (!command || typeof command.tool !== "string" || typeof command.executable !== "string" || !Array.isArray(command.args) || command.args.some((item) => typeof item !== "string")) {
    throw new BenchmarkExecutionError("tool-error", "action 节点 benchmarkCommand 扩展无效");
  }
  if (command.tool.length > 120 || command.executable.length > 80 || command.args.length > 100 || command.args.some((item) => (item as string).length > 4000)) {
    throw new BenchmarkExecutionError("tool-error", "action 节点 benchmarkCommand 超过协议限制");
  }
  return { tool: command.tool, executable: command.executable, args: command.args as string[] };
}

function validateDecision(value: unknown, allowedNodeIds: string[]): BenchmarkModelDecision {
  const record = asRecord(value);
  if (!record || (record.decision !== "advance" && record.decision !== "stop") || typeof record.summary !== "string" || record.summary.length > 2000) {
    throw new BenchmarkExecutionError("model-protocol-error", "模型返回的决策结构无效");
  }
  if (record.decision === "stop") {
    if (record.nextNodeId !== null) throw new BenchmarkExecutionError("model-protocol-error", "stop 决策的 nextNodeId 必须为 null");
    return { decision: "stop", nextNodeId: null, summary: record.summary };
  }
  if (typeof record.nextNodeId !== "string" || !allowedNodeIds.includes(record.nextNodeId)) throw new BenchmarkExecutionError("model-protocol-error", "模型选择的下一节点不在合法出口中");
  return { decision: "advance", nextNodeId: record.nextNodeId, summary: record.summary };
}

function addUsage(target: ModelUsage, usage: ModelUsage): void {
  for (const key of Object.keys(target) as Array<keyof ModelUsage>) target[key] += usage[key];
}

function compactToolResults(results: BenchmarkObservedResult["toolResults"]): BenchmarkObservedResult["toolResults"] {
  return results.map((item) => {
    const record = asRecord(item.result);
    if (!record) return item;
    return {
      tool: item.tool,
      result: {
        ...record,
        ...(typeof record.stdout === "string" ? { stdout: record.stdout.slice(0, 4000) } : {}),
        ...(typeof record.stderr === "string" ? { stderr: record.stderr.slice(0, 4000) } : {})
      }
    };
  });
}

function classifyFailure(error: unknown): NonNullable<BenchmarkRunRecord["failure"]> {
  if (error instanceof BenchmarkExecutionError) return { category: error.category, message: error.message };
  if (error instanceof ModelProviderError) return { category: error.category === "protocol" ? "model-protocol-error" : "model-error", message: error.message };
  if (error instanceof AppError && error.code.includes("benchmark_case")) return { category: "case-invalid", message: error.message };
  return { category: "internal-error", message: error instanceof Error ? error.message : "Benchmark 执行失败" };
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ModelProviderError("cancelled", "Benchmark 已取消", false);
}

function hash(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function validRunnerImage(value: string): boolean { return /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/iu.test(value); }
function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function isReasoningEffort(value: unknown): value is ModelReasoningEffort { return ["none", "low", "medium", "high", "xhigh", "max"].includes(String(value)); }
function isHumanVerdict(value: unknown): value is BenchmarkHumanVerdict { return value === "passed" || value === "failed" || value === "inconclusive"; }
function activeBenchmarkStatus(status: BenchmarkRunRecord["status"]): boolean { return status === "queued" || status === "preparing" || status === "running"; }
async function replaceFile(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = process.platform === "win32" && ["EACCES", "EBUSY", "EPERM"].includes(code ?? "");
      if (!retryable || attempt >= 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}
function assertProjectId(value: string): void { if (!/^project-[0-9a-f-]{36}$/iu.test(value)) throw new AppError(400, "invalid_project_id", "Project ID 无效"); }
function assertWorkspaceId(value: string): void { if (!/^workspace-[0-9a-f-]{36}$/iu.test(value)) throw new AppError(400, "invalid_workspace_id", "Workspace ID 无效"); }
function assertCaseId(value: string): void { if (!/^case-[0-9a-f-]{36}$/iu.test(value)) throw new AppError(400, "invalid_case_id", "Case ID 无效"); }
function assertBenchmarkRunId(value: string): void { if (!/^benchmark-run-[0-9a-f-]{36}$/iu.test(value)) throw new AppError(400, "invalid_benchmark_run_id", "Benchmark Run ID 无效"); }
