import { describe, expect, it } from "vitest";
import {
  advanceRuntime,
  availableTransitions,
  createRuntimeState,
  evaluateCondition,
  evaluateTransitionConditions,
  lintGraph,
  pauseRuntime,
  compareTraceRuns,
  projectTraceAt,
  reduceTrace,
  resumeRuntime,
  stopRuntime,
  validateCondition,
  type ConditionExpression,
  type RuntimeEngineEvent,
  type RuntimeTraceEvent,
  type SkillGraph
} from "../src/index.js";

const conditionalGraph: SkillGraph = {
  schemaVersion: "1.0",
  skillId: "skill-018f0c4a-7b6d-7a10-8c3f-123456789abc",
  capability: "workflow",
  entry: "flow.start",
  nodes: [
    { id: "flow.start", kind: "start", title: "开始" },
    { id: "flow.review", kind: "decision", title: "检查" },
    { id: "flow.accepted", kind: "end", title: "通过" },
    { id: "flow.rejected", kind: "end", title: "拒绝" }
  ],
  edges: [
    { id: "edge.start-review", from: "flow.start", to: "flow.review", kind: "flow" },
    {
      id: "edge.review-accepted",
      from: "flow.review",
      to: "flow.accepted",
      kind: "condition",
      condition: {
        op: "equals",
        left: { kind: "ref", path: "skill.approved" },
        right: { kind: "literal", value: true }
      }
    },
    {
      id: "edge.review-rejected",
      from: "flow.review",
      to: "flow.rejected",
      kind: "condition",
      condition: {
        op: "notEquals",
        left: { kind: "ref", path: "skill.approved" },
        right: { kind: "literal", value: true }
      }
    }
  ]
};

describe("condition DSL", () => {
  it("evaluates nested field access, contains, not, and/or without code execution", () => {
    const expression: ConditionExpression = {
      op: "and",
      conditions: [
        {
          op: "contains",
          container: { kind: "ref", path: "skill.tags" },
          value: { kind: "literal", value: "ready" }
        },
        { op: "not", condition: { op: "boolean", value: false } }
      ]
    };
    expect(validateCondition(expression)).toEqual([]);
    expect(evaluateCondition(expression, { skill: { tags: ["ready", "review"] }, runtime: {} })).toBe(true);
  });

  it("rejects unsafe prototype references and unknown operators", () => {
    expect(validateCondition({ op: "equals", left: { kind: "ref", path: "skill.__proto__.x" }, right: { kind: "literal", value: 1 } })[0]?.code)
      .toBe("reference_invalid");
    expect(validateCondition({ op: "script", value: "process.exit()" })[0]?.code).toBe("condition_op_unknown");
  });

  it("enforces a closed AST and bounded JSON-safe literals", () => {
    expect(validateCondition({ op: "boolean", value: true, script: "process.exit()" })).toEqual([
      { path: "condition.script", code: "condition_field_unknown", message: "字段 script 不属于该条件结构" }
    ]);
    expect(validateCondition({ op: "equals", left: { kind: "ref", path: "skill.approved", fallback: true }, right: { kind: "literal", value: true } })[0]).toMatchObject({
      path: "condition.left.fallback",
      code: "operand_field_unknown"
    });
    expect(validateCondition({ op: "equals", left: { kind: "literal", value: Number.POSITIVE_INFINITY }, right: { kind: "literal", value: 1 } })[0]?.code)
      .toBe("literal_invalid");
    expect(validateCondition({ op: "contains", container: { kind: "literal", value: Array.from({ length: 101 }, (_, index) => index) }, value: { kind: "literal", value: 1 } })[0]?.code)
      .toBe("literal_list_too_large");
  });

  it("is deterministic and does not mutate either namespace", () => {
    const condition: ConditionExpression = { op: "equals", left: { kind: "ref", path: "runtime.status" }, right: { kind: "literal", value: "running" } };
    const variables = { skill: { approved: true }, runtime: { status: "running" } };
    const before = structuredClone(variables);
    expect(Array.from({ length: 20 }, () => evaluateCondition(condition, variables))).toEqual(Array(20).fill(true));
    expect(variables).toEqual(before);
  });
});

