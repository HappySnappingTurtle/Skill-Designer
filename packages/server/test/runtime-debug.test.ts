import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMProvider, ModelInvocationRequest, ModelInvocationResponse, ModelProviderCapability } from "@skill-designer/engine";
import { ModelProviderError } from "../src/model-provider.js";
import { RuntimeDebugService } from "../src/runtime-debug.js";
import { WorkspaceStore } from "../src/store.js";

let root: string;
let store: WorkspaceStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-runtime-dialog-"));
  store = new WorkspaceStore({ dataDir: path.join(root, "data") });
  await store.initialize();
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("RuntimeDebugService", () => {
  it("executes declared project fact queries against the frozen revision and records only structural trace summaries", async () => {
    const workspace = await store.createWorkspace({ name: "声明查询 Workspace" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "声明查询 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const project = await store.getProjectGraph(member.projectId);
    const start = project.graph.nodes.find((node) => node.id === "flow.start")!;
    const documentProposal = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: project.activeRevision,
      reason: "创建查询文档",
      operations: [{ op: "docs.write", target: "docs/platform.md", value: "# Guide\n\n## Windows\n\n### Retry\n\nWindows secret.\n\n## macOS\n\n### Retry\n\nmacOS exact.\n\n## Support\n\nSupport fallback.\n" }]
    });
    const documentApplied = await store.confirmAndApplyChangeSet(documentProposal.changeSetId, { digest: documentProposal.digest, baseRevision: documentProposal.baseRevision });
    const graphProposal = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: documentApplied.activeRevision,
      reason: "声明运行查询",
      operations: [{ op: "graph.node.update", target: start.id, value: {
        ...start,
        lookup: [
          { queryId: "fact.node", kind: "graph.node", nodeId: "flow.core-step" },
          { queryId: "doc.exact", kind: "document.slice", path: "docs/platform.md", anchor: "Guide/macOS/Retry" },
          { queryId: "doc.fallback", kind: "document.slice", path: "docs/platform.md", anchor: "Support", fallback: "title" },
          { queryId: "doc.ambiguous", kind: "document.slice", path: "docs/platform.md", anchor: "Retry", fallback: "title" },
          { queryId: "doc.missing", kind: "document.slice", path: "docs/missing.md", anchor: "Guide" }
        ]
      } }]
    });
    await store.confirmAndApplyChangeSet(graphProposal.changeSetId, { digest: graphProposal.digest, baseRevision: graphProposal.baseRevision });
    const run = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId });
    expect(run.contextFacts?.map((fact) => fact.status)).toEqual(["found", "found", "degraded", "ambiguous", "missing"]);

    const provider = new SequenceProvider([decision("reply", null, "已读取声明上下文")]);
    const service = await runtimeDebug(provider);
    const result = await service.message(member.projectId, run.run.runId, { workspaceId: workspace.workspaceId, content: "读取项目事实" });
    expect(provider.requests[0]?.input).toMatchObject({
      projectFacts: [
        { queryId: "fact.node", status: "found" },
        { queryId: "doc.exact", status: "found", value: { content: expect.stringContaining("macOS exact") } },
        { queryId: "doc.fallback", status: "degraded", degradation: { resolvedPath: "Guide/Support" } },
        { queryId: "doc.ambiguous", status: "ambiguous" },
        { queryId: "doc.missing", status: "missing" }
      ]
    });
    const queried = result.view.run.events.find((event) => event.type === "context.queried");
    expect(queried?.data).toMatchObject({ queries: [
      { queryId: "fact.node", status: "found", valueCharacters: expect.any(Number) },
      { queryId: "doc.exact", status: "found", valueCharacters: expect.any(Number) },
      { queryId: "doc.fallback", status: "degraded", degradation: { strategy: "title" } },
      { queryId: "doc.ambiguous", status: "ambiguous" },
      { queryId: "doc.missing", status: "missing" }
    ] });
    expect(JSON.stringify(queried?.data)).not.toContain("macOS exact");
    expect(JSON.stringify(queried?.data)).not.toContain("Windows secret");
  });

  it("assembles the current node document from the frozen run revision", async () => {
    const workspace = await store.createWorkspace({ name: "冻结文档 Workspace" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "冻结文档 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const project = await store.getProjectGraph(member.projectId);
    const start = project.graph.nodes.find((node) => node.id === "flow.start")!;
    const documentProposal = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: project.activeRevision,
      reason: "创建运行节点文档",
      operations: [{ op: "docs.write", target: "docs/start.md", value: "# 开始说明\n\n只使用冻结版本中的运行上下文。\n" }]
    });
    const documentApplied = await store.confirmAndApplyChangeSet(documentProposal.changeSetId, { digest: documentProposal.digest, baseRevision: documentProposal.baseRevision });
    const graphProposal = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: documentApplied.activeRevision,
      reason: "绑定运行节点文档",
      operations: [{ op: "graph.node.update", target: start.id, value: { ...start, doc: "docs/start.md", docAnchor: "#开始说明" } }]
    });
    await store.confirmAndApplyChangeSet(graphProposal.changeSetId, { digest: graphProposal.digest, baseRevision: graphProposal.baseRevision });
    const run = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId });
    const provider = new SequenceProvider([decision("reply", null, "已读取说明")]);
    const service = await runtimeDebug(provider);
    await service.message(member.projectId, run.run.runId, { workspaceId: workspace.workspaceId, content: "读取当前说明" });

    expect(provider.requests[0]?.input).toMatchObject({
      currentNode: { id: "flow.start", doc: "docs/start.md", docAnchor: "#开始说明" },
      document: { path: "docs/start.md", anchor: "#开始说明", status: "found", content: expect.stringContaining("只使用冻结版本中的运行上下文") }
    });
    expect((await store.getRun(member.projectId, run.run.runId)).run.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "document.context", data: { path: "docs/start.md", anchor: "#开始说明", status: "found", contentCharacters: expect.any(Number), truncated: false } })
    ]));
  });

  it("records condition evaluations used to build the model legal exits", async () => {
    const workspace = await store.createWorkspace({ name: "条件事实 Workspace" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "条件事实 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const project = await store.getProjectGraph(member.projectId);
    const edge = project.graph.edges.find((item) => item.id === "edge.start-core")!;
    const proposal = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: project.activeRevision,
      reason: "设置可观测条件",
      operations: [{ op: "graph.edge.update", target: edge.id, value: { ...edge, kind: "condition", condition: { op: "boolean", value: false } } }]
    });
    await store.confirmAndApplyChangeSet(proposal.changeSetId, { digest: proposal.digest, baseRevision: proposal.baseRevision });
    const run = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId });
    const service = await runtimeDebug(new SequenceProvider([decision("reply", null, "保持当前节点")]));
    const result = await service.message(member.projectId, run.run.runId, { workspaceId: workspace.workspaceId, content: "检查出口" });
    expect(result.view.run.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "condition.evaluated", data: { evaluations: [{ edgeId: edge.id, to: "flow.core-step", conditionOp: "boolean", result: false }], allowedNodeIds: [] } })
    ]));
  });

  it("uses the frozen run context and advances only through the runtime engine", async () => {
    const fixture = await createRun();
    const provider = new SequenceProvider([decision("advance", "flow.core-step", "进入核心步骤")]);
    const service = await runtimeDebug(provider);
    const result = await service.message(fixture.projectId, fixture.runId, { workspaceId: fixture.workspaceId, content: "开始处理", reasoningEffort: "low" });

    expect(result.message).toMatchObject({ kind: "advanced", decision: { action: "advance", nextNodeId: "flow.core-step", accepted: true }, model: { usage: { totalTokens: 30 } } });
    expect(result.view.run.state).toMatchObject({ currentNodeId: "flow.core-step", step: 1, eventSeq: 7 });
    expect(result.view.run.events.map((event) => event.type)).toEqual([
      "engine.start", "engine.enter", "conversation.user", "llm.request", "llm.response", "engine.enter", "conversation.assistant"
    ]);
    expect(provider.requests[0]?.input).toMatchObject({
      target: { projectId: fixture.projectId, runId: fixture.runId, artifactId: result.view.run.artifactId },
      currentNode: { id: "flow.start" },
      allowedTransitions: [{ to: "flow.core-step" }],
      userMessage: "开始处理"
    });
    expect((await service.history(fixture.projectId, fixture.runId, fixture.workspaceId)).messages).toHaveLength(2);
  });

  it("keeps the current node and explains an illegal model transition without retrying", async () => {
    const fixture = await createRun();
    const provider = new SequenceProvider([decision("advance", "flow.invented", "尝试进入未声明节点")]);
    const service = await runtimeDebug(provider);
    const result = await service.message(fixture.projectId, fixture.runId, { workspaceId: fixture.workspaceId, content: "继续" });

    expect(provider.requests).toHaveLength(1);
    expect(result.message).toMatchObject({ kind: "rejected", decision: { accepted: false, nextNodeId: "flow.invented" } });
    expect(result.message.content).toContain("引擎拒绝了下一节点 flow.invented");
    expect(result.message.content).toContain("flow.core-step");
    expect(result.view.run.state).toMatchObject({ currentNodeId: "flow.start", step: 0 });
    expect(result.view.run.events.map((event) => event.type)).toContain("engine.reject");
  });

  it("cancels an in-flight model call without changing the runtime node", async () => {
    const fixture = await createRun();
    const provider = new AbortableProvider();
    const service = await runtimeDebug(provider);
    const pending = service.message(fixture.projectId, fixture.runId, { workspaceId: fixture.workspaceId, content: "等待模型" });
    await provider.started;
    expect(await service.cancel(fixture.projectId, fixture.runId, fixture.workspaceId)).toMatchObject({ cancelled: true });
    const result = await pending;

    expect(result.message).toMatchObject({ kind: "cancelled", content: "模型调用已取消" });
    expect(result.view.run.state).toMatchObject({ currentNodeId: "flow.start", step: 0, status: "running" });
    expect(result.view.run.events.map((event) => event.type)).toEqual(expect.arrayContaining(["llm.error", "conversation.assistant"]));
  });

  it("does not apply a stale model decision after a concurrent manual transition", async () => {
    const fixture = await createRun();
    const provider = new ControlledProvider(decision("advance", "flow.core-step", "进入核心步骤"));
    const service = await runtimeDebug(provider);
    const pending = service.message(fixture.projectId, fixture.runId, { workspaceId: fixture.workspaceId, content: "继续" });
    await provider.started;
    await store.commandRun(fixture.projectId, fixture.runId, "next", { nextNodeId: "flow.core-step" });
    provider.release();
    const result = await pending;

    expect(result.message).toMatchObject({ kind: "error", content: "生成期间运行状态已变化，本次模型决策未应用" });
    expect(result.view.run.state).toMatchObject({ currentNodeId: "flow.core-step", step: 1 });
    expect(result.view.run.events.filter((event) => event.type === "engine.enter")).toHaveLength(2);
  });
});

