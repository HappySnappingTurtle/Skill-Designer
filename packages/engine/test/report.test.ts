import { describe, expect, it } from "vitest";
import { bugReportMarkdown, createBenchmarkBugReportDocument, createBugReportDocument, diagnoseBugReport, validateBugReportDocument, type BenchmarkRunRecord, type ProjectRun, type RuntimeArtifact, type RuntimeTraceEvent, type SkillGraph } from "../src/index.js";

const graph: SkillGraph = {
  schemaVersion: "1.0",
  skillId: "skill-11111111-1111-4111-8111-111111111111",
  capability: "workflow",
  entry: "flow.start",
  nodes: [
    { id: "flow.start", kind: "start", title: "开始" },
    { id: "flow.end", kind: "end", title: "结束" },
    { id: "flow.unused", kind: "step", title: "未访问" }
  ],
  edges: [{ id: "edge.start-end", from: "flow.start", to: "flow.end", kind: "flow" }]
};

describe("bug report projection", () => {
  it("projects observed graph facts and mandatory-redacts forbidden keys even in off mode", () => {
    const report = createBugReportDocument({
      reportId: "report-11111111-1111-4111-8111-111111111111",
      skillName: "报告 Skill",
      run: run(),
      artifact: artifact(),
      generatedAt: "2026-07-28T00:01:00.000Z",
      sanitizationMode: "off",
      userNote: "token sk-abcdefghijklmnop"
    });
    expect(report.graphProjection.nodes.map((node) => node.id)).toEqual(["flow.start", "flow.end"]);
    expect(report.graphProjection.edges.map((edge) => edge.id)).toEqual(["edge.start-end"]);
    expect(report.symptoms).toEqual([{ code: "transition_rejected", seq: 3, nodeId: "flow.start", requestedNodeId: "flow.unknown" }]);
    expect(report.trace[2]?.data).toMatchObject({ apiKey: "[REDACTED]", requestedNodeId: "flow.unknown" });
    expect(report.userNote).toBe("token [REDACTED]");
    expect(report.sanitization.redactedFieldCount).toBe(2);
    expect(report.runtime.artifactFingerprint).toEqual(artifact().fingerprint);
    const markdown = bugReportMarkdown(report);
    expect(markdown).toContain("# Bug Report：报告 Skill");
    expect(markdown).toContain("## 完整脱敏 JSON");
    expect(markdown).toContain("token [REDACTED]");
    expect(markdown).not.toContain("sk-abcdefghijklmnop");
  });

  it("strict mode retains engine structure while removing user notes and extra data", () => {
    const report = createBugReportDocument({
      reportId: "report-22222222-2222-4222-8222-222222222222",
      skillName: "报告 Skill",
      run: run(),
      artifact: artifact(),
      generatedAt: "2026-07-28T00:01:00.000Z",
      sanitizationMode: "strict",
      userNote: "内部客户资料"
    });
    expect(report.trace[2]?.data).toEqual({ requestedNodeId: "flow.unknown", allowedNodeIds: ["flow.end"] });
    expect(report.userNote).toBe("[已按严格模式移除用户说明]");
    expect(report.sanitization.sanitized).toBe(true);
  });

  it("uses the event registry to retain structural observation fields and strip unknown data by default", () => {
    const observedRun = run();
    const identity = observedRun.events.at(-1)!;
    observedRun.events.push(
      { ...identity, seq: 6, type: "condition.evaluated", actor: "system", data: { evaluations: [{ edgeId: "edge.start-end", to: "flow.end", conditionOp: "boolean", result: false, privateReason: "客户数据" }], allowedNodeIds: [], rawVariables: { secret: "hidden" } } },
      { ...identity, seq: 7, type: "context.queried", actor: "system", data: { queries: [{ queryId: "doc.exact", kind: "document.slice", status: "found", valueCharacters: 120, content: "正文不得导出" }] } },
      { ...identity, seq: 8, type: "future.private-event", actor: "system", data: { content: "不得默认导出" } }
    );
    observedRun.state.eventSeq = 8;
    const report = createBugReportDocument({ reportId: "report-77777777-7777-4777-8777-777777777777", skillName: "报告 Skill", run: observedRun, artifact: artifact(), generatedAt: "2026-07-28T00:01:00.000Z", sanitizationMode: "default" });
    expect(report.trace.at(-3)?.data).toEqual({ evaluations: [{ edgeId: "edge.start-end", to: "flow.end", conditionOp: "boolean", result: false }], allowedNodeIds: [] });
    expect(report.trace.at(-2)?.data).toEqual({ queries: [{ queryId: "doc.exact", kind: "document.slice", status: "found", valueCharacters: 120 }] });
    expect(report.trace.at(-1)?.data).toEqual({});
  });

  it("validates exact identities, strictly increasing seq, and graph endpoints on import", () => {
    const report = createBugReportDocument({
      reportId: "report-33333333-3333-4333-8333-333333333333",
      skillName: "报告 Skill",
      run: run(),
      artifact: artifact(),
      generatedAt: "2026-07-28T00:01:00.000Z",
      sanitizationMode: "default"
    });
    expect(validateBugReportDocument(report)).toEqual([]);
    const invalid = structuredClone(report) as unknown as Record<string, unknown>;
    const trace = invalid.trace as Array<Record<string, unknown>>;
    trace[1]!.seq = 1;
    trace[2]!.skillId = "skill-22222222-2222-4222-8222-222222222222";
    const projectedGraph = invalid.graphProjection as { edges: Array<{ to: string }> };
    projectedGraph.edges[0]!.to = "flow.similar-name";
    expect(validateBugReportDocument(invalid).map((item) => item.code)).toEqual(expect.arrayContaining([
      "trace_seq_invalid", "trace_identity_mismatch", "graph_edge_endpoint_missing"
    ]));
  });

  it("preserves Benchmark identity while diagnosing failed assertions without inventing a root cause", () => {
    const report = createBenchmarkBugReportDocument({
      reportId: "report-44444444-4444-4444-8444-444444444444",
      skillName: "报告 Skill",
      run: benchmarkRun(),
      artifact: artifact(),
      generatedAt: "2026-07-28T00:02:00.000Z",
      sanitizationMode: "default",
      userNote: "模型输出含 sk-abcdefghijklmnop"
    });
    expect(report.source).toMatchObject({
      kind: "benchmark",
      benchmarkRunId: "benchmark-run-44444444-4444-4444-8444-444444444444",
      caseId: "case-44444444-4444-4444-8444-444444444444",
      artifactId: artifact().artifactId,
      revision: artifact().revision
    });
    expect(report.source.runId).toBe("run-44444444-4444-4444-8444-444444444444");
    expect(report.userNote).toBe("模型输出含 [REDACTED]");
    expect(report.symptoms).toEqual([expect.objectContaining({ code: "assertion_failed", assertionId: "assertion-path", assertionKind: "path" })]);
    expect(validateBugReportDocument(report)).toEqual([]);
    const diagnosis = diagnoseBugReport({
      diagnosisId: "diagnosis-44444444-4444-4444-8444-444444444444",
      workspaceId: report.source.workspaceId,
      reportImportId: "report-import-44444444-4444-4444-8444-444444444444",
      report,
      generatedAt: "2026-07-28T00:03:00.000Z"
    });
    expect(diagnosis.candidates).toEqual([expect.objectContaining({ category: "benchmark-assertion", confidence: "high", statement: expect.stringContaining("不直接证明根因") })]);
  });
});

