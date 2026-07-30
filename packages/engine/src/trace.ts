import type {
  ExecutionTraceEvent,
  ProjectRun,
  SkillGraph,
  TraceNodeState,
  TraceProjection,
  TraceReplayFrame,
  TraceRunComparison
} from "./types.js";
import { isRegisteredTraceEvent, traceEventRegistration } from "./trace-events.js";

const knownEventTypes = new Set([
  "engine.start",
  "engine.enter",
  "engine.reject",
  "engine.pause",
  "engine.resume",
  "engine.stop",
  "engine.complete"
]);

export function reduceTrace(graph: SkillGraph, events: readonly ExecutionTraceEvent[]): TraceProjection {
  const nodeStates: Record<string, TraceNodeState> = Object.fromEntries(graph.nodes.map((node) => [node.id, "unvisited"]));
  const traversedEdgeIds: string[] = [];
  const traversed = new Set<string>();
  const rejectedTransitions: TraceProjection["rejectedTransitions"] = [];
  let status: TraceProjection["status"] = "stopped";
  let currentNodeId: string | null = null;
  let latestSeq = 0;
  let unknownEventCount = 0;
  const missingNodeIds = new Set<string>();

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.seq <= latestSeq) continue;
    latestSeq = event.seq;
    if (!graph.nodes.some((node) => node.id === event.nodeId)) missingNodeIds.add(event.nodeId);
    if (!isRegisteredTraceEvent(event.type)) {
      unknownEventCount++;
      continue;
    }
    if (!knownEventTypes.has(event.type)) continue;
    if (event.type === "engine.start") {
      status = "running";
      currentNodeId = event.nodeId;
      if (nodeStates[event.nodeId]) nodeStates[event.nodeId] = "current";
      continue;
    }
    if (event.type === "engine.enter") {
      if (currentNodeId && currentNodeId !== event.nodeId && nodeStates[currentNodeId]) nodeStates[currentNodeId] = "visited";
      currentNodeId = event.nodeId;
      status = "running";
      if (nodeStates[event.nodeId]) nodeStates[event.nodeId] = "current";
      const viaEdgeId = typeof event.data.viaEdgeId === "string" ? event.data.viaEdgeId : undefined;
      if (viaEdgeId && graph.edges.some((edge) => edge.id === viaEdgeId) && !traversed.has(viaEdgeId)) {
        traversed.add(viaEdgeId);
        traversedEdgeIds.push(viaEdgeId);
      }
      continue;
    }
    if (event.type === "engine.reject") {
      currentNodeId = event.nodeId;
      if (nodeStates[event.nodeId]) nodeStates[event.nodeId] = "rejected";
      rejectedTransitions.push({
        seq: event.seq,
        from: event.nodeId,
        ...(typeof event.data.requestedNodeId === "string" ? { requestedNodeId: event.data.requestedNodeId } : {})
      });
      continue;
    }
    if (event.type === "engine.pause") {
      status = "paused";
      continue;
    }
    if (event.type === "engine.resume") {
      status = "running";
      if (currentNodeId && nodeStates[currentNodeId]) nodeStates[currentNodeId] = "current";
      continue;
    }
    if (event.type === "engine.stop") {
      status = "stopped";
      currentNodeId = event.nodeId;
      if (nodeStates[event.nodeId]) nodeStates[event.nodeId] = "stopped";
      continue;
    }
    status = "completed";
    currentNodeId = event.nodeId;
    if (nodeStates[event.nodeId]) nodeStates[event.nodeId] = "completed";
  }

  return {
    schemaVersion: "1.0",
    latestSeq,
    status,
    currentNodeId,
    nodeStates,
    traversedEdgeIds,
    rejectedTransitions,
    unknownEventCount,
    missingNodeIds: [...missingNodeIds]
  };
}

export function projectTraceAt(
  graph: SkillGraph,
  events: readonly ExecutionTraceEvent[],
  throughSeq: number
): TraceReplayFrame {
  const safeSeq = Number.isFinite(throughSeq) ? Math.max(0, Math.floor(throughSeq)) : 0;
  const visibleEvents = events.filter((event) => event.seq <= safeSeq);
  const ordered = [...visibleEvents].sort((left, right) => left.seq - right.seq);
  return {
    schemaVersion: "1.0",
    throughSeq: safeSeq,
    event: ordered.at(-1) ?? null,
    projection: reduceTrace(graph, ordered)
  };
}