describe("deterministic runtime", () => {
  it("opens only condition-satisfied transitions", () => {
    expect(lintGraph(conditionalGraph)).toEqual([]);
    const { state } = createRuntimeState(conditionalGraph, { approved: true });
    const atReview = advanceRuntime(conditionalGraph, state, "flow.review");
    expect(atReview.accepted).toBe(true);
    expect(availableTransitions(conditionalGraph, atReview.state).map((item) => item.to)).toEqual(["flow.accepted"]);
    expect(evaluateTransitionConditions(conditionalGraph, atReview.state)).toEqual([
      { edgeId: "edge.review-accepted", to: "flow.accepted", conditionOp: "equals", result: true },
      { edgeId: "edge.review-rejected", to: "flow.rejected", conditionOp: "notEquals", result: false }
    ]);
  });

  it("rejects an undeclared next node without moving or incrementing the workflow step", () => {
    const { state } = createRuntimeState(conditionalGraph, { approved: true });
    const atReview = advanceRuntime(conditionalGraph, state, "flow.review");
    const rejected = advanceRuntime(conditionalGraph, atReview.state, "flow.rejected");
    expect(rejected.accepted).toBe(false);
    expect(rejected.rejection?.code).toBe("next_node_not_allowed");
    expect(rejected.state.currentNodeId).toBe("flow.review");
    expect(rejected.state.step).toBe(1);
    expect(rejected.events[0]?.type).toBe("engine.reject");
    expect(rejected.allowedTransitions.map((item) => item.to)).toEqual(["flow.accepted"]);
  });

  it("does not advance while paused and resumes at the same node", () => {
    const { state } = createRuntimeState(conditionalGraph, { approved: false });
    const paused = pauseRuntime(conditionalGraph, state);
    expect(paused.state.status).toBe("paused");
    const blocked = advanceRuntime(conditionalGraph, paused.state, "flow.review");
    expect(blocked.accepted).toBe(false);
    expect(blocked.state.currentNodeId).toBe("flow.start");
    const resumed = resumeRuntime(conditionalGraph, blocked.state);
    expect(resumed.state.status).toBe("running");
    expect(resumed.state.currentNodeId).toBe("flow.start");
  });

  it("stops from running or paused without moving and rejects further commands", () => {
    const { state } = createRuntimeState(conditionalGraph, { approved: true });
    const paused = pauseRuntime(conditionalGraph, state);
    const stopped = stopRuntime(conditionalGraph, paused.state);
    expect(stopped).toMatchObject({
      accepted: true,
      state: { status: "stopped", currentNodeId: "flow.start", step: 0 },
      allowedTransitions: [],
      events: [{ type: "engine.stop", nodeId: "flow.start" }]
    });
    const blocked = advanceRuntime(conditionalGraph, stopped.state, "flow.review");
    expect(blocked).toMatchObject({
      accepted: false,
      state: { status: "stopped", currentNodeId: "flow.start", step: 0 },
      rejection: { code: "run_not_active" }
    });
  });
});

