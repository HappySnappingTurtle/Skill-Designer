import { describe, expect, it } from "vitest";
import { createBenchmarkCaseFromRuntime, evaluateBenchmarkAssertions, lintBenchmarkCase } from "../src/benchmark.js";
import type { BenchmarkCase, RuntimeTraceEvent, SkillGraph } from "../src/types.js";

const skillId = "skill-11111111-1111-4111-8111-111111111111";
const graph: SkillGraph = {
  schemaVersion: "1.0",
  skillId,
  capability: "workflow",
  entry: "flow.start",
  nodes: [
    { id: "flow.start", kind: "start", title: "开始" },
    { id: "flow.collect", kind: "step", title: "收集" },
    { id: "flow.confirm", kind: "gate", title: "确认" },
    { id: "flow.end", kind: "end", title: "完成" }
  ],
  edges: [
    { id: "edge.start-collect", from: "flow.start", to: "flow.collect", kind: "flow" },
    { id: "edge.collect-confirm", from: "flow.collect", to: "flow.confirm", kind: "flow" },
    { id: "edge.confirm-end", from: "flow.confirm", to: "flow.end", kind: "flow" }
  ]
};

function benchmarkCase(overrides: Partial<BenchmarkCase> = {}): BenchmarkCase {
  return {
    schemaVersion: "1.0",
    caseId: "case-22222222-2222-4222-8222-222222222222",
    skillId,
    title: "完整需求确认",
    status: "ready",
    intent: "收集需求并由用户确认",
    fixture: { initialVariables: {}, userReplies: [{ nodeId: "flow.confirm", message: "确认" }] },
    expected: {
      path: { mode: "subsequence", nodeIds: ["flow.start", "flow.confirm", "flow.end"] },
      terminal: { status: "completed", nodeId: "flow.end" },
      variables: {},
      artifacts: [],
      toolResults: [],
      forbiddenEffects: []
    },
    tags: ["smoke"],
    ...overrides
  };
}

describe("lintBenchmarkCase", () => {
  it("accepts a ready subsequence case with a scripted gate reply", () => {
    expect(lintBenchmarkCase(benchmarkCase(), graph, skillId)).toEqual([]);
  });

  it("rejects an exact path that skips a required node", () => {
    const value = benchmarkCase();
    value.expected.path = { mode: "exact", nodeIds: ["flow.start", "flow.confirm", "flow.end"] };
    expect(lintBenchmarkCase(value, graph, skillId)).toContainEqual(expect.objectContaining({
      severity: "error",
      code: "impossible_path",
      path: "expected.path.nodeIds[1]"
    }));
  });

  it("warns instead of claiming passability when gate replies are missing", () => {
    const value = benchmarkCase();
    value.fixture.userReplies = [];
    expect(lintBenchmarkCase(value, graph, skillId)).toContainEqual(expect.objectContaining({
      severity: "warning",
      code: "fixture_incomplete"
    }));
  });

  it("requires an assertion before a case can become ready", () => {
    const value = benchmarkCase();
    value.expected = {
      path: { mode: "subsequence", nodeIds: [] },
      variables: {},
      artifacts: [],
      toolResults: [],
      forbiddenEffects: []
    };
    expect(lintBenchmarkCase(value, graph, skillId)).toContainEqual(expect.objectContaining({
      severity: "error",
      code: "expectation_required"
    }));
  });
});

describe("createBenchmarkCaseFromRuntime", () => {
  it("copies observed facts into an editable draft without persisting Studio identities", () => {
    const identity = {
      schemaVersion: "1.0" as const,
      runId: "run-33333333-3333-4333-8333-333333333333",
      workspaceId: "workspace-44444444-4444-4444-8444-444444444444",
      projectId: "project-55555555-5555-4555-8555-555555555555",
      skillId,
      artifactId: "artifact-66666666-6666-4666-8666-666666666666",
      at: "2026-07-29T10:00:00.000Z",
      actor: "engine" as const,
      data: {}
    };
    const trace: RuntimeTraceEvent[] = [
      { ...identity, seq: 1, type: "engine.enter", nodeId: "flow.start" },
      { ...identity, seq: 2, type: "engine.enter", nodeId: "flow.collect" },
      { ...identity, seq: 3, type: "engine.enter", nodeId: "flow.end" }
    ];
    const result = createBenchmarkCaseFromRuntime({
      caseId: "case-77777777-7777-4777-8777-777777777777",
      skillId,
      skillName: "需求助手",
      initialVariables: { requestId: "r-1" },
      finalVariables: { requestId: "r-1", result: "done" },
      status: "completed",
      currentNodeId: "flow.end",
      trace
    });

    expect(result).toMatchObject({
      status: "draft",
      fixture: { initialVariables: { requestId: "r-1" }, userReplies: [] },
      expected: {
        path: { mode: "subsequence", nodeIds: ["flow.start", "flow.collect", "flow.end"] },
        terminal: { status: "completed", nodeId: "flow.end" },
        variables: { requestId: "r-1", result: "done" }
      },
      tags: ["runtime-trace", "candidate"]
    });
    expect(result).not.toHaveProperty("source");
    expect(result.notes).toContain("不等于正确期望");
  });
});

describe("evaluateBenchmarkAssertions", () => {
  it("evaluates every assertion kind and keeps artifact text out of persisted evidence", () => {
    const value = benchmarkCase();
    value.expected = {
      path: { mode: "exact", nodeIds: ["flow.start", "flow.end"] },
      terminal: { status: "completed", nodeId: "flow.end" },
      variables: { result: "ok" },
      artifacts: [{ path: "result.txt", exists: true, contains: "done" }],
      toolResults: [{ tool: "build", field: "exitCode", equals: 0 }],
      forbiddenEffects: ["network-access"]
    };
    const result = evaluateBenchmarkAssertions(value, {
      visitedNodeIds: ["flow.start", "flow.end"],
      terminal: { status: "completed", nodeId: "flow.end" },
      variables: { result: "ok" },
      artifacts: [{ path: "result.txt", size: 5, sha256: `sha256:${"a".repeat(64)}`, text: "done\n" }],
      toolResults: [{ tool: "build", result: { exitCode: 0 } }],
      observedEffects: []
    });
    expect(result.verdict).toBe("passed");
    expect(result.assertions).toHaveLength(6);
    expect(result.assertions.every((assertion) => assertion.status === "pass")).toBe(true);
    expect(result.assertions.find((assertion) => assertion.kind === "artifact")?.actual).not.toHaveProperty("text");
  });
});