export function compareTraceRuns(left: ProjectRun, right: ProjectRun): TraceRunComparison {
  const leftPath = enteredNodePath(left.events);
  const rightPath = enteredNodePath(right.events);
  const sharedPrefixNodeIds: string[] = [];
  const sharedLength = Math.min(leftPath.length, rightPath.length);
  let divergenceIndex = sharedLength;
  for (let index = 0; index < sharedLength; index++) {
    if (leftPath[index] !== rightPath[index]) {
      divergenceIndex = index;
      break;
    }
    sharedPrefixNodeIds.push(leftPath[index]!);
  }
  const pathsEqual = divergenceIndex === sharedLength && leftPath.length === rightPath.length;
  const leftSnapshot = runSnapshot(left);
  const rightSnapshot = runSnapshot(right);
  return {
    schemaVersion: "1.0",
    leftRunId: left.runId,
    rightRunId: right.runId,
    sameSkill: left.skillId === right.skillId,
    revisionDrift: left.revision !== right.revision,
    artifactDrift: left.artifactId !== right.artifactId,
    leftPathNodeIds: leftPath,
    rightPathNodeIds: rightPath,
    sharedPrefixNodeIds,
    firstPathDivergence: pathsEqual ? null : {
      index: divergenceIndex,
      leftNodeId: leftPath[divergenceIndex] ?? null,
      rightNodeId: rightPath[divergenceIndex] ?? null
    },
    leftSnapshot,
    rightSnapshot,
    variableDifferences: variableDifferences(leftSnapshot.skillVariables, rightSnapshot.skillVariables),
    eventTypeDifferences: eventTypeDifferences(leftSnapshot.eventTypeCounts, rightSnapshot.eventTypeCounts)
  };
}

function runSnapshot(run: ProjectRun): TraceRunComparison["leftSnapshot"] {
  const eventTypeCounts: Record<string, number> = {};
  for (const event of run.events) eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;
  return {
    runId: run.runId,
    status: run.state.status,
    currentNodeId: run.state.currentNodeId,
    step: run.state.step,
    eventSeq: run.state.eventSeq,
    skillVariables: structuredClone(run.state.skillVariables),
    eventTypeCounts
  };
}

function variableDifferences(left: Record<string, unknown>, right: Record<string, unknown>): TraceRunComparison["variableDifferences"] {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((key) => {
    const leftPresent = Object.hasOwn(left, key);
    const rightPresent = Object.hasOwn(right, key);
    if (leftPresent === rightPresent && canonicalValue(left[key]) === canonicalValue(right[key])) return [];
    return [{
      key,
      leftPresent,
      rightPresent,
      ...(leftPresent ? { leftValue: structuredClone(left[key]) } : {}),
      ...(rightPresent ? { rightValue: structuredClone(right[key]) } : {})
    }];
  });
}

function eventTypeDifferences(left: Record<string, number>, right: Record<string, number>): TraceRunComparison["eventTypeDifferences"] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap((type) => {
    const leftCount = left[type] ?? 0;
    const rightCount = right[type] ?? 0;
    return leftCount === rightCount ? [] : [{ type, domain: eventDomain(type), leftCount, rightCount }];
  });
}

function eventDomain(type: string): TraceRunComparison["eventTypeDifferences"][number]["domain"] {
  const registered = traceEventRegistration(type)?.domain;
  if (registered) return registered;
  const domain = type.split(".", 1)[0];
  return domain === "proposal" || domain === "diagnosis" ? domain : "other";
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function enteredNodePath(events: readonly ExecutionTraceEvent[]): string[] {
  let latestSeq = 0;
  const path: string[] = [];
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.seq <= latestSeq) continue;
    latestSeq = event.seq;
    if (event.type === "engine.enter") path.push(event.nodeId);
  }
  return path;
}
