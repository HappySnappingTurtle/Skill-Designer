import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { BenchmarkRunnerService } from "../src/benchmark-runner.js";
import { OpenAIResponsesProvider } from "../src/model-provider.js";
import { ModelSettingsService } from "../src/model-settings.js";
import { ImportLLMParserService } from "../src/import-llm-parser.js";
import { RuntimeDebugService } from "../src/runtime-debug.js";
import { SandboxControlService } from "../src/sandbox-control.js";
import { SandboxCapabilityService } from "../src/sandbox.js";
import { WorkspaceStore } from "../src/store.js";

let root: string;
let baseUrl: string;
let token: string;
let server: ReturnType<typeof createApp>;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-http-"));
  const store = new WorkspaceStore({ dataDir: root });
  await store.initialize();
  const missingDocker = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
  const capabilityService = new SandboxCapabilityService({
    platform: "darwin",
    arch: "arm64",
    now: () => new Date("2026-07-28T04:00:00.000Z"),
    executor: { run: async () => { throw missingDocker; } }
  });
  const sandboxControl = new SandboxControlService({
    dataRoot: path.join(root, "sandbox"),
    capabilityService,
    now: () => new Date("2026-07-28T04:00:00.000Z"),
    idFactory: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  });
  const benchmarkRunner = new BenchmarkRunnerService({
    dataRoot: path.join(root, "benchmark"),
    store,
    sandboxCapabilities: sandboxControl,
    provider: new OpenAIResponsesProvider({ now: () => new Date("2026-07-28T04:00:00.000Z") }),
    now: () => new Date("2026-07-28T04:00:00.000Z")
  });
  await benchmarkRunner.initialize();
  let storedModelKey = "";
  const modelSettings = new ModelSettingsService({
    dataDir: root,
    environment: {},
    credentialStore: {
      capability: () => ({ backend: "macos-keychain", status: "ready", label: "测试钥匙串", reason: "测试" }),
      get: async () => storedModelKey || null,
      set: async (secret) => { storedModelKey = secret; },
      delete: async () => { storedModelKey = ""; }
    },
    fetch: async () => new Response(JSON.stringify({ id: "gpt-5.6-terra" }), { status: 200 })
  });
  await modelSettings.initialize();
  const importLLMParser = new ImportLLMParserService({
    dataRoot: path.join(root, "import-llm-parser"),
    store,
    provider: {
      probe: async () => ({ schemaVersion: "1.0", providerId: "http-import-parser", label: "HTTP Import Parser", status: "ready", keyConfigured: true, defaultModel: "parser-model", reason: "ready", checkedAt: "2026-07-28T04:00:00.000Z" }),
      invoke: async <T>(modelRequest: import("@skill-designer/engine").ModelInvocationRequest) => {
        const input = modelRequest.input as { files?: Array<{ path: string; content: string }> };
        const skill = input.files?.find((file) => file.path === "SKILL.md")?.content ?? "# Skill";
        const heading = skill.split(/\r?\n/u)[0] || "# Skill";
        return {
          providerId: "http-import-parser",
          responseId: "http-import-response",
          model: "parser-model-resolved",
          output: {
            action: "result", reply: "内容候选", reads: [], capability: "content-only", entry: null,
            nodes: [{ id: "knowledge.overview", kind: "knowledge", title: "内容概览", description: null, doc: "SKILL.md", docAnchor: null, x: 0, y: 0, confidence: "high", evidence: [{ path: "SKILL.md", startLine: 1, endLine: 1, snippet: heading }] }],
            edges: [], questions: []
          } as T,
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
          durationMs: 20
        };
      }
    }
  });
  await importLLMParser.initialize();
  const runtimeDebug = new RuntimeDebugService({
    dataRoot: path.join(root, "runtime-dialog"),
    store,
    provider: {
      probe: async () => ({ schemaVersion: "1.0", providerId: "http-runtime", label: "HTTP Runtime", status: "ready", keyConfigured: true, defaultModel: "runtime-model", reason: "ready", checkedAt: "2026-07-28T04:00:00.000Z" }),
      invoke: async <T>() => ({
        providerId: "http-runtime", responseId: "http-runtime-response", model: "runtime-model-resolved",
        output: { action: "advance", reply: "进入核心步骤", nextNodeId: "flow.core-step", summary: "推进" } as T,
        usage: { inputTokens: 18, outputTokens: 7, totalTokens: 25, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
        durationMs: 30
      })
    }
  });
  await runtimeDebug.initialize();
  server = createApp({
    store,
    allowedOrigins: ["http://127.0.0.1:5173"],
    sandboxControl,
    benchmarkRunner,
    modelSettings,
    importLLMParser,
    runtimeDebug
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await request("/api/session", { token: false });
  token = (session.data as { token: string }).token;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(root, { recursive: true, force: true });
});

async function request(
  pathname: string,
  options: { method?: string; body?: unknown; token?: boolean; origin?: string } = {}
): Promise<{ ok: boolean; data?: unknown; error?: { code: string } }> {
  const response = await fetch(baseUrl + pathname, {
    method: options.method ?? "GET",
    headers: {
      Origin: options.origin ?? "http://127.0.0.1:5173",
      ...(options.token === false ? {} : { "x-skill-designer-token": token }),
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  return (await response.json()) as { ok: boolean; data?: unknown; error?: { code: string } };
}

describe("workspace HTTP API", () => {
  it("passes Benchmark RuntimeArtifact references into storage cleanup", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "HTTP Artifact 存储" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;
    const detail = await request(`/api/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: { name: "HTTP Artifact Skill", capability: "workflow" }
    });
    const member = (detail.data as { members: Array<{ projectId: string; skillId: string }> }).members[0]!;
    const started = await request(`/api/projects/${member.projectId}/runs`, { method: "POST", body: { workspaceId } });
    const runtimeArtifact = (started.data as { artifact: import("@skill-designer/engine").RuntimeArtifact }).artifact;
    const artifactDir = path.join(root, "projects", member.projectId, "runtime-artifacts");
    const benchmarkArtifactId = "artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const orphanArtifactId = "artifact-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const writeArtifact = async (artifactId: string) => {
      const artifact = { ...structuredClone(runtimeArtifact), artifactId, createdAt: "2026-07-18T04:00:00.000Z" };
      const file = path.join(artifactDir, `${artifactId}.json`);
      await writeFile(file, JSON.stringify(artifact, null, 2) + "\n", "utf8");
      return file;
    };
    const benchmarkArtifactFile = await writeArtifact(benchmarkArtifactId);
    const orphanArtifactFile = await writeArtifact(orphanArtifactId);
    const benchmarkRunId = "benchmark-run-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const benchmarkFile = path.join(root, "benchmark", "runs", member.projectId, `${benchmarkRunId}.json`);
    await mkdir(path.dirname(benchmarkFile), { recursive: true });
    await writeFile(benchmarkFile, JSON.stringify({
      schemaVersion: "1.0",
      benchmarkRunId,
      workspaceId,
      projectId: member.projectId,
      skillId: member.skillId,
      createdAt: "2026-07-28T04:00:00.000Z",
      fingerprint: { runtimeArtifactId: benchmarkArtifactId }
    }, null, 2) + "\n", "utf8");

    const status = (await request(`/api/projects/${member.projectId}/runtime-artifacts/storage?workspaceId=${workspaceId}`)).data as import("@skill-designer/engine").RuntimeArtifactStorageStatus;
    expect(status).toMatchObject({ totalCount: 3, protectedCount: 2, orphanedCount: 1, eligibleCount: 1, benchmarkRunCount: 1 });
    const cleanup = (await request(`/api/projects/${member.projectId}/runtime-artifacts/storage`, {
      method: "POST",
      body: { workspaceId }
    })).data as import("@skill-designer/engine").RuntimeArtifactCleanupResult;
    expect(cleanup.deletedArtifactIds).toEqual([orphanArtifactId]);
    expect(cleanup.after).toMatchObject({ totalCount: 2, protectedCount: 2, orphanedCount: 0, eligibleCount: 0 });
    expect((await stat(benchmarkArtifactFile)).isFile()).toBe(true);
    await expect(readFile(orphanArtifactFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists, downloads, and deletes dual-format Bug Report history", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "HTTP 报告历史" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;
    const detail = await request(`/api/workspaces/${workspaceId}/members`, { method: "POST", body: { name: "HTTP 报告 Skill", capability: "workflow" } });
    const projectId = (detail.data as { members: Array<{ projectId: string }> }).members[0]!.projectId;
    const started = await request(`/api/projects/${projectId}/runs`, { method: "POST", body: { workspaceId } });
    const runId = (started.data as { run: { runId: string } }).run.runId;
    await request(`/api/projects/${projectId}/runs/${runId}/next`, { method: "POST", body: { nextNodeId: "flow.core-step" } });
    await request(`/api/projects/${projectId}/runs/${runId}/next`, { method: "POST", body: { nextNodeId: "flow.end" } });
    const preview = await request(`/api/projects/${projectId}/runs/${runId}/reports`, { method: "POST", body: { workspaceId, sanitizationMode: "strict", userNote: "HTTP 说明" } });
    const report = preview.data as { reportId: string; digest: string };
    await request(`/api/reports/${report.reportId}/confirm`, { method: "POST", body: { digest: report.digest } });
    expect((await request(`/api/projects/${projectId}/reports?workspaceId=${workspaceId}`)).data).toEqual([expect.objectContaining({ reportId: report.reportId, status: "ready", markdownFileName: expect.stringMatching(/\.md$/u) })]);
    const markdown = await fetch(`${baseUrl}/api/reports/${report.reportId}/download?format=markdown`, { headers: { Origin: "http://127.0.0.1:5173", "x-skill-designer-token": token } });
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(await markdown.text()).toContain("# Bug Report：HTTP 报告 Skill");
    expect(await request(`/api/reports/${report.reportId}`, { method: "DELETE", body: { workspaceId } })).toMatchObject({ data: { reportId: report.reportId, projectId, deleted: true } });
    expect((await request(`/api/projects/${projectId}/reports?workspaceId=${workspaceId}`)).data).toEqual([]);
  });

  it("lists and deletes isolated generic export records", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "HTTP 导出历史" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;
    const workspace = await request(`/api/workspaces/${workspaceId}/members`, { method: "POST", body: { name: "HTTP 导出 Skill", capability: "workflow" } });
    const member = (workspace.data as { members: Array<{ projectId: string; activeRevision: string }> }).members[0]!;
    expect((await request(`/api/projects/${member.projectId}/exports?workspaceId=${workspaceId}`)).data).toEqual([]);
    const preview = await request(`/api/projects/${member.projectId}/exports`, { method: "POST", body: { workspaceId, revisionId: member.activeRevision, profile: "generic/1" } });
    const exportRecord = preview.data as { exportId: string; digest: string; revisionId: string };
    expect((await request(`/api/projects/${member.projectId}/exports?workspaceId=${workspaceId}`)).data).toEqual([expect.objectContaining({ exportId: exportRecord.exportId, status: "proposed" })]);
    await request(`/api/exports/${exportRecord.exportId}/confirm`, { method: "POST", body: { digest: exportRecord.digest, revisionId: exportRecord.revisionId } });
    expect(await request(`/api/exports/${exportRecord.exportId}`, { method: "DELETE", body: { workspaceId } })).toMatchObject({ data: { exportId: exportRecord.exportId, deleted: true } });
    expect((await request(`/api/projects/${member.projectId}/exports?workspaceId=${workspaceId}`)).data).toEqual([]);
  });

  it("runs a model debug turn through HTTP and persists conversation plus Trace", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "运行对话接口" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;
    const workspace = await request(`/api/workspaces/${workspaceId}/members`, { method: "POST", body: { name: "运行对话 Skill", capability: "workflow" } });
    const projectId = (workspace.data as { members: Array<{ projectId: string }> }).members[0]!.projectId;
    const started = await request(`/api/projects/${projectId}/runs`, { method: "POST", body: { workspaceId } });
    const runId = (started.data as { run: { runId: string } }).run.runId;

    const turn = await request(`/api/projects/${projectId}/runs/${runId}/dialog`, { method: "POST", body: { workspaceId, content: "开始运行" } });
    expect(turn.data).toMatchObject({
      message: { kind: "advanced", decision: { nextNodeId: "flow.core-step", accepted: true }, model: { usage: { totalTokens: 25 } } },
      view: { run: { state: { currentNodeId: "flow.core-step" } } }
    });
    const history = await request(`/api/projects/${projectId}/runs/${runId}/dialog?workspaceId=${workspaceId}`);
    expect(history.data).toMatchObject({ runId, artifactId: expect.any(String), messages: [{ role: "user" }, { role: "assistant", kind: "advanced" }] });
    const trace = await request(`/api/projects/${projectId}/traces/${runId}/events?afterSeq=2`);
    expect((trace.data as { events: Array<{ type: string }> }).events.map((event) => event.type)).toEqual([
      "conversation.user", "llm.request", "llm.response", "engine.enter", "conversation.assistant"
    ]);
  });

  it("runs and restores a guarded LLM import parse through HTTP", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "LLM 解析接口" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;
    const imported = await request(`/api/workspaces/${workspaceId}/imports`, {
      method: "POST",
      body: { folderName: "http-llm", files: [{ path: "SKILL.md", contentBase64: Buffer.from("# HTTP LLM Skill\n").toString("base64") }] }
    });
    const candidate = (imported.data as { candidate: { importId: string; parseReview: { reviewRevision: number } } }).candidate;
    const parsed = await request(`/api/imports/${candidate.importId}/llm-parse`, {
      method: "POST",
      body: { workspaceId, reviewRevision: candidate.parseReview.reviewRevision }
    });
    expect(parsed.data).toMatchObject({ run: { status: "completed", callCount: 1, usage: { totalTokens: 30 }, resultReviewRevision: 2 }, candidate: { parseReview: { parserVersion: "llm-v1", reviewRevision: 2 } } });
    const latest = await request(`/api/imports/${candidate.importId}/llm-parse?workspaceId=${workspaceId}`);
    expect(latest.data).toMatchObject({ status: "completed", resultReviewRevision: 2 });
    const wrongWorkspace = await request(`/api/imports/${candidate.importId}/llm-parse?workspaceId=workspace-00000000-0000-4000-8000-000000000000`);
    expect(wrongWorkspace).toMatchObject({ ok: false, error: { code: "import_workspace_mismatch" } });
  });

  it("updates and tests model settings without returning or persisting the API key", async () => {
    const updated = await request("/api/settings/model", {
      method: "PUT",
      body: { model: "gpt-5.6-terra", timeoutMs: 30_000, apiKey: "sk-http-private-value" }
    });
    expect(updated.ok).toBe(true);
    expect(updated.data).toMatchObject({ keyConfigured: true, keySource: "os-store", model: "gpt-5.6-terra", timeoutMs: 30_000 });
    expect(JSON.stringify(updated)).not.toContain("sk-http-private-value");
    expect(await readFile(path.join(root, "config", "model.json"), "utf8")).not.toContain("sk-http-private-value");

    const tested = await request("/api/settings/model/test", { method: "POST", body: {} });
    expect(tested.data).toMatchObject({ status: "ready", model: "gpt-5.6-terra", attempts: 1 });

    const removed = await request("/api/settings/model", { method: "DELETE" });
    expect(removed.data).toMatchObject({ keyConfigured: false, keySource: "none" });
  });

  it("returns frontmatter, reference inventory, and provenance in import previews", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "导入事实接口" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;
    const markdown = `---
name: HTTP 元数据 Skill
description: 验证导入事实接口。
references: [docs/guide.md]
metadata:
  owner: api-team
---
# Fallback

[指南](docs/guide.md#guide)
![缺失](assets/missing.png)
`;
    const imported = await request(`/api/workspaces/${workspaceId}/imports`, {
      method: "POST",
      body: {
        folderName: "http-metadata",
        files: [
          { path: "SKILL.md", contentBase64: Buffer.from(markdown).toString("base64") },
          { path: "docs/guide.md", contentBase64: Buffer.from("# Guide\n").toString("base64") }
        ]
      }
    });
    const candidate = (imported.data as { candidate: {
      detectedFormat: string;
      frontmatter: { dialect: string; data: unknown; unknownKeys: string[] };
      references: Array<{ rawTarget: string; status: string }>;
      provenance: Array<{ subject: string; method: string }>;
      diagnostics: Array<{ code: string }>;
    } }).candidate;
    expect(candidate.detectedFormat).toBe("frontmatter-skill");
    expect(candidate.frontmatter).toMatchObject({ dialect: "yaml", data: { metadata: { owner: "api-team" } }, unknownKeys: ["metadata", "references"] });
    expect(candidate.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawTarget: "docs/guide.md#guide", status: "resolved" }),
      expect.objectContaining({ rawTarget: "assets/missing.png", status: "missing" })
    ]));
    expect(candidate.provenance).toContainEqual(expect.objectContaining({ subject: "display-name", method: "frontmatter" }));
    expect(candidate.diagnostics).toContainEqual(expect.objectContaining({ code: "missing_import_references" }));
  });

  it("exposes parse review, reparse conflict, and explicit resolution routes", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "导入接口" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;
    const imported = await request(`/api/workspaces/${workspaceId}/imports`, {
      method: "POST",
      body: {
        folderName: "review-skill",
        files: [{
          path: "SKILL.md",
          contentBase64: Buffer.from("# 审阅 Skill\n\n## 流程\n\n### 收集\n\n### 确认\n").toString("base64")
        }]
      }
    });
    const candidate = (imported.data as { candidate: {
      importId: string;
      parseReview: { reviewRevision: number; entry?: string; nodes: Array<{ candidateId: string; decision: string; value: { title: string } }>; edges: Array<{ candidateId: string; decision: string; value: unknown }> };
    } }).candidate;
    const updated = await request(`/api/imports/${candidate.importId}/review`, {
      method: "PATCH",
      body: {
        workspaceId,
        reviewRevision: candidate.parseReview.reviewRevision,
        entry: candidate.parseReview.entry,
        nodes: candidate.parseReview.nodes.map((node) => ({ ...node, value: node.value.title === "确认" ? { ...node.value, title: "人工确认" } : node.value })),
        edges: candidate.parseReview.edges
      }
    });
    const reviewed = updated.data as { parseReview: { reviewRevision: number; manuallyEdited: boolean } };
    expect(reviewed.parseReview.manuallyEdited).toBe(true);

    const reparsed = await request(`/api/imports/${candidate.importId}/reparse`, {
      method: "POST",
      body: { workspaceId, reviewRevision: reviewed.parseReview.reviewRevision }
    });
    const conflicted = reparsed.data as { parseReview: { reviewRevision: number; reparseConflict?: { kind: string } } };
    expect(conflicted.parseReview.reparseConflict?.kind).toBe("manual-vs-reparse");

    const resolved = await request(`/api/imports/${candidate.importId}/reparse/resolve`, {
      method: "POST",
      body: { workspaceId, reviewRevision: conflicted.parseReview.reviewRevision, choice: "reparse" }
    });
    expect((resolved.data as { parseReview: { manuallyEdited: boolean; reparseConflict?: unknown } }).parseReview)
      .toMatchObject({ manuallyEdited: false });
    expect((resolved.data as { parseReview: { reparseConflict?: unknown } }).parseReview.reparseConflict).toBeUndefined();
  });

  it("creates a workspace, adds two skills, and switches selection", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "接口验收" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;

    const first = await request(`/api/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: { name: "流程 Skill", capability: "workflow" }
    });
    const firstMember = (first.data as { members: Array<{ projectId: string; skillId: string }> }).members[0]!;
    const firstProject = firstMember.projectId;
    await request(`/api/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: { name: "内容 Skill", capability: "content-only" }
    });

    const selected = await request(`/api/workspaces/${workspaceId}/select`, {
      method: "POST",
      body: { projectId: firstProject }
    });
    expect((selected.data as { selectedProjectId: string }).selectedProjectId).toBe(firstProject);

    const graph = await request(`/api/projects/${firstProject}/graph`);
    expect((graph.data as { graph: { nodes: unknown[] }; lint: unknown[] }).graph.nodes).toHaveLength(3);
    expect((graph.data as { lint: unknown[] }).lint).toEqual([]);
    const graphPayload = graph.data as { activeRevision: string };
    const graphProposal = await request(`/api/projects/${firstProject}/changesets`, {
      method: "POST",
      body: {
        workspaceId,
        baseRevision: graphPayload.activeRevision,
        reason: "HTTP 节点重命名",
        operations: [{
          op: "graph.node.update",
          target: "flow.core-step",
          value: { id: "flow.core-step", kind: "step", title: "需求澄清", position: { x: 360, y: 180 } }
        }]
      }
    });
    const graphChange = graphProposal.data as { changeSetId: string; digest: string; baseRevision: string };
    await request(`/api/changesets/${graphChange.changeSetId}/confirm-and-apply`, {
      method: "POST",
      body: { digest: graphChange.digest, baseRevision: graphChange.baseRevision }
    });
    const changedGraph = await request(`/api/projects/${firstProject}/graph`);
    expect((changedGraph.data as { graph: { nodes: Array<{ title: string }> } }).graph.nodes.map((node) => node.title))
      .toContain("需求澄清");

    const rejectedProposal = await request(`/api/projects/${firstProject}/changesets`, {
      method: "POST",
      body: {
        workspaceId,
        baseRevision: (changedGraph.data as { activeRevision: string }).activeRevision,
        reason: "HTTP 拒绝节点重命名",
        operations: [{
          op: "graph.node.update",
          target: "flow.core-step",
          value: { id: "flow.core-step", kind: "step", title: "不应写入", position: { x: 360, y: 180 } }
        }]
      }
    });
    const rejectedChange = rejectedProposal.data as { changeSetId: string; digest: string; baseRevision: string };
    const rejectedChangeResponse = await request(`/api/changesets/${rejectedChange.changeSetId}/reject`, {
      method: "POST",
      body: { digest: rejectedChange.digest, baseRevision: rejectedChange.baseRevision, reason: "页面明确拒绝" }
    });
    expect(rejectedChangeResponse.data).toMatchObject({
      status: "rejected",
      rejectionReason: "页面明确拒绝",
      rejectedAt: expect.any(String)
    });
    expect((await request(`/api/projects/${firstProject}/graph`)).data).toMatchObject({
      activeRevision: (changedGraph.data as { activeRevision: string }).activeRevision,
      graph: { nodes: expect.arrayContaining([expect.objectContaining({ id: "flow.core-step", title: "需求澄清" })]) }
    });
    expect(await request(`/api/changesets/${rejectedChange.changeSetId}/confirm-and-apply`, {
      method: "POST",
      body: { digest: rejectedChange.digest, baseRevision: rejectedChange.baseRevision }
    })).toMatchObject({ ok: false, error: { code: "changeset_not_proposed" } });

    const undoProposal = await request(`/api/projects/${firstProject}/undo-changesets`, {
      method: "POST",
      body: { workspaceId, baseRevision: (changedGraph.data as { activeRevision: string }).activeRevision }
    });
    const undoChange = undoProposal.data as { changeSetId: string; digest: string; baseRevision: string; preview: Array<{ kind: string; files: Array<{ path: string }> }> };
    expect(undoChange.preview[0]).toMatchObject({ kind: "project-restore", files: [expect.objectContaining({ path: "graph/main.json" })] });
    const undoApplied = await request(`/api/changesets/${undoChange.changeSetId}/confirm-and-apply`, {
      method: "POST",
      body: { digest: undoChange.digest, baseRevision: undoChange.baseRevision }
    });
    expect(undoApplied.data).toMatchObject({ restoredRevision: graphChange.baseRevision, activeRevision: expect.any(String) });
    expect((await request(`/api/projects/${firstProject}/graph`)).data).toMatchObject({
      graph: { nodes: expect.arrayContaining([expect.objectContaining({ id: "flow.core-step", title: "核心步骤" })]) }
    });
    expect((await request(`/api/projects/${firstProject}/revisions`)).data).toEqual(expect.arrayContaining([expect.objectContaining({ source: "undo", changeSetId: undoChange.changeSetId })]));

    const startedRun = await request(`/api/projects/${firstProject}/runs`, {
      method: "POST",
      body: { workspaceId }
    });
    const run = startedRun.data as { run: { runId: string; state: { currentNodeId: string } } };
    expect(run.run.state.currentNodeId).toBe("flow.start");
    const rejectedRun = await request(`/api/projects/${firstProject}/runs/${run.run.runId}/next`, {
      method: "POST",
      body: { nextNodeId: "flow.undeclared" }
    });
    const rejectedData = rejectedRun.data as {
      run: { state: { currentNodeId: string }; events: Array<{ type: string }> };
      commandResult: { accepted: boolean; eventSeqs: number[]; rejection: { code: string; requestedNodeId: string } };
    };
    expect(rejectedData.run.state.currentNodeId).toBe("flow.start");
    expect(rejectedData.run.events.at(-1)?.type).toBe("engine.reject");
    expect(rejectedData.commandResult).toMatchObject({
      accepted: false,
      eventSeqs: [3],
      rejection: { code: "next_node_not_allowed", requestedNodeId: "flow.undeclared" }
    });
    const advancedRun = await request(`/api/projects/${firstProject}/runs/${run.run.runId}/next`, {
      method: "POST",
      body: { nextNodeId: "flow.core-step" }
    });
    expect((advancedRun.data as { run: { state: { currentNodeId: string } } }).run.state.currentNodeId).toBe("flow.core-step");
    const trace = await request(`/api/projects/${firstProject}/traces/${run.run.runId}/events?afterSeq=2`);
    expect(trace.data).toMatchObject({
      schemaVersion: "1.0",
      traceId: run.run.runId,
      afterSeq: 2,
      latestSeq: 4,
      projection: {
        currentNodeId: "flow.core-step",
        nodeStates: { "flow.start": "visited", "flow.core-step": "current" },
        rejectedTransitions: [{ seq: 3, from: "flow.start", requestedNodeId: "flow.undeclared" }]
      }
    });
    expect((trace.data as { events: unknown[] }).events).toHaveLength(2);
    await request(`/api/projects/${firstProject}/runs/${run.run.runId}/next`, {
      method: "POST",
      body: { nextNodeId: "flow.end" }
    });
    const runtimeCandidate = await request(`/api/projects/${firstProject}/runs/${run.run.runId}/benchmark-candidate`, {
      method: "POST",
      body: { workspaceId }
    });
    expect(runtimeCandidate.data).toMatchObject({
      source: { runId: run.run.runId, status: "completed" },
      case: {
        status: "draft",
        expected: {
          path: { nodeIds: ["flow.start", "flow.core-step", "flow.end"] },
          terminal: { status: "completed", nodeId: "flow.end" }
        }
      }
    });
    expect((runtimeCandidate.data as { case: object }).case).not.toHaveProperty("source");
    const reportPreview = await request(`/api/projects/${firstProject}/runs/${run.run.runId}/reports`, {
      method: "POST",
      body: { workspaceId, sanitizationMode: "strict", userNote: "内部说明 sk-abcdefghijklmnop" }
    });
    const reportRecord = reportPreview.data as {
      reportId: string;
      digest: string;
      report: { userNote: string; symptoms: Array<{ code: string }>; source: { runId: string } };
    };
    expect(reportRecord.report).toMatchObject({
      userNote: "[已按严格模式移除用户说明]",
      symptoms: [{ code: "transition_rejected" }],
      source: { runId: run.run.runId }
    });
    await request(`/api/reports/${reportRecord.reportId}/confirm`, {
      method: "POST",
      body: { digest: reportRecord.digest }
    });
    const downloadedReport = await fetch(`${baseUrl}/api/reports/${reportRecord.reportId}/download`, {
      headers: { Origin: "http://127.0.0.1:5173", "x-skill-designer-token": token }
    });
    expect(downloadedReport.status).toBe(200);
    expect(downloadedReport.headers.get("content-disposition")).toContain(".report.json");
    const downloadedReportDocument = await downloadedReport.json() as {
      reportId: string;
      reportVersion: string;
      skill: { skillId: string; contentHash: string };
      source: { runId: string };
      trace: Array<{ skillId: string; type: string; data: Record<string, unknown> }>;
      symptoms: Array<{ code: string; requestedNodeId?: string }>;
      graphProjection: { skillId: string };
      sanitization: { mode: string };
      runtime: { artifactFingerprint?: { projectContentHash: string; inputHash: string; value: string } };
    };
    expect(downloadedReportDocument).toMatchObject({
      reportVersion: "1.0",
      source: { runId: run.run.runId },
      sanitization: { mode: "strict" },
      runtime: { artifactFingerprint: { projectContentHash: expect.any(String), inputHash: expect.any(String), value: expect.any(String) } }
    });
    const exactImport = await request(`/api/workspaces/${workspaceId}/report-imports`, {
      method: "POST",
      body: { contentBase64: Buffer.from(JSON.stringify(downloadedReportDocument)).toString("base64") }
    });
    expect(exactImport.data).toMatchObject({ match: { status: "matched", matchedProjectId: firstProject } });
    const reportImportId = (exactImport.data as { reportImportId: string }).reportImportId;
    const duplicateImport = await request(`/api/workspaces/${workspaceId}/report-imports`, {
      method: "POST",
      body: { contentBase64: Buffer.from(JSON.stringify(downloadedReportDocument)).toString("base64") }
    });
    expect(duplicateImport.data).toMatchObject({ reportImportId });
    const diagnosisResponse = await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/diagnoses`, {
      method: "POST",
      body: {}
    });
    expect(diagnosisResponse.data).toMatchObject({
      workspaceId,
      reportImportId,
      reportId: reportRecord.reportId,
      skillId: firstMember.skillId,
      candidates: [
        {
          category: "invalid-transition",
          confidence: "high",
          statement: expect.stringContaining("提交来源尚未确定"),
          evidence: expect.arrayContaining([expect.objectContaining({ source: "trace", seq: 3 })])
        },
        {
          category: "graph-reference",
          confidence: "medium",
          statement: expect.stringContaining("仅凭当前报告不能二选一")
        }
      ],
      limitations: expect.arrayContaining([expect.stringContaining("无法判断提交来自模型、用户还是测试脚本")])
    });
    const persistedDiagnoses = await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/diagnoses`);
    expect(persistedDiagnoses.data).toEqual([expect.objectContaining({ diagnosisId: (diagnosisResponse.data as { diagnosisId: string }).diagnosisId })]);

    const repairableReport = structuredClone(downloadedReportDocument);
    repairableReport.reportId = "report-11111111-1111-4111-8111-111111111111";
    repairableReport.symptoms[0]!.requestedNodeId = "flow.end";
    const rejectedEvent = repairableReport.trace.find((event) => event.type === "engine.reject")!;
    rejectedEvent.data.requestedNodeId = "flow.end";
    const repairableImport = await request(`/api/workspaces/${workspaceId}/report-imports`, {
      method: "POST",
      body: { contentBase64: Buffer.from(JSON.stringify(repairableReport)).toString("base64") }
    });
    expect(repairableImport.data).toMatchObject({ match: { status: "matched", matchedProjectId: firstProject } });
    const repairableImportId = (repairableImport.data as { reportImportId: string }).reportImportId;
    const repairableDiagnosis = await request(`/api/workspaces/${workspaceId}/report-imports/${repairableImportId}/diagnoses`, { method: "POST", body: {} });
    const repairableDiagnosisData = repairableDiagnosis.data as { diagnosisId: string; candidates: Array<{ candidateId: string; repair?: { operation: { value: { from: string; to: string } } } }> };
    expect(repairableDiagnosisData.candidates[0]?.repair).toMatchObject({ operation: { value: { from: "flow.start", to: "flow.end" } } });
    const rejectedRepairProposal = await request(`/api/workspaces/${workspaceId}/report-imports/${repairableImportId}/repairs`, {
      method: "POST",
      body: { diagnosisId: repairableDiagnosisData.diagnosisId, candidateId: repairableDiagnosisData.candidates[0]!.candidateId }
    });
    const rejectedRepairData = rejectedRepairProposal.data as { repair: { repairId: string; status: string; proposalStatus: string }; changeSet: { changeSetId: string; digest: string; baseRevision: string } };
    expect(rejectedRepairData.repair).toMatchObject({ status: "unverified", proposalStatus: "proposed" });
    const rejectedRepair = await request(`/api/workspaces/${workspaceId}/report-imports/${repairableImportId}/repairs/${rejectedRepairData.repair.repairId}/reject`, {
      method: "POST",
      body: { digest: rejectedRepairData.changeSet.digest, baseRevision: rejectedRepairData.changeSet.baseRevision, reason: "页面拒绝首次修复提案" }
    });
    expect(rejectedRepair.data).toMatchObject({ repair: { proposalStatus: "rejected", status: "unverified" }, changeSet: { status: "rejected", rejectionReason: "页面拒绝首次修复提案" } });
    expect((await request(`/api/projects/${firstProject}/graph`)).data).not.toMatchObject({ graph: { edges: expect.arrayContaining([expect.objectContaining({ id: "edge.diagnosis-3" })]) } });
    const repairProposal = await request(`/api/workspaces/${workspaceId}/report-imports/${repairableImportId}/repairs`, {
      method: "POST",
      body: { diagnosisId: repairableDiagnosisData.diagnosisId, candidateId: repairableDiagnosisData.candidates[0]!.candidateId }
    });
    const proposalData = repairProposal.data as { repair: { repairId: string; status: string; proposalStatus: string }; changeSet: { changeSetId: string; digest: string; baseRevision: string } };
    expect(proposalData.repair.status).toBe("unverified");
    expect((await request(`/api/projects/${firstProject}/graph`)).data).not.toMatchObject({ graph: { edges: expect.arrayContaining([expect.objectContaining({ id: "edge.diagnosis-3" })]) } });
    const confirmedRepair = await request(`/api/workspaces/${workspaceId}/report-imports/${repairableImportId}/repairs/${proposalData.repair.repairId}/confirm-and-apply`, {
      method: "POST",
      body: { digest: proposalData.changeSet.digest, baseRevision: proposalData.changeSet.baseRevision }
    });
    expect(confirmedRepair.data).toMatchObject({ repair: { status: "unverified", appliedRevision: expect.any(String) } });
    expect((await request(`/api/projects/${firstProject}/graph`)).data).toMatchObject({ graph: { edges: expect.arrayContaining([expect.objectContaining({ id: "edge.diagnosis-3", from: "flow.start", to: "flow.end" })]) } });
    const verificationRun = await request(`/api/projects/${firstProject}/runs`, { method: "POST", body: { workspaceId } });
    const verificationRunId = (verificationRun.data as { run: { runId: string } }).run.runId;
    const completedVerificationRun = await request(`/api/projects/${firstProject}/runs/${verificationRunId}/next`, { method: "POST", body: { nextNodeId: "flow.end" } });
    expect(completedVerificationRun.data).toMatchObject({ run: { state: { status: "completed" } } });
    const verifiedRepair = await request(`/api/workspaces/${workspaceId}/report-imports/${repairableImportId}/repairs/${proposalData.repair.repairId}/verify`, {
      method: "POST",
      body: { level: "runtime", runId: verificationRunId }
    });
    expect(verifiedRepair.data).toMatchObject({ status: "verified", verification: { level: "runtime", runId: verificationRunId, evidence: expect.arrayContaining([expect.stringContaining("实际经过新增边")]) } });
    expect(await request(`/api/workspaces/${workspaceId}/report-imports/${repairableImportId}/repairs`)).toMatchObject({ data: expect.arrayContaining([
      expect.objectContaining({ repairId: proposalData.repair.repairId, proposalStatus: "applied", status: "verified" }),
      expect.objectContaining({ repairId: rejectedRepairData.repair.repairId, proposalStatus: "rejected", status: "unverified" })
    ]) });

    const fixtureResponse = await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/fixtures`, { method: "POST", body: {} });
    expect(fixtureResponse.data).toMatchObject({
      fixture: {
        kind: "engine-regression",
        benchmarkEligible: false,
        reportImportId,
        reportId: reportRecord.reportId,
        commands: [
          { command: "next", nextNodeId: "flow.undeclared" },
          { command: "next", nextNodeId: "flow.core-step" },
          { command: "next", nextNodeId: "flow.end" }
        ]
      },
      replay: { matches: true, mismatches: [] }
    });
    expect(await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/fixtures`)).toMatchObject({
      data: [expect.objectContaining({ benchmarkEligible: false, reportImportId })]
    });

    const benchmarkCandidateResponse = await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates`, { method: "POST", body: {} });
    const benchmarkCandidate = benchmarkCandidateResponse.data as {
      candidateId: string;
      status: string;
      case: Record<string, unknown> & { caseId: string; source: { reportImportId: string } };
    };
    expect(benchmarkCandidate).toMatchObject({
      status: "draft",
      case: {
        status: "draft",
        expected: { path: { mode: "subsequence", nodeIds: ["flow.start", "flow.core-step", "flow.end"] } },
        source: { kind: "bug-report", reportImportId, reportId: reportRecord.reportId, sourceRunId: run.run.runId }
      }
    });
    const supplementedCandidateCase = {
      ...benchmarkCandidate.case,
      title: "报告复现：非法跳转",
      intent: "人工确认非法跳转会保留当前节点，并留下拒绝事件。",
      notes: "已由用户补充业务期望；保持 draft，后续仍需真实模型 Benchmark。"
    };
    const candidateChangeResponse = await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates/${benchmarkCandidate.candidateId}/changeset`, {
      method: "POST",
      body: { case: supplementedCandidateCase }
    });
    const candidateChange = candidateChangeResponse.data as {
      candidate: { status: string };
      changeSet: { digest: string; baseRevision: string; source: object; evidence: object[] };
    };
    expect(candidateChange.candidate.status).toBe("changeset-created");
    expect(candidateChange.changeSet).toMatchObject({
      source: { kind: "report", sourceId: reportImportId, label: "Bug Report 候选用例" },
      evidence: [
        { kind: "report", ref: reportRecord.reportId },
        { kind: "runtime", ref: run.run.runId }
      ]
    });
    expect(await request(`/api/projects/${firstProject}/benchmark-cases`)).toMatchObject({ data: [] });
    const appliedCandidate = await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates/${benchmarkCandidate.candidateId}/confirm-and-apply`, {
      method: "POST",
      body: { digest: candidateChange.changeSet.digest, baseRevision: candidateChange.changeSet.baseRevision }
    });
    expect(appliedCandidate.data).toMatchObject({ candidate: { status: "applied", appliedRevision: expect.any(String) } });
    expect(await request(`/api/projects/${firstProject}/benchmark-cases`)).toMatchObject({
      data: [expect.objectContaining({ caseId: benchmarkCandidate.case.caseId, title: "报告复现：非法跳转", valid: true })]
    });
    const rejectedBenchmarkCandidateResponse = await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates`, { method: "POST", body: {} });
    const rejectedBenchmarkCandidate = rejectedBenchmarkCandidateResponse.data as typeof benchmarkCandidate;
    const rejectedBenchmarkChangeResponse = await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates/${rejectedBenchmarkCandidate.candidateId}/changeset`, {
      method: "POST",
      body: { case: { ...rejectedBenchmarkCandidate.case, title: "准备拒绝的候选", intent: "验证拒绝不会写入项目" } }
    });
    const rejectedBenchmarkChange = rejectedBenchmarkChangeResponse.data as { changeSet: { digest: string; baseRevision: string } };
    const rejectedBenchmark = await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates/${rejectedBenchmarkCandidate.candidateId}/reject`, {
      method: "POST",
      body: { digest: rejectedBenchmarkChange.changeSet.digest, baseRevision: rejectedBenchmarkChange.changeSet.baseRevision, reason: "页面拒绝候选用例" }
    });
    expect(rejectedBenchmark.data).toMatchObject({ candidate: { status: "rejected" }, changeSet: { status: "rejected", rejectionReason: "页面拒绝候选用例" } });
    expect(await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates`)).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ candidateId: rejectedBenchmarkCandidate.candidateId, status: "rejected" })]) });
    expect((await request(`/api/projects/${firstProject}/benchmark-cases`)).data).toHaveLength(1);

    const mismatchedReport = structuredClone(downloadedReportDocument);
    mismatchedReport.reportId = "report-22222222-2222-4222-8222-222222222222";
    mismatchedReport.skill.contentHash = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    if (mismatchedReport.runtime.artifactFingerprint) {
      mismatchedReport.runtime.artifactFingerprint.projectContentHash = mismatchedReport.skill.contentHash;
      mismatchedReport.runtime.artifactFingerprint.value = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    }
    const mismatchImport = await request(`/api/workspaces/${workspaceId}/report-imports`, {
      method: "POST",
      body: { contentBase64: Buffer.from(JSON.stringify(mismatchedReport)).toString("base64") }
    });
    expect(mismatchImport.data).toMatchObject({ match: { status: "fingerprint-mismatch", matchedProjectId: firstProject } });

    const missingSkillReport = structuredClone(downloadedReportDocument);
    missingSkillReport.reportId = "report-33333333-3333-4333-8333-333333333333";
    missingSkillReport.skill.skillId = "skill-99999999-9999-4999-8999-999999999999";
    missingSkillReport.graphProjection.skillId = missingSkillReport.skill.skillId;
    missingSkillReport.trace.forEach((event) => { event.skillId = missingSkillReport.skill.skillId; });
    const missingImport = await request(`/api/workspaces/${workspaceId}/report-imports`, {
      method: "POST",
      body: { contentBase64: Buffer.from(JSON.stringify(missingSkillReport)).toString("base64") }
    });
    expect(missingImport.data).toMatchObject({ match: { status: "skill-missing" } });
    const importedReports = await request(`/api/workspaces/${workspaceId}/report-imports`);
    expect(importedReports.data).toHaveLength(4);
    expect(await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}`, { method: "DELETE" })).toMatchObject({
      data: { reportImportId, workspaceId, deleted: true, derivedRecordsDeleted: true }
    });
    expect((await request(`/api/workspaces/${workspaceId}/report-imports`)).data).toHaveLength(3);
    expect(await request(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/diagnoses`)).toMatchObject({ ok: false, error: { code: "report_import_not_found" } });
    expect((await request(`/api/projects/${firstProject}/benchmark-cases`)).data).toHaveLength(1);

    const document = await request(`/api/projects/${firstProject}/docs/file?path=SKILL.md`);
    const current = document.data as { content: string; activeRevision: string };
    const proposed = await request(`/api/projects/${firstProject}/changesets`, {
      method: "POST",
      body: {
        workspaceId,
        baseRevision: current.activeRevision,
        reason: "HTTP 文档验收",
        operations: [{ op: "docs.write", target: "docs/guide.md", value: "# Guide\n\nCreated through ChangeSet.\n" }]
      }
    });
    const changeSet = proposed.data as { changeSetId: string; digest: string; baseRevision: string };
    const applied = await request(`/api/changesets/${changeSet.changeSetId}/confirm-and-apply`, {
      method: "POST",
      body: { digest: changeSet.digest, baseRevision: changeSet.baseRevision }
    });
    expect((applied.data as { document: { path: string } }).document.path).toBe("docs/guide.md");
    const docs = await request(`/api/projects/${firstProject}/docs`);
    expect((docs.data as Array<{ path: string }>).map((item) => item.path)).toContain("docs/guide.md");
    const slice = await request(`/api/projects/${firstProject}/docs/slice?path=${encodeURIComponent("docs/guide.md")}&anchor=Guide`);
    expect(slice.data).toMatchObject({ status: "found", documentPath: "docs/guide.md" });
    const references = await request(`/api/projects/${firstProject}/docs/references?path=${encodeURIComponent("docs/guide.md")}`);
    expect(references.data).toEqual([]);

    const caseId = "case-44444444-4444-4444-8444-444444444444";
    const caseProposal = await request(`/api/projects/${firstProject}/changesets`, {
      method: "POST",
      body: {
        workspaceId,
        baseRevision: (applied.data as { activeRevision: string }).activeRevision,
        reason: "HTTP 用例验收",
        operations: [{
          op: "benchmark.case.write",
          target: caseId,
          value: {
            schemaVersion: "1.0",
            caseId,
            skillId: firstMember.skillId,
            title: "HTTP 核心流程",
            status: "ready",
            intent: "验证核心流程",
            fixture: { initialVariables: {}, userReplies: [] },
            expected: {
              path: { mode: "exact", nodeIds: ["flow.start", "flow.core-step", "flow.end"] },
              terminal: { status: "completed", nodeId: "flow.end" },
              variables: {},
              artifacts: [],
              toolResults: [],
              forbiddenEffects: []
            },
            tags: ["http"]
          }
        }]
      }
    });
    const caseChange = caseProposal.data as { changeSetId: string; digest: string; baseRevision: string };
    await request(`/api/changesets/${caseChange.changeSetId}/confirm-and-apply`, {
      method: "POST",
      body: { digest: caseChange.digest, baseRevision: caseChange.baseRevision }
    });
    const cases = await request(`/api/projects/${firstProject}/benchmark-cases`);
    expect(cases.data).toHaveLength(2);
    expect(cases.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ caseId, title: "HTTP 核心流程", valid: true }),
      expect.objectContaining({ caseId: benchmarkCandidate.case.caseId, title: "报告复现：非法跳转", valid: true })
    ]));
    const benchmarkCase = await request(`/api/projects/${firstProject}/benchmark-cases/${caseId}`);
    expect(benchmarkCase.data).toMatchObject({ case: { caseId, status: "ready" } });
    const benchmarkStarted = await request(`/api/projects/${firstProject}/benchmark-runs`, { method: "POST", body: { workspaceId, caseId } });
    const benchmarkRunId = (benchmarkStarted.data as { benchmarkRunId: string }).benchmarkRunId;
    await waitFor(async () => {
      const result = await request(`/api/projects/${firstProject}/benchmark-runs/${benchmarkRunId}`);
      return (result.data as { status: string }).status === "blocked";
    });
    const benchmarkRuns = await request(`/api/projects/${firstProject}/benchmark-runs`);
    expect(benchmarkRuns.data).toEqual([expect.objectContaining({ benchmarkRunId, status: "blocked", automaticVerdict: "not-run", modelCallCount: 0 })]);
    const cancelledTerminal = await request(`/api/projects/${firstProject}/benchmark-runs/${benchmarkRunId}/cancel`, { method: "POST", body: {} });
    expect(cancelledTerminal.data).toMatchObject({ status: "blocked" });
    const blockedReview = await request(`/api/projects/${firstProject}/benchmark-runs/${benchmarkRunId}/reviews`, { method: "POST", body: { verdict: "passed", note: "不得覆盖阻断" } });
    expect(blockedReview.error?.code).toBe("benchmark_not_reviewable");
    const blockedReport = await request(`/api/projects/${firstProject}/benchmark-runs/${benchmarkRunId}/reports`, { method: "POST", body: { workspaceId, sanitizationMode: "default", userNote: "阻断不是 Skill 失败" } });
    expect(blockedReport.error?.code).toBe("benchmark_report_artifact_missing");
    const rerunResponse = await request(`/api/projects/${firstProject}/benchmark-runs`, { method: "POST", body: { workspaceId, caseId, parentBenchmarkRunId: benchmarkRunId } });
    const rerunId = (rerunResponse.data as { benchmarkRunId: string }).benchmarkRunId;
    await waitFor(async () => {
      const result = await request(`/api/projects/${firstProject}/benchmark-runs/${rerunId}`);
      return (result.data as { status: string }).status === "blocked";
    });
    expect((await request(`/api/projects/${firstProject}/benchmark-runs/${rerunId}`)).data).toMatchObject({ lineage: { parentBenchmarkRunId: benchmarkRunId, relation: "rerun" }, status: "blocked" });
    const benchmarkBatch = await request(`/api/projects/${firstProject}/benchmark-runs/batch`, { method: "POST", body: { workspaceId, caseIds: [caseId] } });
    const batchRunId = (benchmarkBatch.data as Array<{ benchmarkRunId: string }>)[0]!.benchmarkRunId;
    await waitFor(async () => {
      const result = await request(`/api/projects/${firstProject}/benchmark-runs/${batchRunId}`);
      return (result.data as { status: string }).status === "blocked";
    });
    expect((await request(`/api/projects/${firstProject}/benchmark-runs`)).data).toEqual(expect.arrayContaining([
      expect.objectContaining({ benchmarkRunId, caseId, status: "blocked" }),
      expect.objectContaining({ benchmarkRunId: rerunId, caseId, status: "blocked", lineage: { parentBenchmarkRunId: benchmarkRunId, relation: "rerun" } }),
      expect.objectContaining({ benchmarkRunId: batchRunId, caseId, status: "blocked" })
    ]));
  });

  it("exposes Workspace rename, member order, and reference-only deletion routes", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "HTTP 生命周期" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;
    const firstResult = await request(`/api/workspaces/${workspaceId}/members`, { method: "POST", body: { name: "Alpha", capability: "workflow" } });
    const secondResult = await request(`/api/workspaces/${workspaceId}/members`, { method: "POST", body: { name: "Beta", capability: "content-only" } });
    const members = (secondResult.data as { members: Array<{ projectId: string }> }).members;
    const firstProjectId = (firstResult.data as { members: Array<{ projectId: string }> }).members[0]!.projectId;
    const secondProjectId = members.find((member) => member.projectId !== firstProjectId)!.projectId;

    const renamed = await request(`/api/workspaces/${workspaceId}`, { method: "PATCH", body: { name: "HTTP 已重命名" } });
    expect(renamed.data).toMatchObject({ name: "HTTP 已重命名" });
    const reordered = await request(`/api/workspaces/${workspaceId}/members/order`, {
      method: "PUT",
      body: { projectIds: [secondProjectId, firstProjectId] }
    });
    expect((reordered.data as { members: Array<{ projectId: string; order: number }> }).members.map((member) => [member.projectId, member.order])).toEqual([
      [secondProjectId, 0],
      [firstProjectId, 1]
    ]);

    const deleted = await request(`/api/workspaces/${workspaceId}`, { method: "DELETE" });
    expect((deleted.data as { preservedProjects: Array<{ projectId: string }> }).preservedProjects).toHaveLength(2);
    expect((await request(`/api/workspaces/${workspaceId}`)).error?.code).toBe("workspace_not_found");
    expect(await readFile(path.join(root, "projects", firstProjectId, "state.json"), "utf8")).toContain(firstProjectId);
  });

  it("reproposes a conflicted ChangeSet through the HTTP API without applying it", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "HTTP 冲突裁决" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;
    const withSkill = await request(`/api/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: { name: "HTTP 冲突 Skill", capability: "workflow" }
    });
    const member = (withSkill.data as { members: Array<{ projectId: string; activeRevision: string }> }).members[0]!;
    const proposalBody = (target: string, value: string) => ({
      workspaceId,
      baseRevision: member.activeRevision,
      reason: `写入 ${target}`,
      operations: [{ op: "docs.write", target, value }]
    });
    const staleResponse = await request(`/api/projects/${member.projectId}/changesets`, {
      method: "POST", body: proposalBody("docs/stale.md", "# stale\n")
    });
    const competingResponse = await request(`/api/projects/${member.projectId}/changesets`, {
      method: "POST", body: proposalBody("docs/competing.md", "# competing\n")
    });
    const stale = staleResponse.data as { changeSetId: string; digest: string; baseRevision: string };
    const competing = competingResponse.data as typeof stale;
    const applied = await request(`/api/changesets/${competing.changeSetId}/confirm-and-apply`, {
      method: "POST", body: { digest: competing.digest, baseRevision: competing.baseRevision }
    });
    const currentRevision = (applied.data as { activeRevision: string }).activeRevision;
    expect((await request(`/api/changesets/${stale.changeSetId}/confirm-and-apply`, {
      method: "POST", body: { digest: stale.digest, baseRevision: stale.baseRevision }
    })).error?.code).toBe("revision_conflict");
    const reproposed = await request(`/api/changesets/${stale.changeSetId}/repropose`, {
      method: "POST", body: { digest: stale.digest, baseRevision: stale.baseRevision }
    });
    expect(reproposed).toMatchObject({ ok: true, data: { status: "proposed", baseRevision: currentRevision } });
    expect((reproposed.data as { changeSetId: string }).changeSetId).not.toBe(stale.changeSetId);
    expect((await request(`/api/projects/${member.projectId}/docs`)).data).toEqual(expect.not.arrayContaining([expect.objectContaining({ path: "docs/stale.md" })]));
  });

  it("rejects untrusted origins and missing tokens", async () => {
    const badOrigin = await fetch(baseUrl + "/api/session", { headers: { Origin: "https://attacker.example" } });
    expect(badOrigin.status).toBe(403);

    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const target = new URL(baseUrl);
      const outbound = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: "/api/session",
        headers: { Origin: "http://127.0.0.1:5173", Host: "attacker.example" }
      }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      outbound.once("error", reject);
      outbound.end();
    });
    expect(badHostStatus).toBe(403);

    const missingToken = await request("/api/workspaces", { token: false });
    expect(missingToken.error?.code).toBe("unauthorized");

    const oversized = await fetch(baseUrl + "/api/workspaces", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:5173", "x-skill-designer-token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) })
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "body_too_large" } });
  });

  it("reports unavailable sandbox capability without claiming Benchmark readiness", async () => {
    const benchmarkCapability = await request("/api/benchmark/capabilities");
    expect(benchmarkCapability.data).toMatchObject({
      ready: false,
      provider: { providerId: "openai-responses", status: "unavailable", keyConfigured: false },
      sandbox: { readyForBenchmark: false },
      blockers: expect.arrayContaining(["服务端未配置 OPENAI_API_KEY", "真实沙箱生命周期自检未通过", "未配置固定 digest 的 runner 镜像"])
    });
    const capability = await request("/api/sandbox/capabilities");
    expect(capability.data).toMatchObject({
      schemaVersion: "1.0",
      platform: "macos",
      status: "unavailable",
      readyForBenchmark: false,
      policy: { network: { mode: "none" }, filesystem: { root: "read-only", hostAccess: "deny" } },
      backends: [
        { backendId: "docker-desktop", status: "unavailable", isolationLevel: "none" },
        { backendId: "native-macos", status: "unsupported", isolationLevel: "none" }
      ]
    });
    expect((await request("/api/sandbox/self-test")).data).toBeNull();
    const selfTest = await request("/api/sandbox/self-test", { method: "POST", body: {} });
    expect(selfTest.data).toMatchObject({
      status: "unavailable",
      reason: "未检测到可用的本机 Docker Desktop",
      checks: [{ id: "docker-cli-daemon", status: "fail", message: "未安装 Docker CLI" }]
    });
    expect((await request("/api/sandbox/self-test")).data).toMatchObject({ selfTestId: (selfTest.data as { selfTestId: string }).selfTestId, status: "unavailable" });
    expect((await request("/api/sandbox/capabilities")).data).toMatchObject({ readyForBenchmark: false, status: "unavailable" });
  });

  it("streams resumable trace pages over an authenticated WebSocket", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "Trace 推送验收" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;
    const workspace = await request(`/api/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: { name: "实时流程", capability: "workflow" }
    });
    const projectId = (workspace.data as { members: Array<{ projectId: string }> }).members[0]!.projectId;
    const started = await request(`/api/projects/${projectId}/runs`, { method: "POST", body: { workspaceId } });
    const runId = (started.data as { run: { runId: string } }).run.runId;
    const messages: Array<{ type: string; data?: { latestSeq: number; events: Array<{ seq: number }>; projection: { currentNodeId: string } } }> = [];
    const socket = new WebSocket(
      `${baseUrl.replace("http:", "ws:")}/api/projects/${projectId}/traces/${runId}/stream?afterSeq=1`,
      ["skill-designer.trace.v1", token],
      { headers: { Origin: "http://127.0.0.1:5173" } }
    );
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    try {
      await waitFor(() => messages.some((message) => message.data?.latestSeq === 2));
      expect(messages[0]).toMatchObject({
        type: "trace.page",
        data: { latestSeq: 2, events: [{ seq: 2 }], projection: { currentNodeId: "flow.start" } }
      });

      await request(`/api/projects/${projectId}/runs/${runId}/next`, {
        method: "POST",
        body: { nextNodeId: "flow.core-step" }
      });
      await waitFor(() => messages.some((message) => message.data?.latestSeq === 3));
      expect(messages.at(-1)).toMatchObject({
        type: "trace.page",
        data: { latestSeq: 3, events: [{ seq: 3 }], projection: { currentNodeId: "flow.core-step" } }
      });
    } finally {
      socket.close(1000);
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    }
  });

  it("recovers a disconnected stream while parallel Skill traces stay isolated", async () => {
    const created = await request("/api/workspaces", { method: "POST", body: { name: "Trace 并行隔离" } });
    const workspaceId = (created.data as { workspaceId: string }).workspaceId;
    const projects: Array<{ projectId: string; skillId: string; runId: string }> = [];
    for (const name of ["Trace Alpha", "Trace Beta", "Trace Gamma"]) {
      const detail = await request(`/api/workspaces/${workspaceId}/members`, { method: "POST", body: { name, capability: "workflow" } });
      const member = (detail.data as { members: Array<{ projectId: string; skillId: string; displayName: string }> }).members.find((item) => item.displayName === name)!;
      const started = await request(`/api/projects/${member.projectId}/runs`, { method: "POST", body: { workspaceId } });
      projects.push({ projectId: member.projectId, skillId: member.skillId, runId: (started.data as { run: { runId: string } }).run.runId });
    }

    const streams = await Promise.all(projects.map((item) => openTraceSocket(item.projectId, item.runId, 2)));
    await Promise.all(streams.map((stream) => waitFor(() => stream.messages.some((message) => message.data?.latestSeq === 2))));
    streams[0]!.socket.terminate();
    await new Promise<void>((resolve) => streams[0]!.socket.once("close", () => resolve()));

    for (let cycle = 0; cycle < 8; cycle++) {
      await Promise.all(projects.map((item) => request(`/api/projects/${item.projectId}/runs/${item.runId}/pause`, { method: "POST", body: {} })));
      await Promise.all(projects.map((item) => request(`/api/projects/${item.projectId}/runs/${item.runId}/resume`, { method: "POST", body: {} })));
    }

    await Promise.all(streams.slice(1).map((stream) => waitFor(() => stream.messages.some((message) => message.data?.latestSeq === 18))));
    const reconnected = await openTraceSocket(projects[0]!.projectId, projects[0]!.runId, 2);
    try {
      await waitFor(() => reconnected.messages.some((message) => message.data?.latestSeq === 18));
      const allStreams = [reconnected, streams[1]!, streams[2]!];
      for (let index = 0; index < allStreams.length; index++) {
        const expected = projects[index]!;
        const delivered = allStreams[index]!.messages.flatMap((message) => message.data?.events ?? []);
        const unique = new Map(delivered.map((event) => [event.seq, event]));
        expect([...unique.keys()].sort((left, right) => left - right)).toEqual(Array.from({ length: 16 }, (_, offset) => offset + 3));
        expect([...unique.values()].every((event) => event.projectId === expected.projectId && event.skillId === expected.skillId && event.runId === expected.runId)).toBe(true);

        const persisted = await request(`/api/projects/${expected.projectId}/traces/${expected.runId}/events?afterSeq=0`);
        expect(persisted.data).toMatchObject({ projectId: expected.projectId, skillId: expected.skillId, traceId: expected.runId, latestSeq: 18, projection: { status: "running", currentNodeId: "flow.start", latestSeq: 18 } });
      }
    } finally {
      for (const stream of [reconnected, streams[1]!, streams[2]!]) {
        stream.socket.close(1000);
        await new Promise<void>((resolve) => stream.socket.once("close", () => resolve()));
      }
    }
  });
});

type TraceSocketMessage = {
  type: string;
  data?: {
    latestSeq: number;
    events: Array<{ seq: number; projectId: string; skillId: string; runId: string }>;
  };
};

async function openTraceSocket(projectId: string, runId: string, afterSeq: number): Promise<{ socket: WebSocket; messages: TraceSocketMessage[] }> {
  const messages: TraceSocketMessage[] = [];
  const socket = new WebSocket(
    `${baseUrl.replace("http:", "ws:")}/api/projects/${projectId}/traces/${runId}/stream?afterSeq=${afterSeq}`,
    ["skill-designer.trace.v1", token],
    { headers: { Origin: "http://127.0.0.1:5173" } }
  );
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as TraceSocketMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, messages };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!await predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("等待 WebSocket 消息超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