describe("trace projection", () => {
  it("reduces entered nodes, traversed edges, rejection, and completion deterministically", () => {
    const started = createRuntimeState(conditionalGraph, { approved: true });
    const review = advanceRuntime(conditionalGraph, started.state, "flow.review");
    const rejected = advanceRuntime(conditionalGraph, review.state, "flow.rejected");
    const completed = advanceRuntime(conditionalGraph, rejected.state, "flow.accepted");
    const projection = reduceTrace(conditionalGraph, trace([
      ...started.events,
      ...review.events,
      ...rejected.events,
      ...completed.events
    ]));
    expect(projection.status).toBe("completed");
    expect(projection.currentNodeId).toBe("flow.accepted");
    expect(projection.nodeStates).toMatchObject({
      "flow.start": "visited",
      "flow.review": "visited",
      "flow.accepted": "completed",
      "flow.rejected": "unvisited"
    });
    expect(projection.traversedEdgeIds).toEqual(["edge.start-review", "edge.review-accepted"]);
    expect(projection.rejectedTransitions).toEqual([{ seq: 4, from: "flow.review", requestedNodeId: "flow.rejected" }]);
    expect(projection.missingNodeIds).toEqual([]);
  });

  it("ignores duplicate sequence numbers and counts forward-compatible unknown events", () => {
    const started = trace(createRuntimeState(conditionalGraph).events);
    const unknown = { ...started[1]!, seq: 3, type: "provider.future" } as unknown as RuntimeTraceEvent;
    const projection = reduceTrace(conditionalGraph, [...started, started[1]!, unknown]);
    expect(projection.latestSeq).toBe(3);
    expect(projection.unknownEventCount).toBe(1);
    expect(projection.currentNodeId).toBe("flow.start");
  });

  it("recognizes registered observation events without changing graph state", () => {
    const started = trace(createRuntimeState(conditionalGraph).events);
    const condition = { ...started[1]!, seq: 3, type: "condition.evaluated", actor: "system" as const, data: { evaluations: [] } };
    const projection = reduceTrace(conditionalGraph, [...started, condition]);
    expect(projection).toMatchObject({ latestSeq: 3, unknownEventCount: 0, status: "running", currentNodeId: "flow.start" });
  });

  it("projects a deterministic historical frame without mutating the full trace", () => {
    const started = createRuntimeState(conditionalGraph, { approved: true });
    const review = advanceRuntime(conditionalGraph, started.state, "flow.review");
    const completed = advanceRuntime(conditionalGraph, review.state, "flow.accepted");
    const events = trace([...started.events, ...review.events, ...completed.events]);
    const frame = projectTraceAt(conditionalGraph, events, 3);
    expect(frame.event?.type).toBe("engine.enter");
    expect(frame.projection.currentNodeId).toBe("flow.review");
    expect(frame.projection.status).toBe("running");
    expect(frame.projection.traversedEdgeIds).toEqual(["edge.start-review"]);
    expect(events).toHaveLength(5);
  });

  it("finds the first stable-node path divergence separately from artifact drift", () => {
    const started = createRuntimeState(conditionalGraph, { approved: true });
    const review = advanceRuntime(conditionalGraph, started.state, "flow.review");
    const accepted = advanceRuntime(conditionalGraph, review.state, "flow.accepted");
    const rejectedStarted = createRuntimeState(conditionalGraph, { approved: false });
    const rejectedReview = advanceRuntime(conditionalGraph, rejectedStarted.state, "flow.review");
    const rejected = advanceRuntime(conditionalGraph, rejectedReview.state, "flow.rejected");
    const baseRun = run("run-11111111-1111-4111-8111-111111111111", trace([...started.events, ...review.events, ...accepted.events]));
    const otherRun = run("run-22222222-2222-4222-8222-222222222222", trace([...rejectedStarted.events, ...rejectedReview.events, ...rejected.events]));
    baseRun.state = { ...accepted.state, skillVariables: { approved: true, result: { score: 2, label: "ok" } } };
    otherRun.state = { ...rejected.state, skillVariables: { approved: false, result: { label: "ok", score: 2 }, reason: "policy" } };
    baseRun.events.push({ ...baseRun.events.at(-1)!, seq: 6, type: "llm.response", actor: "model" });
    otherRun.events.push(
      { ...otherRun.events.at(-1)!, seq: 6, type: "llm.response", actor: "model" },
      { ...otherRun.events.at(-1)!, seq: 7, type: "tool.error", actor: "tool" }
    );
    baseRun.state.eventSeq = 6;
    otherRun.state.eventSeq = 7;
    const comparison = compareTraceRuns(baseRun, otherRun);
    expect(comparison.leftPathNodeIds).toEqual(["flow.start", "flow.review", "flow.accepted"]);
    expect(comparison.rightPathNodeIds).toEqual(["flow.start", "flow.review", "flow.rejected"]);
    expect(comparison.sharedPrefixNodeIds).toEqual(["flow.start", "flow.review"]);
    expect(comparison.firstPathDivergence).toEqual({ index: 2, leftNodeId: "flow.accepted", rightNodeId: "flow.rejected" });
    expect(comparison.artifactDrift).toBe(true);
    expect(comparison.revisionDrift).toBe(false);
    expect(comparison.variableDifferences).toEqual([
      { key: "approved", leftPresent: true, rightPresent: true, leftValue: true, rightValue: false },
      { key: "reason", leftPresent: false, rightPresent: true, rightValue: "policy" }
    ]);
    expect(comparison.eventTypeDifferences).toEqual([{ type: "tool.error", domain: "tool", leftCount: 0, rightCount: 1 }]);
    expect(comparison.leftSnapshot).toMatchObject({ status: "completed", currentNodeId: "flow.accepted", step: 2, eventSeq: 6, eventTypeCounts: { "llm.response": 1 } });
    expect(comparison.rightSnapshot).toMatchObject({ status: "completed", currentNodeId: "flow.rejected", step: 2, eventSeq: 7, eventTypeCounts: { "tool.error": 1 } });
  });
});

function trace(events: RuntimeEngineEvent[]): RuntimeTraceEvent[] {
  return events.map((event) => ({
    ...event,
    schemaVersion: "1.0",
    runId: "run-11111111-1111-4111-8111-111111111111",
    workspaceId: "workspace-11111111-1111-4111-8111-111111111111",
    projectId: "project-11111111-1111-4111-8111-111111111111",
    skillId: conditionalGraph.skillId,
    artifactId: "artifact-11111111-1111-4111-8111-111111111111",
    at: "2026-07-28T00:00:00.000Z",
    actor: "engine"
  }));
}

function run(runId: string, events: RuntimeTraceEvent[]): import("../src/index.js").ProjectRun {
  return {
    schemaVersion: "1.0",
    runId,
    workspaceId: events[0]!.workspaceId,
    projectId: events[0]!.projectId,
    skillId: events[0]!.skillId,
    artifactId: `artifact-${runId.slice(4)}`,
    revision: "rev-same",
    state: createRuntimeState(conditionalGraph).state,
    events: events.map((event) => ({ ...event, runId, artifactId: `artifact-${runId.slice(4)}` })),
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:01.000Z"
  };
}
