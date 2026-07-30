import { describe, expect, it } from "vitest";
import { createBugReportDocument, diagnoseBugReport } from "../src/index.js";
import type { ProjectRun, RuntimeArtifact, RuntimeTraceEvent, SkillGraph } from "../src/types.js";

describe("evidence-driven diagnosis", () => {
  it("separates a certain rejected-transition fact from uncertain responsibility", () => {
    const report = createBugReportDocument({
      reportId: "report-11111111-1111-4111-8111-111111111111",
      skillName: "诊断 Skill",
      run: runWithReject(),
      artifact: artifact(),
      generatedAt: "2026-07-28T01:00:00.000Z",
      sanitizationMode: "default"
    });
    const diagnosis = diagnoseBugReport({
      diagnosisId: "diagnosis-11111111-1111-4111-8111-111111111111",
      workspaceId: report.source.workspaceId,
      reportImportId: "report-import-11111111-1111-4111-8111-111111111111",
      report,
      generatedAt: "2026-07-28T01:01:00.000Z"
    });
    expect(diagnosis.candidates.map((item) => item.category)).toEqual(["invalid-transition", "graph-reference"]);
    expect(diagnosis.candidates[0]?.evidence).toHaveLength(3);
    expect(diagnosis.candidates[0]?.statement).toContain("提交来源尚未确定");
    expect(diagnosis.limitations).toContain("报告没有 conversation 事件，无法判断提交来自模型、用户还是测试脚本。");
  });

  it("returns insufficient evidence rather than inventing a cause", () => {
    const cleanRun = runWithReject();
    cleanRun.events = cleanRun.events.filter((event) => event.type !== "engine.reject");
    const report = createBugReportDocument({
      reportId: "report-22222222-2222-4222-8222-222222222222",
      skillName: "诊断 Skill",
      run: cleanRun,
      artifact: artifact(),
      generatedAt: "2026-07-28T01:00:00.000Z",
      sanitizationMode: "default"
    });
    const diagnosis = diagnoseBugReport({
      diagnosisId: "diagnosis-22222222-2222-4222-8222-222222222222",
      workspaceId: report.source.workspaceId,
      reportImportId: "report-import-22222222-2222-4222-8222-222222222222",
      report,
      generatedAt: "2026-07-28T01:01:00.000Z"
    });
    expect(diagnosis.candidates).toEqual([expect.objectContaining({ category: "insufficient-evidence", confidence: "low" })]);
  });

  it("offers an edge ChangeSet only when the rejected target already exists in the report graph", () => {
    const existingTargetRun = runWithReject();
    existingTargetRun.events[2]!.data.requestedNodeId = "flow.review";
    const existingTargetArtifact = artifact();
    existingTargetArtifact.graph.nodes.push({ id: "flow.review", kind: "gate", title: "复核" });
    const report = createBugReportDocument({
      reportId: "report-33333333-3333-4333-8333-333333333333",
      skillName: "诊断 Skill",
      run: existingTargetRun,
      artifact: existingTargetArtifact,
      generatedAt: "2026-07-28T01:00:00.000Z",
      sanitizationMode: "default"
    });
    const diagnosis = diagnoseBugReport({
      diagnosisId: "diagnosis-33333333-3333-4333-8333-333333333333",
      workspaceId: report.source.workspaceId,
      reportImportId: "report-import-33333333-3333-4333-8333-333333333333",
      report,
      generatedAt: "2026-07-28T01:01:00.000Z"
    });
    expect(diagnosis.candidates[0]?.repair).toMatchObject({
      kind: "graph.add-edge",
      operation: { op: "graph.edge.create", value: { from: "flow.start", to: "flow.review", kind: "flow" } }
    });
    expect(diagnoseBugReport({
      diagnosisId: "diagnosis-44444444-4444-4444-8444-444444444444",
      workspaceId: report.source.workspaceId,
      reportImportId: "report-import-44444444-4444-4444-8444-444444444444",
      report: createBugReportDocument({ reportId: "report-44444444-4444-4444-8444-444444444444", skillName: "诊断 Skill", run: runWithReject(), artifact: artifact(), generatedAt: "2026-07-28T01:00:00.000Z", sanitizationMode: "default" }),
      generatedAt: "2026-07-28T01:01:00.000Z"
    }).candidates[0]?.repair).toBeUndefined();
  });

  it("groups observed model failures while separating tool and environment evidence", () => {
    const observedRun = runWithReject();
    observedRun.events = observedRun.events.filter((event) => event.type !== "engine.reject");
    const report = createBugReportDocument({
      reportId: "report-55555555-5555-4555-8555-555555555555",
      skillName: "诊断 Skill",
      run: observedRun,
      artifact: artifact(),
      generatedAt: "2026-07-28T01:00:00.000Z",
      sanitizationMode: "off"
    });
    const identity = report.trace.at(-1)!;
    report.trace.push(
      { ...identity, seq: 6, type: "llm.error", actor: "system", data: { category: "protocol", message: "结构化输出无效" } },
      { ...identity, seq: 7, type: "model.error", actor: "model", data: { message: "模型请求失败" } },
      { ...identity, seq: 8, type: "tool.error", actor: "tool", data: { message: "工具退出" } },
      { ...identity, seq: 9, type: "sandbox.timed-out", actor: "sandbox", data: { message: "超过时限" } }
    );
    const diagnosis = diagnoseBugReport({
      diagnosisId: "diagnosis-55555555-5555-4555-8555-555555555555",
      workspaceId: report.source.workspaceId,
      reportImportId: "report-import-55555555-5555-4555-8555-555555555555",
      report,
      generatedAt: "2026-07-28T01:01:00.000Z"
    });
    expect(diagnosis.candidates.map((candidate) => candidate.category)).toEqual(["model-output", "tool-execution", "environment"]);
    expect(diagnosis.candidates[0]).toMatchObject({ evidence: [{ seq: 6 }, { seq: 7 }], verification: { method: "rerun-runtime" } });
    expect(diagnosis.candidates[2]).toMatchObject({ verification: { method: "check-environment" } });
  });

  it("attributes a rejected existing target to a recorded false condition and reports missing document context", () => {
    const conditionArtifact = artifact();
    conditionArtifact.graph.nodes.push({ id: "flow.review", kind: "gate", title: "复核", doc: "docs/review.md", docAnchor: "#复核" });
    conditionArtifact.graph.edges.push({ id: "edge.start-review", from: "flow.start", to: "flow.review", kind: "condition", condition: { op: "boolean", value: false } });
    const conditionRun = runWithReject();
    const identity = conditionRun.events[1]!;
    conditionRun.events = [
      conditionRun.events[0]!, conditionRun.events[1]!,
      { ...identity, seq: 3, type: "condition.evaluated", actor: "system", data: { evaluations: [{ edgeId: "edge.start-review", to: "flow.review", conditionOp: "boolean", result: false }], allowedNodeIds: ["flow.end"] } },
      { ...conditionRun.events[2]!, seq: 4, data: { requestedNodeId: "flow.review", allowedNodeIds: ["flow.end"] } },
      { ...identity, seq: 5, type: "document.context", actor: "system", nodeId: "flow.review", data: { path: "docs/review.md", anchor: "#复核", status: "missing", contentCharacters: 0, truncated: false } }
    ];
    conditionRun.state.eventSeq = 5;
    const report = createBugReportDocument({ reportId: "report-66666666-6666-4666-8666-666666666666", skillName: "诊断 Skill", run: conditionRun, artifact: conditionArtifact, generatedAt: "2026-07-28T01:00:00.000Z", sanitizationMode: "default" });
    const diagnosis = diagnoseBugReport({ diagnosisId: "diagnosis-66666666-6666-4666-8666-666666666666", workspaceId: report.source.workspaceId, reportImportId: "report-import-66666666-6666-4666-8666-666666666666", report, generatedAt: "2026-07-28T01:01:00.000Z" });
    expect(diagnosis.candidates.map((candidate) => candidate.category)).toEqual(["invalid-transition", "condition-evaluation", "document-context"]);
    expect(diagnosis.candidates[1]).toMatchObject({ confidence: "high", evidence: [{ seq: 3 }, { seq: 4 }] });
    expect(diagnosis.candidates[2]).toMatchObject({ evidence: [{ seq: 5, field: "data.status" }] });
  });
});

