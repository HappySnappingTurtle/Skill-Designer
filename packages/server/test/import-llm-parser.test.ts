import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMProvider, ModelInvocationRequest, ModelInvocationResponse, ModelProviderCapability } from "@skill-designer/engine";
import { ImportLLMParserService } from "../src/import-llm-parser.js";
import { ModelProviderError } from "../src/model-provider.js";
import { WorkspaceStore } from "../src/store.js";

let root: string;
let store: WorkspaceStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-import-llm-"));
  store = new WorkspaceStore({ dataDir: path.join(root, "data") });
  await store.initialize();
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("ImportLLMParserService", () => {
  it("reads frozen files on demand and applies a server-linted llm-v1 review", async () => {
    const { workspaceId, candidate } = await createImport();
    const provider = new SequenceProvider([
      readOutput("docs/flow.md"),
      workflowOutput()
    ]);
    const service = await parser(provider);
    const result = await service.start(candidate.importId, { workspaceId, reviewRevision: 1, reasoningEffort: "low" });

    expect(result.run).toMatchObject({ status: "completed", callCount: 2, correctionCount: 0, usage: { totalTokens: 60 }, resultReviewRevision: 2, createdConflict: false });
    expect(result.run.reads).toEqual(expect.arrayContaining([
      expect.objectContaining({ round: 0, path: "SKILL.md", status: "completed" }),
      expect.objectContaining({ round: 1, path: "docs/flow.md", status: "completed" })
    ]));
    expect(result.candidate?.parseReview).toMatchObject({ parserVersion: "llm-v1", reviewRevision: 2, capability: "workflow", entry: "flow.start", manuallyEdited: false });
    expect(result.candidate?.parseReview.nodes.map((node) => node.value.id)).toEqual(["flow.start", "flow.collect", "flow.end"]);
    expect(provider.requests[0]?.input).toMatchObject({ files: [{ path: "SKILL.md" }] });
    expect((provider.requests[1]?.input as { files: Array<{ path: string; content: string }> }).files.find((file) => file.path === "docs/flow.md"))
      .toMatchObject({ path: "docs/flow.md", content: "# Flow\n\n1. Collect\n2. Review\n" });
    expect(await service.latest(candidate.importId, workspaceId)).toMatchObject({ runId: result.run.runId, status: "completed" });
  });

  it("preserves manual review and creates an explicit llm-v1 conflict", async () => {
    const { workspaceId, candidate } = await createImport();
    const initialParser = await parser(new SequenceProvider([readOutput("docs/flow.md"), workflowOutput()]));
    const initial = await initialParser.start(candidate.importId, { workspaceId, reviewRevision: 1 });
    const parsedCandidate = initial.candidate!;
    const manuallyEdited = await store.updateSkillImportReview(candidate.importId, {
      workspaceId,
      reviewRevision: parsedCandidate.parseReview.reviewRevision,
      entry: parsedCandidate.parseReview.entry,
      nodes: parsedCandidate.parseReview.nodes.map((node) => ({ candidateId: node.candidateId, decision: node.decision, value: node.value.id === "flow.start" ? { ...node.value, title: "人工标题" } : node.value })),
      edges: parsedCandidate.parseReview.edges.map((edge) => ({ candidateId: edge.candidateId, decision: edge.decision, value: edge.value }))
    });
    const service = await parser(new SequenceProvider([workflowOutput()]));
    const result = await service.start(candidate.importId, { workspaceId, reviewRevision: manuallyEdited.parseReview.reviewRevision });

    expect(result.run).toMatchObject({ status: "completed", createdConflict: true });
    expect(result.candidate?.parseReview).toMatchObject({ parserVersion: "llm-v1", manuallyEdited: true, reparseConflict: { kind: "manual-vs-reparse", parserVersion: "llm-v1" } });
    expect(result.candidate?.parseReview.nodes[0]?.value.title).toBe("人工标题");
    expect(result.candidate?.parseReview.reparseConflict?.parsed.nodes[0]?.value.title).toBe("开始");
  });

  it("persists unverifiable evidence as a failed run without changing the candidate", async () => {
    const { workspaceId, candidate } = await createImport();
    const invalid = contentOutput();
    invalid.nodes[0].evidence[0].snippet = "原文件中不存在的内容";
    const service = await parser(new SequenceProvider([invalid]));
    const result = await service.start(candidate.importId, { workspaceId, reviewRevision: 1 });

    expect(result.run).toMatchObject({ status: "failed", diagnostics: [{ code: "llm_parse_evidence_mismatch" }] });
    expect((await store.getSkillImport(candidate.importId)).parseReview).toMatchObject({ reviewRevision: 1, parserVersion: "static-v2" });
  });

  it("feeds lint errors back once and applies only the corrected graph", async () => {
    const { workspaceId, candidate } = await createImport();
    const invalid = contentOutput();
    invalid.capability = "workflow";
    invalid.entry = "flow.missing";
    const provider = new SequenceProvider([invalid, contentOutput()]);
    const service = await parser(provider);
    const result = await service.start(candidate.importId, { workspaceId, reviewRevision: 1 });

    expect(result.run).toMatchObject({ status: "completed", callCount: 2, correctionCount: 1 });
    expect(provider.requests[1]?.input).toMatchObject({ lintFeedback: expect.arrayContaining([expect.objectContaining({ severity: "error" })]), previousResult: { entry: "flow.missing" } });
    expect(result.candidate?.parseReview).toMatchObject({ capability: "content-only", parserVersion: "llm-v1" });
  });

  it("reports rejected reads to the next model call", async () => {
    const { workspaceId, candidate } = await createImport();
    const provider = new SequenceProvider([readOutput("../outside.md"), contentOutput()]);
    const service = await parser(provider);
    const result = await service.start(candidate.importId, { workspaceId, reviewRevision: 1 });

    expect(result.run).toMatchObject({ status: "completed", callCount: 2 });
    expect(provider.requests[1]?.input).toMatchObject({
      readFeedback: [expect.objectContaining({ path: "../outside.md", status: "rejected" })]
    });
  });

  it("reuses a file-hash summary across runs and promotes it to full source on demand", async () => {
    const longSkill = `# LLM Import\n\n${Array.from({ length: 420 }, (_, index) => `Paragraph ${index + 1} contains frozen import context that should not be resent on every parse.`).join("\n\n")}\n`;
    const { workspaceId, candidate } = await createImport(longSkill);
    const firstProvider = new SequenceProvider([contentOutput()]);
    const firstService = await parser(firstProvider);
    const first = await firstService.start(candidate.importId, { workspaceId, reviewRevision: 1 });

    expect(first.run.reads[0]).toMatchObject({ path: "SKILL.md", contextMode: "full", cacheStatus: "miss" });
    const firstFiles = (firstProvider.requests[0]?.input as { files: Array<{ path: string; mode: string; content: string }> }).files;
    expect(firstFiles.find((file) => file.path === "SKILL.md")).toMatchObject({ mode: "full", content: expect.stringContaining("Paragraph 200") });

    const hiddenEvidence = contentOutput();
    hiddenEvidence.nodes[0]!.evidence = evidence("SKILL.md", 401, "Paragraph 200");
    const summaryOnlyProvider = new SequenceProvider([hiddenEvidence]);
    const summaryOnlyService = await parser(summaryOnlyProvider);
    const summaryOnly = await summaryOnlyService.start(candidate.importId, { workspaceId, reviewRevision: first.candidate!.parseReview.reviewRevision });

    expect(summaryOnly.run).toMatchObject({ status: "failed", diagnostics: [{ code: "llm_parse_evidence_not_in_context" }] });
    const summaryOnlyFiles = (summaryOnlyProvider.requests[0]?.input as { files: Array<{ path: string; mode: string; content: string }> }).files;
    expect(summaryOnlyFiles.find((file) => file.path === "SKILL.md")).toMatchObject({ mode: "summary", content: expect.stringContaining("L1: # LLM Import") });

    const secondProvider = new SequenceProvider([readOutput("SKILL.md"), contentOutput()]);
    const secondService = await parser(secondProvider);
    const second = await secondService.start(candidate.importId, { workspaceId, reviewRevision: first.candidate!.parseReview.reviewRevision });

    expect(second.run).toMatchObject({ status: "completed", callCount: 2 });
    expect(second.run.reads).toEqual(expect.arrayContaining([
      expect.objectContaining({ round: 0, path: "SKILL.md", contextMode: "summary", cacheStatus: "hit" }),
      expect.objectContaining({ round: 1, path: "SKILL.md", contextMode: "full", cacheStatus: "promoted" })
    ]));
    const summarizedFiles = (secondProvider.requests[0]?.input as { files: Array<{ path: string; mode: string; content: string }> }).files;
    const promotedFiles = (secondProvider.requests[1]?.input as { files: Array<{ path: string; mode: string; content: string }> }).files;
    expect(summarizedFiles.find((file) => file.path === "SKILL.md")).toMatchObject({ mode: "summary", content: expect.stringContaining("L1: # LLM Import") });
    expect(promotedFiles.find((file) => file.path === "SKILL.md")).toMatchObject({ mode: "full", content: expect.stringContaining("Paragraph 200") });
  });

  it("cancels an in-flight model call and leaves the candidate unchanged", async () => {
    const { workspaceId, candidate } = await createImport();
    const provider = new AbortableProvider();
    const service = await parser(provider);
    const pending = service.start(candidate.importId, { workspaceId, reviewRevision: 1 });
    await provider.started;
    await service.cancel(candidate.importId, workspaceId);
    const result = await pending;
    expect(result.run).toMatchObject({ status: "cancelled", diagnostics: [{ code: "llm_parse_cancelled" }] });
    expect((await store.getSkillImport(candidate.importId)).parseReview.reviewRevision).toBe(1);
  });
});