function artifact(): RuntimeArtifact {
  return {
    schemaVersion: "1.0",
    artifactId: "artifact-11111111-1111-4111-8111-111111111111",
    workspaceId: "workspace-11111111-1111-4111-8111-111111111111",
    projectId: "project-11111111-1111-4111-8111-111111111111",
    skillId: graph.skillId,
    revision: "rev-test",
    contentHash: "sha256:test",
    initialVariables: {},
    fingerprint: { schemaVersion: "1.0", algorithm: "sha256", projectContentHash: "sha256:test", inputHash: "sha256:input", value: "sha256:runtime" },
    graph,
    createdAt: "2026-07-28T00:00:00.000Z"
  };
}

function run(): ProjectRun {
  const identity = {
    schemaVersion: "1.0" as const,
    runId: "run-11111111-1111-4111-8111-111111111111",
    workspaceId: "workspace-11111111-1111-4111-8111-111111111111",
    projectId: "project-11111111-1111-4111-8111-111111111111",
    skillId: graph.skillId,
    artifactId: "artifact-11111111-1111-4111-8111-111111111111",
    at: "2026-07-28T00:00:00.000Z",
    actor: "engine" as const
  };
  const events = [
    { ...identity, seq: 1, type: "engine.start", nodeId: "flow.start", data: {} },
    { ...identity, seq: 2, type: "engine.enter", nodeId: "flow.start", data: { step: 0 } },
    { ...identity, seq: 3, type: "engine.reject", nodeId: "flow.start", data: { requestedNodeId: "flow.unknown", allowedNodeIds: ["flow.end"], apiKey: "sk-secret-value" } },
    { ...identity, seq: 4, type: "engine.enter", nodeId: "flow.end", data: { viaEdgeId: "edge.start-end", step: 1 } },
    { ...identity, seq: 5, type: "engine.complete", nodeId: "flow.end", data: { step: 1 } }
  ] as RuntimeTraceEvent[];
  return {
    schemaVersion: "1.0",
    runId: identity.runId,
    workspaceId: identity.workspaceId,
    projectId: identity.projectId,
    skillId: identity.skillId,
    artifactId: identity.artifactId,
    revision: "rev-test",
    state: { currentNodeId: "flow.end", status: "completed", step: 1, eventSeq: 5, visitedNodeIds: ["flow.start", "flow.end"], skillVariables: {} },
    events,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:05.000Z"
  };
}

