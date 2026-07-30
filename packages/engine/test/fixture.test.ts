import { describe, expect, it } from "vitest";
import {
  createBenchmarkCaseFromReport,
  createBugReportDocument,
  createReportFixture,
  lintBenchmarkCase,
  replayReportFixture
} from "../src/index.js";
import type { ProjectRun, RuntimeArtifact, RuntimeTraceEvent, SkillGraph } from "../src/types.js";

describe("Bug Report conversions", () => {
  it("replays an engine-only fixture deterministically without becoming a Benchmark result", () => {
    const report = createBugReportDocument({
      reportId: "report-11111111-1111-4111-8111-111111111111",
      skillName: "夹具 Skill",
      run: run(),
      artifact: artifact(),
      generatedAt: "2026-07-28T02:00:00.000Z",
      sanitizationMode: "default"
    });
    const fixture = createReportFixture({
      fixtureId: "fixture-11111111-1111-4111-8111-111111111111",
      workspaceId: report.source.workspaceId,
      reportImportId: "report-import-11111111-1111-4111-8111-111111111111",
      report,
      createdAt: "2026-07-28T02:01:00.000Z"
    });
    expect(fixture).toMatchObject({ kind: "engine-regression", benchmarkEligible: false, commands: [{ command: "next", nextNodeId: "flow.unknown" }, { command: "next", nextNodeId: "flow.end" }] });
    expect(replayReportFixture(fixture)).toMatchObject({ matches: true, mismatches: [] });
    fixture.commands[0] = { command: "next", nextNodeId: "flow.other" };
    expect(replayReportFixture(fixture).matches).toBe(false);
  });

  it("creates a traceable draft BenchmarkCase candidate for human completion", () => {
    const report = createBugReportDocument({
      reportId: "report-22222222-2222-4222-8222-222222222222",
      skillName: "候选 Skill",
      run: run(),
      artifact: artifact(),
      generatedAt: "2026-07-28T02:00:00.000Z",
      sanitizationMode: "default"
    });
    const candidate = createBenchmarkCaseFromReport({
      caseId: "case-22222222-2222-4222-8222-222222222222",
      reportImportId: "report-import-22222222-2222-4222-8222-222222222222",
      report
    });
    expect(candidate).toMatchObject({
      status: "draft",
      expected: { path: { mode: "subsequence", nodeIds: ["flow.start", "flow.end"] }, terminal: { status: "completed", nodeId: "flow.end" } },
      source: { kind: "bug-report", reportId: report.reportId, sourceRunId: report.source.runId }
    });
    expect(lintBenchmarkCase(candidate, graph, graph.skillId).filter((issue) => issue.severity === "error")).toEqual([]);
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

function run(): ProjectRun {
  const identity = { schemaVersion: "1.0" as const, runId: "run-11111111-1111-4111-8111-111111111111", workspaceId: "workspace-11111111-1111-4111-8111-111111111111", projectId: "project-11111111-1111-4111-8111-111111111111", skillId: graph.skillId, artifactId: "artifact-11111111-1111-4111-8111-111111111111", at: "2026-07-28T00:00:00.000Z", actor: "engine" as const };
  const events = [
    { ...identity, seq: 1, type: "engine.start", nodeId: "flow.start", data: {} },
    { ...identity, seq: 2, type: "engine.enter", nodeId: "flow.start", data: { step: 0 } },
    { ...identity, seq: 3, type: "engine.reject", nodeId: "flow.start", data: { requestedNodeId: "flow.unknown", allowedNodeIds: ["flow.end"] } },
    { ...identity, seq: 4, type: "engine.enter", nodeId: "flow.end", data: { viaEdgeId: "edge.start-end", step: 1 } },
    { ...identity, seq: 5, type: "engine.complete", nodeId: "flow.end", data: { step: 1 } }
  ] as RuntimeTraceEvent[];
  return { schemaVersion: "1.0", runId: identity.runId, workspaceId: identity.workspaceId, projectId: identity.projectId, skillId: identity.skillId, artifactId: identity.artifactId, revision: "rev-test", state: { currentNodeId: "flow.end", status: "completed", step: 1, eventSeq: 5, visitedNodeIds: ["flow.start", "flow.end"], skillVariables: {} }, events, createdAt: identity.at, updatedAt: identity.at };
}