async function createImport(skillContent = "# LLM Import\n\nSee the flow guide.\n") {
  const workspace = await store.createWorkspace({ name: "LLM 导入 Workspace" });
  const preview = await store.createSkillImport(workspace.workspaceId, {
    folderName: "llm-import",
    files: [
      { path: "SKILL.md", contentBase64: Buffer.from(skillContent).toString("base64") },
      { path: "docs/flow.md", contentBase64: Buffer.from("# Flow\n\n1. Collect\n2. Review\n").toString("base64") }
    ]
  });
  return { workspaceId: workspace.workspaceId, candidate: preview.candidate };
}

async function parser(provider: LLMProvider) {
  const service = new ImportLLMParserService({ dataRoot: path.join(root, "parser"), store, provider });
  await service.initialize();
  return service;
}

function readOutput(filePath: string) {
  return { action: "read", reply: "读取流程文档", reads: [{ path: filePath }], capability: "content-only", entry: null, nodes: [], edges: [], questions: [] };
}

function evidence(pathValue: string, startLine: number, snippet: string) { return [{ path: pathValue, startLine, endLine: startLine, snippet }]; }

function workflowOutput() {
  return {
    action: "result", reply: "提取明确流程", reads: [], capability: "workflow", entry: "flow.start",
    nodes: [
      { id: "flow.start", kind: "start", title: "开始", description: null, doc: "docs/flow.md", docAnchor: null, x: 0, y: 0, confidence: "high", evidence: evidence("docs/flow.md", 1, "# Flow") },
      { id: "flow.collect", kind: "step", title: "Collect", description: null, doc: "docs/flow.md", docAnchor: null, x: 220, y: 0, confidence: "high", evidence: evidence("docs/flow.md", 3, "1. Collect") },
      { id: "flow.end", kind: "end", title: "Review", description: null, doc: "docs/flow.md", docAnchor: null, x: 440, y: 0, confidence: "high", evidence: evidence("docs/flow.md", 4, "2. Review") }
    ],
    edges: [
      { id: "edge.start-collect", from: "flow.start", to: "flow.collect", kind: "flow", label: null, conditionJson: null, confidence: "high", evidence: evidence("docs/flow.md", 3, "1. Collect") },
      { id: "edge.collect-end", from: "flow.collect", to: "flow.end", kind: "flow", label: null, conditionJson: null, confidence: "high", evidence: evidence("docs/flow.md", 4, "2. Review") }
    ], questions: []
  };
}