const graph: SkillGraph = {
  schemaVersion: "1.0",
  skillId: "skill-11111111-1111-4111-8111-111111111111",
  capability: "workflow",
  entry: "flow.start",
  nodes: [{ id: "flow.start", kind: "start", title: "开始" }, { id: "flow.end", kind: "end", title: "完成" }],
  edges: [{ id: "edge.start-end", from: "flow.start", to: "flow.end", kind: "flow" }]
};

function artifact(): RuntimeArtifact {
  return { schemaVersion: "1.0", artifactId: "artifact-11111111-1111-4111-8111-111111111111", workspaceId: "workspace-11111111-1111-4111-8111-111111111111", projectId: "project-11111111-1111-4111-8111-111111111111", skillId: graph.skillId, revision: "rev-test", contentHash: "sha256:test", graph, createdAt: "2026-07-28T00:00:00.000Z" };
}

function runWithReject(): ProjectRun {
  const base = { schemaVersion: "1.0" as const, runId: "run-11111111-1111-4111-8111-111111111111", workspaceId: "workspace-11111111-1111-4111-8111-111111111111", projectId: "project-11111111-1111-4111-8111-111111111111", skillId: graph.skillId, artifactId: "artifact-11111111-1111-4111-8111-111111111111", at: "2026-07-28T00:00:00.000Z", actor: "engine" as const };
  const events = [
    { ...base, seq: 1, type: "engine.start", nodeId: "flow.start", data: {} },
    { ...base, seq: 2, type: "engine.enter", nodeId: "flow.start", data: { step: 0 } },
    { ...base, seq: 3, type: "engine.reject", nodeId: "flow.start", data: { requestedNodeId: "flow.unknown", allowedNodeIds: ["flow.end"] } },
    { ...base, seq: 4, type: "engine.enter", nodeId: "flow.end", data: { viaEdgeId: "edge.start-end", step: 1 } },
    { ...base, seq: 5, type: "engine.complete", nodeId: "flow.end", data: { step: 1 } }
  ] as RuntimeTraceEvent[];
  return { schemaVersion: "1.0", runId: base.runId, workspaceId: base.workspaceId, projectId: base.projectId, skillId: base.skillId, artifactId: base.artifactId, revision: "rev-test", state: { currentNodeId: "flow.end", status: "completed", step: 1, eventSeq: 5, visitedNodeIds: ["flow.start", "flow.end"], skillVariables: {} }, events, createdAt: base.at, updatedAt: base.at };
}
