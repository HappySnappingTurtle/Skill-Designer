import { evaluateCondition } from "./condition.js";
import { lintGraph } from "./graph.js";
import type {
  RuntimeCommandResult,
  RuntimeEngineEvent,
  RuntimeEngineState,
  RuntimeConditionEvaluation,
  RuntimeTransition,
  SkillGraph
} from "./types.js";

export class RuntimeEngineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeEngineError";
  }
}

export function createRuntimeState(
  graph: SkillGraph,
  skillVariables: Record<string, unknown> = {}
): { state: RuntimeEngineState; events: RuntimeEngineEvent[] } {
  const lintErrors = lintGraph(graph).filter((issue) => issue.severity === "error");
  if (lintErrors.length) throw new RuntimeEngineError("graph_invalid", "图存在错误，不能启动运行");
  if (graph.capability !== "workflow" || !graph.entry) {
    throw new RuntimeEngineError("workflow_required", "内容型 Skill 没有可执行流程");
  }
  const state: RuntimeEngineState = {
    currentNodeId: graph.entry,
    status: "running",
    step: 0,
    eventSeq: 2,
    visitedNodeIds: [graph.entry],
    skillVariables: structuredClone(skillVariables)
  };
  return {
    state,
    events: [
      { seq: 1, type: "engine.start", nodeId: graph.entry, data: {} },
      { seq: 2, type: "engine.enter", nodeId: graph.entry, data: { step: 0 } }
    ]
  };
}

export function availableTransitions(graph: SkillGraph, state: RuntimeEngineState): RuntimeTransition[] {
  const evaluations = evaluateTransitionConditions(graph, state);
  const allowedEdgeIds = new Set(evaluations.filter((evaluation) => evaluation.result).map((evaluation) => evaluation.edgeId));
  return graph.edges
    .filter((edge) => edge.from === state.currentNodeId && edge.kind !== "knowledge")
    .filter((edge) => !edge.condition || allowedEdgeIds.has(edge.id))
    .map((edge) => ({
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      ...(edge.label ? { label: edge.label } : {})
    }));
}

export function evaluateTransitionConditions(graph: SkillGraph, state: RuntimeEngineState): RuntimeConditionEvaluation[] {
  const variables = {
    skill: state.skillVariables,
    runtime: {
      step: state.step,
      currentNodeId: state.currentNodeId,
      visitedNodeIds: state.visitedNodeIds
    }
  };
  return graph.edges
    .filter((edge) => edge.from === state.currentNodeId && edge.kind !== "knowledge")
    .filter((edge) => Boolean(edge.condition))
    .map((edge) => ({
      edgeId: edge.id,
      to: edge.to,
      conditionOp: edge.condition!.op,
      result: evaluateCondition(edge.condition!, variables)
    }));
}

export function advanceRuntime(
  graph: SkillGraph,
  state: RuntimeEngineState,
  requestedNodeId: string
): RuntimeCommandResult {
  const allowedTransitions = availableTransitions(graph, state);
  if (state.status !== "running") {
    return rejected(state, allowedTransitions, "run_not_active", "运行当前不是可推进状态", requestedNodeId);
  }
  const transition = allowedTransitions.find((item) => item.to === requestedNodeId);
  if (!transition) {
    return rejected(state, allowedTransitions, "next_node_not_allowed", "请求的下一节点不在当前节点合法出口中", requestedNodeId);
  }

  const nextNode = graph.nodes.find((node) => node.id === transition.to);
  if (!nextNode) throw new RuntimeEngineError("target_missing", "合法出口指向不存在的节点");
  const nextState: RuntimeEngineState = {
    ...structuredClone(state),
    currentNodeId: nextNode.id,
    status: nextNode.kind === "end" ? "completed" : "running",
    step: state.step + 1,
    eventSeq: state.eventSeq + (nextNode.kind === "end" ? 2 : 1),
    visitedNodeIds: [...state.visitedNodeIds, nextNode.id]
  };
  const events: RuntimeEngineEvent[] = [
    { seq: state.eventSeq + 1, type: "engine.enter", nodeId: nextNode.id, data: { viaEdgeId: transition.edgeId, step: nextState.step } }
  ];
  if (nextNode.kind === "end") {
    events.push({ seq: state.eventSeq + 2, type: "engine.complete", nodeId: nextNode.id, data: { step: nextState.step } });
  }
  return { accepted: true, state: nextState, allowedTransitions: availableTransitions(graph, nextState), events };
}

export function pauseRuntime(graph: SkillGraph, state: RuntimeEngineState): RuntimeCommandResult {
  if (state.status !== "running") return rejected(state, availableTransitions(graph, state), "run_not_active", "只有运行中的任务可以暂停");
  return statusChange(graph, state, "paused", "engine.pause");
}

export function resumeRuntime(graph: SkillGraph, state: RuntimeEngineState): RuntimeCommandResult {
  if (state.status !== "paused") return rejected(state, availableTransitions(graph, state), "run_not_active", "只有暂停中的任务可以继续");
  return statusChange(graph, state, "running", "engine.resume");
}

export function stopRuntime(graph: SkillGraph, state: RuntimeEngineState): RuntimeCommandResult {
  if (state.status === "completed" || state.status === "stopped") {
    return rejected(state, availableTransitions(graph, state), "run_not_active", "运行已经结束");
  }
  return statusChange(graph, state, "stopped", "engine.stop");
}

function statusChange(
  graph: SkillGraph,
  state: RuntimeEngineState,
  status: RuntimeEngineState["status"],
  type: "engine.pause" | "engine.resume" | "engine.stop"
): RuntimeCommandResult {
  const nextState = { ...structuredClone(state), status, eventSeq: state.eventSeq + 1 };
  return {
    accepted: true,
    state: nextState,
    allowedTransitions: status === "running" ? availableTransitions(graph, nextState) : [],
    events: [{ seq: nextState.eventSeq, type, nodeId: nextState.currentNodeId, data: {} }]
  };
}

function rejected(
  state: RuntimeEngineState,
  allowedTransitions: RuntimeTransition[],
  code: "next_node_not_allowed" | "run_not_active",
  message: string,
  requestedNodeId?: string
): RuntimeCommandResult {
  const nextState = structuredClone(state);
  nextState.eventSeq += 1;
  const event: RuntimeEngineEvent = {
    seq: nextState.eventSeq,
    type: "engine.reject",
    nodeId: state.currentNodeId,
    data: {
      code,
      ...(requestedNodeId ? { requestedNodeId } : {}),
      allowedNodeIds: allowedTransitions.map((item) => item.to)
    }
  };
  return {
    accepted: false,
    state: nextState,
    allowedTransitions,
    events: [event],
    rejection: { code, message, ...(requestedNodeId ? { requestedNodeId } : {}) }
  };
}