function contentOutput() {
  return {
    action: "result", reply: "内容型候选", reads: [], capability: "content-only", entry: null,
    nodes: [{ id: "knowledge.overview", kind: "knowledge", title: "LLM 内容概览", description: null, doc: "SKILL.md", docAnchor: null, x: 0, y: 0, confidence: "medium", evidence: evidence("SKILL.md", 1, "# LLM Import") }],
    edges: [], questions: []
  };
}

class SequenceProvider implements LLMProvider {
  requests: ModelInvocationRequest[] = [];
  private index = 0;
  constructor(private readonly outputs: unknown[]) {}
  async probe(): Promise<ModelProviderCapability> { return { schemaVersion: "1.0", providerId: "import-sequence", label: "Import Sequence", status: "ready", keyConfigured: true, defaultModel: "parser-model", reason: "ready", checkedAt: "2026-07-29T09:00:00.000Z" }; }
  async invoke<T>(request: ModelInvocationRequest): Promise<ModelInvocationResponse<T>> {
    this.requests.push(structuredClone(request));
    const output = this.outputs[this.index++];
    return { providerId: "import-sequence", responseId: `parse-${this.index}`, model: "parser-model-resolved", output: output as T, usage: { inputTokens: 24, outputTokens: 6, totalTokens: 30, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 }, durationMs: 35 };
  }
}

class AbortableProvider implements LLMProvider {
  readonly started: Promise<void>;
  private markStarted!: () => void;
  constructor() { this.started = new Promise((resolve) => { this.markStarted = resolve; }); }
  async probe(): Promise<ModelProviderCapability> { return { schemaVersion: "1.0", providerId: "import-abort", label: "Import Abort", status: "ready", keyConfigured: true, defaultModel: "parser-model", reason: "ready", checkedAt: "2026-07-29T09:00:00.000Z" }; }
  async invoke<T>(_request: ModelInvocationRequest, signal: AbortSignal): Promise<ModelInvocationResponse<T>> {
    this.markStarted();
    return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new ModelProviderError("cancelled", "已取消", false)), { once: true }));
  }
}