async function createRun() {
  const workspace = await store.createWorkspace({ name: "模型调试 Workspace" });
  const created = await store.createManagedSkill(workspace.workspaceId, { name: "模型调试 Skill", capability: "workflow" });
  const member = created.members[0]!;
  const run = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: { requestId: "demo" } });
  return { workspaceId: workspace.workspaceId, projectId: member.projectId, runId: run.run.runId };
}

async function runtimeDebug(provider: LLMProvider) {
  const service = new RuntimeDebugService({ dataRoot: path.join(root, "runtime-dialog"), store, provider });
  await service.initialize();
  return service;
}

function decision(action: "reply" | "advance" | "stop", nextNodeId: string | null, reply: string) {
  return { action, reply, nextNodeId, summary: reply };
}

class SequenceProvider implements LLMProvider {
  requests: ModelInvocationRequest[] = [];
  private index = 0;
  constructor(private readonly outputs: unknown[]) {}
  async probe(): Promise<ModelProviderCapability> {
    return { schemaVersion: "1.0", providerId: "runtime-sequence", label: "Runtime Sequence", status: "ready", keyConfigured: true, defaultModel: "runtime-model", reason: "ready", checkedAt: "2026-07-29T10:00:00.000Z" };
  }
  async invoke<T>(request: ModelInvocationRequest): Promise<ModelInvocationResponse<T>> {
    this.requests.push(structuredClone(request));
    return {
      providerId: "runtime-sequence", responseId: `runtime-${this.index + 1}`, model: "runtime-model-resolved",
      output: this.outputs[this.index++] as T,
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 45
    };
  }
}

