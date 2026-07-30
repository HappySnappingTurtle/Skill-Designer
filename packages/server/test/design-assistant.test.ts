import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider, ModelInvocationRequest, ModelInvocationResponse, ModelProviderCapability } from "@skill-designer/engine";
import { DesignAssistantService } from "../src/design-assistant.js";
import { ModelProviderError } from "../src/model-provider.js";
import { WorkspaceStore } from "../src/store.js";

let root: string;
let store: WorkspaceStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-assistant-"));
  store = new WorkspaceStore({ dataDir: path.join(root, "data") });
  await store.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("DesignAssistantService", () => {
  it("locks a session to one Skill and produces only a user-confirmed ChangeSet", async () => {
    const workspace = await store.createWorkspace({ name: "助手 Workspace" });
    const firstWorkspace = await store.createManagedSkill(workspace.workspaceId, { name: "目标流程", capability: "workflow" });
    const first = firstWorkspace.members[0]!;
    const secondWorkspace = await store.createManagedSkill(workspace.workspaceId, { name: "其他流程", capability: "workflow" });
    const second = secondWorkspace.members.find((member) => member.projectId !== first.projectId)!;
    const provider = new ScriptedAssistantProvider({
      action: "propose",
      reply: "把核心步骤改名为需求澄清；这是待确认提案。",
      evidence: [{ source: "graph", ref: "flow.core-step", fact: "当前图包含标题为核心步骤的 step 节点" }],
      operations: [{
        op: "graph.node.update",
        target: "flow.core-step",
        valueJson: JSON.stringify({ id: "flow.core-step", kind: "step", title: "需求澄清", description: "整理并确认需求" })
      }]
    });
    const assistant = new DesignAssistantService({ dataRoot: path.join(root, "assistant"), store, provider });
    await assistant.initialize();
    const session = await assistant.createSession(first.projectId, { workspaceId: workspace.workspaceId });

    await store.selectProject(workspace.workspaceId, second.projectId);
    const turn = await assistant.message(session.sessionId, { content: "把核心步骤改名为需求澄清", reasoningEffort: "low" });

    expect(turn.session).toMatchObject({ projectId: first.projectId, skillId: first.skillId, skillName: "目标流程" });
    expect(turn.message).toMatchObject({ kind: "proposal", changeSetId: turn.changeSet?.changeSetId, model: { providerId: "scripted-assistant", usage: { totalTokens: 30 } } });
    expect(turn.changeSet).toMatchObject({
      projectId: first.projectId,
      skillId: first.skillId,
      status: "proposed",
      source: { kind: "assistant", sourceId: session.sessionId, label: "设计助手" },
      evidence: [
        { kind: "user-request", ref: session.sessionId, summary: "把核心步骤改名为需求澄清" },
        { kind: "graph", ref: "flow.core-step", summary: "当前图包含标题为核心步骤的 step 节点" }
      ],
      operations: [{ op: "graph.node.update", target: "flow.core-step" }]
    });
    expect((await store.getProjectGraph(first.projectId)).graph.nodes.find((node) => node.id === "flow.core-step")?.title).toBe("核心步骤");
    expect((await store.getProjectGraph(second.projectId)).graph.nodes.find((node) => node.id === "flow.core-step")?.title).toBe("核心步骤");
    const applied = await store.confirmAndApplyChangeSet(turn.changeSet!.changeSetId, { digest: turn.changeSet!.digest, baseRevision: turn.changeSet!.baseRevision });
    expect(applied.graph?.nodes.find((node) => node.id === "flow.core-step")?.title).toBe("需求澄清");
    expect((await store.getProjectGraph(second.projectId)).graph.nodes.find((node) => node.id === "flow.core-step")?.title).toBe("核心步骤");
    expect(provider.requests[0]?.input).toMatchObject({ target: { projectId: first.projectId, skillId: first.skillId } });
    expect((await assistant.getSession(session.sessionId)).messages).toHaveLength(2);
  });

  it("persists a clarification without creating a ChangeSet", async () => {
    const workspace = await store.createWorkspace({ name: "澄清 Workspace" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "澄清流程", capability: "workflow" });
    const member = created.members[0]!;
    const provider = new ScriptedAssistantProvider({ action: "clarify", reply: "请说明要修改哪个节点。", evidence: [], operations: [] });
    const assistant = new DesignAssistantService({ dataRoot: path.join(root, "assistant-clarify"), store, provider });
    await assistant.initialize();
    const session = await assistant.createSession(member.projectId, { workspaceId: workspace.workspaceId });
    const turn = await assistant.message(session.sessionId, { content: "优化一下流程" });
    expect(turn.changeSet).toBeUndefined();
    expect(turn.message).toMatchObject({ kind: "clarification", content: "请说明要修改哪个节点。" });
  });

  it("rejects model evidence that is not present in the bounded project context", async () => {
    const workspace = await store.createWorkspace({ name: "证据 Workspace" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "证据流程", capability: "workflow" });
    const member = created.members[0]!;
    const provider = new ScriptedAssistantProvider({
      action: "propose",
      reply: "修改不存在的节点。",
      evidence: [{ source: "graph", ref: "flow.invented", fact: "模型臆造的节点" }],
      operations: [{ op: "graph.node.delete", target: "flow.invented", valueJson: null }]
    });
    const assistant = new DesignAssistantService({ dataRoot: path.join(root, "assistant-evidence"), store, provider });
    await assistant.initialize();
    const session = await assistant.createSession(member.projectId, { workspaceId: workspace.workspaceId });
    await expect(assistant.message(session.sessionId, { content: "删除 flow.invented" })).rejects.toMatchObject({ code: "assistant_evidence_invalid" });
    expect((await assistant.getSession(session.sessionId)).messages).toEqual([]);
  });

  it("reports provider unavailability before invoking or persisting a request", async () => {
    const workspace = await store.createWorkspace({ name: "离线 Workspace" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "离线流程", capability: "workflow" });
    const member = created.members[0]!;
    const provider: LLMProvider = {
      probe: vi.fn(async () => ({ schemaVersion: "1.0", providerId: "offline", label: "离线 Provider", status: "unavailable", keyConfigured: false, defaultModel: "none", reason: "未配置密钥", checkedAt: "2026-07-28T08:00:00.000Z" })),
      invoke: vi.fn()
    };
    const assistant = new DesignAssistantService({ dataRoot: path.join(root, "assistant-offline"), store, provider });
    await assistant.initialize();
    const session = await assistant.createSession(member.projectId, { workspaceId: workspace.workspaceId });
    await expect(assistant.message(session.sessionId, { content: "修改核心步骤" })).rejects.toMatchObject({ code: "assistant_provider_unavailable" });
    expect(provider.invoke).not.toHaveBeenCalled();
    expect((await assistant.getSession(session.sessionId)).messages).toEqual([]);
  });

  it("lists only the requested Workspace sessions and restores them after service restart", async () => {
    const firstWorkspace = await store.createWorkspace({ name: "会话恢复 Workspace" });
    const firstCreated = await store.createManagedSkill(firstWorkspace.workspaceId, { name: "恢复流程", capability: "workflow" });
    const firstMember = firstCreated.members[0]!;
    const secondCreated = await store.createManagedSkill(firstWorkspace.workspaceId, { name: "第二流程", capability: "workflow" });
    const secondMember = secondCreated.members.find((member) => member.projectId !== firstMember.projectId)!;
    const otherWorkspace = await store.createWorkspace({ name: "隔离 Workspace" });
    const otherCreated = await store.createManagedSkill(otherWorkspace.workspaceId, { name: "隔离流程", capability: "workflow" });
    const otherMember = otherCreated.members[0]!;
    const dataRoot = path.join(root, "assistant-restore");
    const provider = new ScriptedAssistantProvider({ action: "clarify", reply: "请明确目标。", evidence: [], operations: [] });
    const assistant = new DesignAssistantService({ dataRoot, store, provider });
    await assistant.initialize();
    const firstSession = await assistant.createSession(firstMember.projectId, { workspaceId: firstWorkspace.workspaceId });
    await assistant.message(firstSession.sessionId, { content: "优化流程" });
    const secondSession = await assistant.createSession(secondMember.projectId, { workspaceId: firstWorkspace.workspaceId });
    await assistant.createSession(otherMember.projectId, { workspaceId: otherWorkspace.workspaceId });

    const restarted = new DesignAssistantService({ dataRoot, store, provider });
    await restarted.initialize();
    const workspaceSessions = await restarted.listSessions(firstWorkspace.workspaceId);
    expect(workspaceSessions.map((item) => item.sessionId)).toEqual([secondSession.sessionId, firstSession.sessionId]);
    expect(workspaceSessions.find((item) => item.sessionId === firstSession.sessionId)).toMatchObject({
      skillName: "恢复流程",
      messageCount: 2,
      lastMessagePreview: "请明确目标。",
      busy: false
    });
    expect(await restarted.listSessions(firstWorkspace.workspaceId, firstMember.projectId)).toMatchObject([{ sessionId: firstSession.sessionId }]);
  });

  it("cancels one in-flight turn, persists a cancellation, and creates no proposal", async () => {
    const workspace = await store.createWorkspace({ name: "取消 Workspace" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "取消流程", capability: "workflow" });
    const member = created.members[0]!;
    const provider = new AbortableAssistantProvider();
    const assistant = new DesignAssistantService({ dataRoot: path.join(root, "assistant-cancel"), store, provider });
    await assistant.initialize();
    const session = await assistant.createSession(member.projectId, { workspaceId: workspace.workspaceId });
    const turnPromise = assistant.message(session.sessionId, { content: "把核心步骤改成一个尚未完成的提案" });
    await provider.started;
    await expect(assistant.message(session.sessionId, { content: "并发消息" })).rejects.toMatchObject({ code: "assistant_session_busy" });
    expect(await assistant.listSessions(workspace.workspaceId)).toMatchObject([{ sessionId: session.sessionId, busy: true }]);
    expect(await assistant.cancel(session.sessionId)).toMatchObject({ sessionId: session.sessionId, cancelled: true });

    const turn = await turnPromise;
    expect(turn.changeSet).toBeUndefined();
    expect(turn.message).toMatchObject({ kind: "cancelled", content: "已取消本次生成，未创建或应用 ChangeSet。" });
    expect((await assistant.getSession(session.sessionId)).messages.map((message) => message.kind)).toEqual(["request", "cancelled"]);
    expect((await assistant.listSessions(workspace.workspaceId))[0]).toMatchObject({ busy: false, messageCount: 2 });
    expect((await store.getProjectGraph(member.projectId)).graph.nodes.find((node) => node.id === "flow.core-step")?.title).toBe("核心步骤");
    expect(await assistant.cancel(session.sessionId)).toMatchObject({ cancelled: false });
  });

  it("performs bounded project reads before producing one reviewable ChangeSet", async () => {
    const workspace = await store.createWorkspace({ name: "按需读取 Workspace" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "按需读取流程", capability: "workflow" });
    const member = created.members[0]!;
    const graph = await store.getProjectGraph(member.projectId);
    const documentChange = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: graph.activeRevision,
      reason: "准备按需读取文档",
      operations: [{ op: "docs.write", target: "docs/guide.md", value: "# 指南\n\n旧说明\n" }]
    });
    await store.confirmAndApplyChangeSet(documentChange.changeSetId, { digest: documentChange.digest, baseRevision: documentChange.baseRevision });
    const provider = new SequenceAssistantProvider([
      {
        action: "read",
        reply: "读取指南后再生成提案。",
        evidence: [],
        operations: [],
        reads: [{ tool: "docs.read", ref: "docs/guide.md", query: null }]
      },
      {
        action: "propose",
        reply: "补充指南说明。",
        evidence: [{ source: "document", ref: "docs/guide.md", fact: "指南当前包含旧说明" }],
        operations: [{ op: "docs.write", target: "docs/guide.md", valueJson: JSON.stringify("# 指南\n\n新说明\n") }],
        reads: []
      }
    ]);
    const assistant = new DesignAssistantService({ dataRoot: path.join(root, "assistant-tools"), store, provider });
    await assistant.initialize();
    const session = await assistant.createSession(member.projectId, { workspaceId: workspace.workspaceId });
    const turn = await assistant.message(session.sessionId, { content: "根据指南现有内容更新说明" });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.input).toMatchObject({ context: { documents: [], documentIndex: [expect.objectContaining({ path: "SKILL.md" }), expect.objectContaining({ path: "docs/guide.md" })] } });
    expect(provider.requests[1]?.input).toMatchObject({
      toolResults: [{ tool: "docs.read", ref: "docs/guide.md", status: "completed", result: { content: "# 指南\n\n旧说明\n" } }]
    });
    expect(turn.message).toMatchObject({
      kind: "proposal",
      toolReads: [{ round: 1, tool: "docs.read", ref: "docs/guide.md", status: "completed" }],
      model: { usage: { totalTokens: 60 }, callCount: 2 }
    });
    expect((await store.readDocument(member.projectId, "docs/guide.md")).content).toContain("旧说明");
    expect(turn.changeSet).toMatchObject({
      status: "proposed",
      source: { kind: "assistant", sourceId: session.sessionId },
      evidence: [
        { kind: "user-request", summary: "根据指南现有内容更新说明" },
        { kind: "document", ref: "docs/guide.md", summary: "指南当前包含旧说明" }
      ],
      operations: [{ op: "docs.write", target: "docs/guide.md" }]
    });
  });

  it("rejects out-of-index reads without escaping the locked project", async () => {
    const workspace = await store.createWorkspace({ name: "读取隔离 Workspace" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "读取隔离流程", capability: "workflow" });
    const member = created.members[0]!;
    const provider = new SequenceAssistantProvider([
      { action: "read", reply: "尝试读取。", evidence: [], operations: [], reads: [{ tool: "docs.read", ref: "../outside.md", query: null }] },
      { action: "clarify", reply: "目标文档不在当前项目索引中。", evidence: [], operations: [], reads: [] }
    ]);
    const assistant = new DesignAssistantService({ dataRoot: path.join(root, "assistant-tool-isolation"), store, provider });
    await assistant.initialize();
    const session = await assistant.createSession(member.projectId, { workspaceId: workspace.workspaceId });
    const turn = await assistant.message(session.sessionId, { content: "读取项目外文档" });

    expect(provider.requests[1]?.input).toMatchObject({ toolResults: [{ ref: "../outside.md", status: "rejected", result: { message: "文档不在当前项目索引中" } }] });
    expect(turn.message).toMatchObject({ kind: "clarification", toolReads: [{ status: "rejected", resultChars: 0 }] });
    expect(turn.changeSet).toBeUndefined();
  });

  it("stops a model that keeps requesting reads beyond the call limit", async () => {
    const workspace = await store.createWorkspace({ name: "读取上限 Workspace" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "读取上限流程", capability: "workflow" });
    const member = created.members[0]!;
    const repeat = { action: "read", reply: "继续读取。", evidence: [], operations: [], reads: [{ tool: "graph.node", ref: "flow.core-step", query: null }] };
    const provider = new SequenceAssistantProvider([repeat, repeat, repeat]);
    const assistant = new DesignAssistantService({ dataRoot: path.join(root, "assistant-tool-limit"), store, provider });
    await assistant.initialize();
    const session = await assistant.createSession(member.projectId, { workspaceId: workspace.workspaceId });
    await expect(assistant.message(session.sessionId, { content: "持续读取" })).rejects.toMatchObject({ code: "assistant_tool_round_limit" });
    expect(provider.requests).toHaveLength(3);
    expect((await assistant.getSession(session.sessionId)).messages).toEqual([]);
  });
});