function benchmarkRun(): BenchmarkRunRecord {
  return {
    schemaVersion: "1.0",
    benchmarkRunId: "benchmark-run-44444444-4444-4444-8444-444444444444",
    workspaceId: artifact().workspaceId,
    projectId: artifact().projectId,
    skillId: artifact().skillId,
    caseId: "case-44444444-4444-4444-8444-444444444444",
    status: "completed",
    automaticVerdict: "failed",
    fingerprint: {
      schemaVersion: "1.0",
      providerId: "openai-responses",
      requestedModel: "gpt-5.6-terra",
      resolvedModels: ["gpt-5.6-terra-2026-07-01"],
      reasoningEffort: "low",
      promptTemplateVersion: "benchmark-decision/1",
      runnerImage: `example/runner@sha256:${"d".repeat(64)}`,
      sandboxBackendId: "docker-desktop",
      sandboxPolicyHash: "sha256:policy",
      runtimeArtifactId: artifact().artifactId,
      revision: artifact().revision,
      contentHash: artifact().contentHash
    },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 2, reasoningTokens: 1, cacheWriteTokens: 0 },
    modelCallCount: 1,
    sandboxHandleIds: ["sandbox-44444444-4444-4444-8444-444444444444"],
    events: [
      { seq: 1, at: "2026-07-28T00:00:00.000Z", type: "benchmark.queued", data: {} },
      { seq: 2, at: "2026-07-28T00:00:01.000Z", type: "engine.start", nodeId: "flow.start", data: {} },
      { seq: 3, at: "2026-07-28T00:00:02.000Z", type: "model.response", nodeId: "flow.start", data: { summary: "sk-abcdefghijklmnop" } },
      { seq: 4, at: "2026-07-28T00:00:03.000Z", type: "assertion.result", data: { assertionId: "assertion-path", kind: "path", status: "fail", message: "路径缺少 flow.end" } },
      { seq: 5, at: "2026-07-28T00:00:04.000Z", type: "benchmark.completed", data: { automaticVerdict: "failed" } }
    ],
    assertions: [{ assertionId: "assertion-path", kind: "path", status: "fail", message: "路径缺少 flow.end", expected: ["flow.start", "flow.end"], actual: ["flow.start"] }],
    humanReviews: [],
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:04.000Z",
    completedAt: "2026-07-28T00:00:04.000Z"
  };
}
