import { describe, expect, it } from "vitest";
import { compareBenchmarkRuns, createBenchmarkCaseFromRuntime, evaluateBenchmarkAssertions, lintBenchmarkCase } from "../src/benchmark.js";
import type { BenchmarkCase, BenchmarkRunRecord, RuntimeTraceEvent, SkillGraph } from "../src/types.js";

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

describe("compareBenchmarkRuns", () => {
  it("aligns assertion identities and exposes path, Trace, Artifact, review, and token changes", () => {
    const before = benchmarkRun("benchmark-run-11111111-1111-4111-8111-111111111111", {
      automaticVerdict: "failed",
      fingerprint: { runtimeArtifactId: "artifact-11111111-1111-4111-8111-111111111111", revision: "rev-before", contentHash: "sha256:before" },
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, cachedInputTokens: 10, reasoningTokens: 5, cacheWriteTokens: 0 },
      modelCallCount: 2,
      events: [
        event(1, "engine.enter", "flow.start"),
        event(2, "engine.enter", "flow.confirm"),
        event(3, "assertion.result"),
        event(4, "benchmark.completed")
      ],
      assertions: [
        { assertionId: "path", kind: "path", status: "fail", message: "路径失败", expected: ["flow.start", "flow.end"], actual: ["flow.start", "flow.confirm"] },
        { assertionId: "terminal", kind: "terminal", status: "pass", message: "终态通过" },
        { assertionId: "obsolete", kind: "variable", status: "fail", message: "旧断言" }
      ],
      humanReviews: [{ reviewId: "review-before", verdict: "failed", note: "需要修复", createdAt: "2026-07-30T00:00:00.000Z" }]
    });
    const after = benchmarkRun("benchmark-run-22222222-2222-4222-8222-222222222222", {
      automaticVerdict: "passed",
      fingerprint: { runtimeArtifactId: "artifact-22222222-2222-4222-8222-222222222222", revision: "rev-after", contentHash: "sha256:after" },
      usage: { inputTokens: 72, outputTokens: 18, totalTokens: 90, cachedInputTokens: 30, reasoningTokens: 3, cacheWriteTokens: 4 },
      modelCallCount: 3,
      events: [
        event(1, "engine.enter", "flow.start"),
        event(2, "engine.enter", "flow.collect"),
        event(3, "engine.enter", "flow.end"),
        event(4, "model.response"),
        event(5, "assertion.result"),
        event(6, "assertion.result"),
        event(7, "benchmark.completed")
      ],
      assertions: [
        { assertionId: "path", kind: "path", status: "pass", message: "路径通过", expected: ["flow.start", "flow.end"], actual: ["flow.start", "flow.collect", "flow.end"] },
        { assertionId: "terminal", kind: "terminal", status: "pass", message: "终态通过" },
        { assertionId: "new-variable", kind: "variable", status: "pass", message: "新增断言" }
      ],
      humanReviews: [{ reviewId: "review-after", verdict: "passed", note: "修复通过", createdAt: "2026-07-30T00:05:00.000Z" }],
      lineage: {
        parentBenchmarkRunId: before.benchmarkRunId,
        relation: "post-repair",
        repairId: "repair-33333333-3333-4333-8333-333333333333",
        changeSetId: "changeset-44444444-4444-4444-8444-444444444444",
        appliedRevision: "rev-after"
      }
    });

    const result = compareBenchmarkRuns(before, after);

    expect(result).toMatchObject({
      relation: "post-repair",
      artifact: { idChanged: true, revisionChanged: true, contentHashChanged: true },
      path: {
        beforeNodeIds: ["flow.start", "flow.confirm"],
        afterNodeIds: ["flow.start", "flow.collect", "flow.end"],
        sharedPrefixNodeIds: ["flow.start"],
        firstDivergence: { index: 1, beforeNodeId: "flow.confirm", afterNodeId: "flow.collect" }
      },
      modelCalls: { before: 2, after: 3, delta: 1 },
      latestHumanVerdicts: { before: "failed", after: "passed" }
    });
    expect(result.assertions).toEqual([
      expect.objectContaining({ assertionId: "new-variable", change: "added", beforeStatus: null, afterStatus: "pass" }),
      expect.objectContaining({ assertionId: "obsolete", change: "removed", beforeStatus: "fail", afterStatus: null }),
      expect.objectContaining({ assertionId: "path", change: "changed", beforeStatus: "fail", afterStatus: "pass" }),
      expect.objectContaining({ assertionId: "terminal", change: "unchanged", beforeStatus: "pass", afterStatus: "pass" })
    ]);
    expect(result.trace.eventTypes).toEqual(expect.arrayContaining([
      { type: "engine.enter", beforeCount: 2, afterCount: 3, delta: 1 },
      { type: "model.response", beforeCount: 0, afterCount: 1, delta: 1 }
    ]));
    expect(result.usage.find((item) => item.metric === "cachedInputTokens")).toEqual({ metric: "cachedInputTokens", before: 10, after: 30, delta: 20 });
  });
});

function benchmarkRun(
  benchmarkRunId: string,
  overrides: Omit<Partial<BenchmarkRunRecord>, "fingerprint"> & { fingerprint?: Partial<BenchmarkRunRecord["fingerprint"]> }
): BenchmarkRunRecord {
  const { fingerprint, ...recordOverrides } = overrides;
  return {
    schemaVersion: "1.0",
    benchmarkRunId,
    workspaceId: "workspace-11111111-1111-4111-8111-111111111111",
    projectId: "project-11111111-1111-4111-8111-111111111111",
    skillId,
    caseId: "case-22222222-2222-4222-8222-222222222222",
    status: "completed",
    automaticVerdict: "passed",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
    modelCallCount: 0,
    sandboxHandleIds: [],
    events: [],
    assertions: [],
    humanReviews: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:05:00.000Z",
    completedAt: "2026-07-30T00:05:00.000Z",
    ...recordOverrides,
    fingerprint: {
      schemaVersion: "1.0",
      providerId: "test-provider",
      requestedModel: "test-model",
      resolvedModels: ["test-model"],
      reasoningEffort: "low",
      promptTemplateVersion: "benchmark-v1",
      runnerImage: "runner@sha256:test",
      sandboxBackendId: "docker-desktop",
      sandboxPolicyHash: "sha256:policy",
      ...fingerprint
    }
  };
}

function event(seq: number, type: BenchmarkRunRecord["events"][number]["type"], nodeId?: string): BenchmarkRunRecord["events"][number] {
  return { seq, at: `2026-07-30T00:00:0${seq}.000Z`, type, ...(nodeId ? { nodeId } : {}), data: {} };
}