class ScriptedAssistantProvider implements LLMProvider {
  requests: ModelInvocationRequest[] = [];
  constructor(private readonly output: unknown) {}
  async probe(): Promise<ModelProviderCapability> {
    return { schemaVersion: "1.0", providerId: "scripted-assistant", label: "Scripted Assistant", status: "ready", keyConfigured: true, defaultModel: "assistant-model", reason: "ready", checkedAt: "2026-07-28T08:00:00.000Z" };
  }
  async invoke<T>(request: ModelInvocationRequest): Promise<ModelInvocationResponse<T>> {
    this.requests.push(request);
    return {
      providerId: "scripted-assistant",
      responseId: "assistant-response-1",
      model: "assistant-model-2026-07-01",
      output: this.output as T,
      usage: { inputTokens: 24, outputTokens: 6, totalTokens: 30, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 40
    };
  }
}

class AbortableAssistantProvider implements LLMProvider {
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => { this.markStarted = resolve; });
  }

  async probe(): Promise<ModelProviderCapability> {
    return { schemaVersion: "1.0", providerId: "abortable-assistant", label: "Abortable Assistant", status: "ready", keyConfigured: true, defaultModel: "assistant-model", reason: "ready", checkedAt: "2026-07-28T08:00:00.000Z" };
  }

  async invoke<T>(_request: ModelInvocationRequest, signal: AbortSignal): Promise<ModelInvocationResponse<T>> {
    this.markStarted();
    return await new Promise<ModelInvocationResponse<T>>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new ModelProviderError("cancelled", "模型调用已取消", false)), { once: true });
    });
  }
}

class SequenceAssistantProvider implements LLMProvider {
  requests: ModelInvocationRequest[] = [];
  private index = 0;
  constructor(private readonly outputs: unknown[]) {}
  async probe(): Promise<ModelProviderCapability> {
    return { schemaVersion: "1.0", providerId: "sequence-assistant", label: "Sequence Assistant", status: "ready", keyConfigured: true, defaultModel: "assistant-model", reason: "ready", checkedAt: "2026-07-28T08:00:00.000Z" };
  }
  async invoke<T>(request: ModelInvocationRequest): Promise<ModelInvocationResponse<T>> {
    this.requests.push(structuredClone(request));
    const output = this.outputs[this.index++];
    return {
      providerId: "sequence-assistant",
      responseId: `assistant-response-${this.index}`,
      model: "assistant-model-2026-07-01",
      output: output as T,
      usage: { inputTokens: 24, outputTokens: 6, totalTokens: 30, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 40
    };
  }
}