class AbortableProvider implements LLMProvider {
  readonly started: Promise<void>;
  private markStarted!: () => void;
  constructor() { this.started = new Promise((resolve) => { this.markStarted = resolve; }); }
  async probe(): Promise<ModelProviderCapability> { return readyCapability("runtime-abort"); }
  async invoke<T>(_request: ModelInvocationRequest, signal: AbortSignal): Promise<ModelInvocationResponse<T>> {
    this.markStarted();
    return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new ModelProviderError("cancelled", "已取消", false)), { once: true }));
  }
}

class ControlledProvider implements LLMProvider {
  readonly started: Promise<void>;
  private markStarted!: () => void;
  private continue!: () => void;
  private readonly gate: Promise<void>;
  constructor(private readonly output: unknown) {
    this.started = new Promise((resolve) => { this.markStarted = resolve; });
    this.gate = new Promise((resolve) => { this.continue = resolve; });
  }
  release(): void { this.continue(); }
  async probe(): Promise<ModelProviderCapability> { return readyCapability("runtime-controlled"); }
  async invoke<T>(): Promise<ModelInvocationResponse<T>> {
    this.markStarted();
    await this.gate;
    return { providerId: "runtime-controlled", responseId: "controlled", model: "runtime-model-resolved", output: this.output as T, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 }, durationMs: 45 };
  }
}

function readyCapability(providerId: string): ModelProviderCapability {
  return { schemaVersion: "1.0", providerId, label: providerId, status: "ready", keyConfigured: true, defaultModel: "runtime-model", reason: "ready", checkedAt: "2026-07-29T10:00:00.000Z" };
}
