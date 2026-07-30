import { advanceRuntime, createRuntimeState, pauseRuntime, resumeRuntime, stopRuntime } from "./runtime.js";
import type {
  BugReportDocument,
  ReportFixture,
  ReportFixtureCommand,
  ReportFixtureEventSignature,
  ReportFixtureReplay,
  RuntimeCommandResult,
  RuntimeEngineState,
  RuntimeEngineEvent
} from "./types.js";

export function createReportFixture(input: {
  fixtureId: string;
  workspaceId: string;
  reportImportId: string;
  report: BugReportDocument;
  createdAt: string;
}): ReportFixture {
  return {
    schemaVersion: "1.0",
    fixtureId: input.fixtureId,
    kind: "engine-regression",
    benchmarkEligible: false,
    workspaceId: input.workspaceId,
    reportImportId: input.reportImportId,
    reportId: input.report.reportId,
    skillId: input.report.skill.skillId,
    sourceRunId: input.report.source.benchmarkRunId ?? input.report.source.runId,
    sourceArtifactId: input.report.source.artifactId,
    sourceRevision: input.report.source.revision,
    sourceContentHash: input.report.skill.contentHash,
    graph: structuredClone(input.report.graphProjection),
    initialVariables: {},
    commands: commandsFromTrace(input.report),
    expectedEvents: input.report.trace.filter((event) => event.type.startsWith("engine.")).map(eventSignature),
    limitations: [
      "夹具只重放 Skill Designer 引擎事件，不调用模型、工具或沙箱。",
      "当前 Bug Report 未保存初始变量；依赖初始变量的条件分支可能无法确定性复现。",
      "该夹具仅用于工具内部回归，不计入 Skill Benchmark。"
    ],
    createdAt: input.createdAt
  };
}

export function replayReportFixture(fixture: ReportFixture): ReportFixtureReplay {
  const actual: RuntimeEngineEvent[] = [];
  let state: RuntimeEngineState;
  try {
    const started = createRuntimeState(fixture.graph, fixture.initialVariables);
    state = started.state;
    actual.push(...started.events);
    for (const command of fixture.commands) {
      const result: RuntimeCommandResult = command.command === "next" ? advanceRuntime(fixture.graph, state, command.nextNodeId)
        : command.command === "pause" ? pauseRuntime(fixture.graph, state)
          : command.command === "resume" ? resumeRuntime(fixture.graph, state)
            : stopRuntime(fixture.graph, state);
      state = result.state;
      actual.push(...result.events);
    }
  } catch (error) {
    return { matches: false, actualEvents: actual.map(eventSignature), mismatches: [error instanceof Error ? error.message : "夹具重放失败"] };
  }
  const actualEvents = actual.map(eventSignature);
  const mismatches: string[] = [];
  const length = Math.max(actualEvents.length, fixture.expectedEvents.length);
  for (let index = 0; index < length; index++) {
    const expected = fixture.expectedEvents[index];
    const observed = actualEvents[index];
    if (JSON.stringify(expected) !== JSON.stringify(observed)) {
      mismatches.push(`事件 #${index + 1} 不一致：期望 ${JSON.stringify(expected) ?? "缺失"}，实际 ${JSON.stringify(observed) ?? "缺失"}`);
    }
  }
  return { matches: mismatches.length === 0, actualEvents, mismatches };
}

function commandsFromTrace(report: BugReportDocument): ReportFixtureCommand[] {
  const commands: ReportFixtureCommand[] = [];
  for (const event of report.trace) {
    if (event.type === "engine.reject" && typeof event.data.requestedNodeId === "string") {
      commands.push({ command: "next", nextNodeId: event.data.requestedNodeId });
    } else if (event.type === "engine.enter" && event.seq > 2) {
      commands.push({ command: "next", nextNodeId: event.nodeId });
    } else if (event.type === "engine.pause") commands.push({ command: "pause" });
    else if (event.type === "engine.resume") commands.push({ command: "resume" });
    else if (event.type === "engine.stop") commands.push({ command: "stop" });
  }
  return commands;
}

function eventSignature(event: { type: string; nodeId: string; data: Record<string, unknown> }): ReportFixtureEventSignature {
  return {
    type: event.type,
    nodeId: event.nodeId,
    ...(typeof event.data.requestedNodeId === "string" ? { requestedNodeId: event.data.requestedNodeId } : {}),
    ...(typeof event.data.viaEdgeId === "string" ? { viaEdgeId: event.data.viaEdgeId } : {})
  };
}
