import { reduceTrace } from "./trace.js";
import { traceEventRegistration } from "./trace-events.js";
import type {
  BugReportDocument,
  BugReportSanitizationMode,
  BugReportSymptom,
  BugReportValidationIssue,
  BenchmarkRunRecord,
  ExecutionTraceEvent,
  ProjectRun,
  RuntimeArtifact,
  RuntimeTraceEvent,
  SkillGraph
} from "./types.js";

export function bugReportMarkdown(report: BugReportDocument): string {
  const symptomRows = report.symptoms.length
    ? report.symptoms.map((symptom) => `| ${symptom.seq} | ${cell(symptom.code)} | ${cell(symptom.nodeId)} | ${cell(symptom.requestedNodeId ?? "-")} |`).join("\n")
    : "| - | 无事实症状 | - | - |";
  const traceRows = report.trace.map((event) => `| ${event.seq} | ${cell(event.type)} | ${cell(event.nodeId)} | ${cell(event.actor)} |`).join("\n");
  return [
    `# Bug Report：${plain(report.skill.name)}`,
    "",
    `- 报告 ID：\`${report.reportId}\``,
    `- Skill ID：\`${report.skill.skillId}\``,
    `- 内容 Hash：\`${report.skill.contentHash}\``,
    `- 来源：\`${report.source.kind ?? "runtime"}\` / \`${report.source.runId}\``,
    `- Revision：\`${report.source.revision}\``,
    `- 运行状态：\`${report.runtime.status}\``,
    `- RuntimeArtifact 指纹：\`${report.runtime.artifactFingerprint?.value ?? "未记录"}\``,
    ...(report.runtime.benchmarkFingerprint ? [
      `- Provider / 模型：\`${report.runtime.benchmarkFingerprint.providerId}\` / \`${report.runtime.benchmarkFingerprint.requestedModel}\``,
      `- 沙箱策略：\`${report.runtime.benchmarkFingerprint.sandboxPolicyHash}\``
    ] : []),
    `- 生成时间：\`${report.generatedAt}\``,
    `- 脱敏：\`${report.sanitization.mode}\`（${report.sanitization.redactedFieldCount} 个字段）`,
    "",
    "## 覆盖范围",
    "",
    `- 引擎：${yesNo(report.coverage.engine)}`,
    `- 对话：${yesNo(report.coverage.conversation)}`,
    `- 工具：${yesNo(report.coverage.tools)}`,
    `- 外部 Agent 可能绕过：${yesNo(report.coverage.externalAgentMayBypass)}`,
    "",
    "## 事实症状",
    "",
    "| Seq | 代码 | 节点 | 提交目标节点 |",
    "| ---: | --- | --- | --- |",
    symptomRows,
    "",
    "## Trace 事件",
    "",
    "| Seq | 类型 | 节点 | Actor |",
    "| ---: | --- | --- | --- |",
    traceRows || "| - | 无事件 | - | - |",
    "",
    "## 用户说明",
    "",
    fenced("text", report.userNote || "（空）"),
    "",
    "## 完整脱敏 JSON",
    "",
    fenced("json", JSON.stringify(report, null, 2)),
    ""
  ].join("\n");
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function plain(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/#/g, "\\#");
}

function yesNo(value: boolean): string {
  return value ? "是" : "否";
}

function fenced(language: string, value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

const forbiddenKey = /(api[-_]?key|authorization|cookie|password|secret|session[-_]?token|access[-_]?token|refresh[-_]?token|private[-_]?key)/iu;

export function createBugReportDocument(input: {
  reportId: string;
  skillName: string;
  run: ProjectRun;
  artifact: RuntimeArtifact;
  generatedAt: string;
  sanitizationMode: BugReportSanitizationMode;
  userNote?: string;
}): BugReportDocument {
  const { run, artifact, sanitizationMode } = input;
  if (run.artifactId !== artifact.artifactId || run.skillId !== artifact.skillId || run.projectId !== artifact.projectId) {
    throw new Error("运行与 RuntimeArtifact 身份不一致");
  }
  let redactedFieldCount = 0;
  const trace = run.events.map((event) => ({
    ...event,
    data: sanitizeEventData(event.data, sanitizationMode, event.type, () => redactedFieldCount++)
  }));
  const rawNote = input.userNote?.trim() ?? "";
  const userNote = sanitizationMode === "strict" && rawNote
    ? (redactedFieldCount++, "[已按严格模式移除用户说明]")
    : sanitizeText(rawNote, () => redactedFieldCount++);
  return {
    reportVersion: "1.0",
    reportId: input.reportId,
    generatedAt: input.generatedAt,
    skill: { skillId: run.skillId, name: input.skillName, contentHash: artifact.contentHash },
    source: {
      kind: "runtime",
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      runId: run.runId,
      artifactId: run.artifactId,
      revision: run.revision
    },
    runtime: { status: run.state.status, createdAt: run.createdAt, updatedAt: run.updatedAt, artifactFingerprint: artifact.fingerprint },
    coverage: {
      engine: true,
      conversation: run.events.some((event) => event.type.startsWith("conversation.")),
      tools: run.events.some((event) => event.type.startsWith("tool.")),
      externalAgentMayBypass: true
    },
    trace,
    graphProjection: projectReportGraph(artifact.graph, run.events),
    symptoms: extractSymptoms(run.events),
    userNote,
    sanitization: { mode: sanitizationMode, sanitized: redactedFieldCount > 0 || sanitizationMode !== "off", redactedFieldCount }
  };
}

export function createBenchmarkBugReportDocument(input: {
  reportId: string;
  skillName: string;
  run: BenchmarkRunRecord;
  artifact: RuntimeArtifact;
  generatedAt: string;
  sanitizationMode: BugReportSanitizationMode;
  userNote?: string;
}): BugReportDocument {
  const { run, artifact, sanitizationMode } = input;
  if (run.fingerprint.runtimeArtifactId !== artifact.artifactId || run.skillId !== artifact.skillId || run.projectId !== artifact.projectId || run.fingerprint.revision !== artifact.revision) {
    throw new Error("Benchmark 与 RuntimeArtifact 身份不一致");
  }
  if (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") throw new Error("Benchmark 尚未形成可报告的终态");
  const traceRunId = `run-${run.benchmarkRunId.slice("benchmark-run-".length)}`;
  const fallbackNodeId = artifact.graph.entry ?? artifact.graph.nodes[0]?.id;
  if (!fallbackNodeId) throw new Error("Benchmark 图没有可用于报告的节点");
  let redactedFieldCount = 0;
  const trace: ExecutionTraceEvent[] = run.events.map((event) => ({
    schemaVersion: "1.0",
    seq: event.seq,
    type: event.type,
    nodeId: event.nodeId ?? fallbackNodeId,
    data: sanitizeEventData(event.data, sanitizationMode, event.type, () => redactedFieldCount++),
    runId: traceRunId,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    skillId: run.skillId,
    artifactId: artifact.artifactId,
    at: event.at,
    actor: benchmarkActor(event.type)
  }));
  const rawNote = input.userNote?.trim() ?? "";
  const userNote = sanitizationMode === "strict" && rawNote
    ? (redactedFieldCount++, "[已按严格模式移除用户说明]")
    : sanitizeText(rawNote, () => redactedFieldCount++);
  return {
    reportVersion: "1.0",
    reportId: input.reportId,
    generatedAt: input.generatedAt,
    skill: { skillId: run.skillId, name: input.skillName, contentHash: artifact.contentHash },
    source: {
      kind: "benchmark",
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      runId: traceRunId,
      benchmarkRunId: run.benchmarkRunId,
      caseId: run.caseId,
      artifactId: artifact.artifactId,
      revision: artifact.revision
    },
    runtime: {
      status: run.status,
      automaticVerdict: run.automaticVerdict,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      artifactFingerprint: artifact.fingerprint,
      benchmarkFingerprint: run.fingerprint
    },
    coverage: {
      engine: trace.some((event) => event.type.startsWith("engine.")),
      conversation: trace.some((event) => event.type.startsWith("model.")),
      tools: trace.some((event) => event.type.startsWith("tool.") || event.type.startsWith("sandbox.")),
      externalAgentMayBypass: false
    },
    trace,
    graphProjection: projectReportGraph(artifact.graph, trace),
    symptoms: [...extractSymptoms(trace), ...benchmarkSymptoms(run, fallbackNodeId)],
    userNote,
    sanitization: { mode: sanitizationMode, sanitized: redactedFieldCount > 0 || sanitizationMode !== "off", redactedFieldCount }
  };
}

function projectReportGraph(graph: SkillGraph, events: readonly ExecutionTraceEvent[]): SkillGraph {
  const projection = reduceTrace(graph, events);
  const includedNodeIds = new Set(Object.entries(projection.nodeStates)
    .filter(([, state]) => state !== "unvisited")
    .map(([nodeId]) => nodeId));
  for (const rejection of projection.rejectedTransitions) {
    includedNodeIds.add(rejection.from);
    if (rejection.requestedNodeId && graph.nodes.some((node) => node.id === rejection.requestedNodeId)) {
      includedNodeIds.add(rejection.requestedNodeId);
    }
  }
  const traversed = new Set(projection.traversedEdgeIds);
  const edges = graph.edges.filter((edge) => traversed.has(edge.id) || (
    includedNodeIds.has(edge.from) && includedNodeIds.has(edge.to)
  ));
  for (const edge of edges) {
    includedNodeIds.add(edge.from);
    includedNodeIds.add(edge.to);
  }
  return {
    schemaVersion: "1.0",
    skillId: graph.skillId,
    capability: graph.capability,
    ...(graph.entry && includedNodeIds.has(graph.entry) ? { entry: graph.entry } : {}),
    nodes: graph.nodes.filter((node) => includedNodeIds.has(node.id)).map((node) => structuredClone(node)),
    edges: edges.map((edge) => structuredClone(edge))
  };
}

function benchmarkSymptoms(run: BenchmarkRunRecord, fallbackNodeId: string): BugReportSymptom[] {
  const symptoms: BugReportSymptom[] = [];
  for (const assertion of run.assertions) {
    if (assertion.status === "pass") continue;
    const event = run.events.find((item) => item.type === "assertion.result" && item.data.assertionId === assertion.assertionId);
    symptoms.push({
      code: assertion.status === "fail" ? "assertion_failed" : "assertion_inconclusive",
      seq: event?.seq ?? run.events.at(-1)?.seq ?? 1,
      nodeId: event?.nodeId ?? fallbackNodeId,
      assertionId: assertion.assertionId,
      assertionKind: assertion.kind
    });
  }
  if (run.status === "failed" && run.failure) {
    const event = [...run.events].reverse().find((item) => item.type === "benchmark.failed");
    symptoms.push({ code: "benchmark_failed", seq: event?.seq ?? run.events.at(-1)?.seq ?? 1, nodeId: event?.nodeId ?? fallbackNodeId, failureCategory: run.failure.category });
  }
  return symptoms;
}

function benchmarkActor(type: string): ExecutionTraceEvent["actor"] {
  if (type.startsWith("engine.")) return "engine";
  if (type.startsWith("model.")) return "model";
  if (type.startsWith("tool.")) return "tool";
  if (type.startsWith("sandbox.")) return "sandbox";
  if (type.startsWith("review.")) return "user";
  return "system";
}

function extractSymptoms(events: readonly ExecutionTraceEvent[]): BugReportSymptom[] {
  const symptoms: BugReportSymptom[] = [];
  for (const event of events) {
    if (event.type === "engine.reject") symptoms.push({
      code: "transition_rejected" as const,
      seq: event.seq,
      nodeId: event.nodeId,
      ...(typeof event.data.requestedNodeId === "string" ? { requestedNodeId: event.data.requestedNodeId } : {})
    });
    else if (event.type === "engine.stop") symptoms.push({ code: "run_stopped", seq: event.seq, nodeId: event.nodeId });
  }
  return symptoms;
}

function sanitizeEventData(
  data: Record<string, unknown>,
  mode: BugReportSanitizationMode,
  eventType: string,
  onRedact: () => void
): Record<string, unknown> {
  const registration = traceEventRegistration(eventType);
  const structuralFields = new Set(registration?.structuralFields ?? []);
  const effectiveMode = mode === "off" ? "off" : "strict";
  const value = sanitizeValue(data, effectiveMode, onRedact, "", structuralFields);
  return isRecord(value) ? value : {};
}

function sanitizeValue(value: unknown, mode: BugReportSanitizationMode, onRedact: () => void, key = "", structuralFields: ReadonlySet<string> = new Set()): unknown {
  if (key && forbiddenKey.test(key)) {
    onRedact();
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, mode, onRedact, "", structuralFields));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) => {
      if (mode === "strict" && !structuralFields.has(childKey)) {
        onRedact();
        return [];
      }
      return [[childKey, sanitizeValue(childValue, mode, onRedact, childKey, structuralFields)]];
    }));
  }
  if (typeof value === "string") return sanitizeText(value, onRedact);
  return value;
}

function sanitizeText(value: string, onRedact: () => void): string {
  const patterns = [
    /\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/gu,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/giu
  ];
  return patterns.reduce((result, pattern) => result.replace(pattern, () => {
    onRedact();
    return "[REDACTED]";
  }), value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateBugReportDocument(value: unknown): BugReportValidationIssue[] {
  const issues: BugReportValidationIssue[] = [];
  if (!isRecord(value)) return [{ code: "report_object_required", path: "$", message: "报告必须是 JSON 对象" }];
  if (value.reportVersion !== "1.0") issue(issues, "report_version_unsupported", "reportVersion", "只支持 reportVersion 1.0");
  if (!validId(value.reportId, "report")) issue(issues, "report_id_invalid", "reportId", "reportId 无效");
  const skill = isRecord(value.skill) ? value.skill : null;
  const source = isRecord(value.source) ? value.source : null;
  const runtime = isRecord(value.runtime) ? value.runtime : null;
  const graph = isRecord(value.graphProjection) ? value.graphProjection : null;
  if (!skill) issue(issues, "skill_required", "skill", "缺少 Skill 身份");
  if (!source) issue(issues, "source_required", "source", "缺少来源运行身份");
  if (!runtime) issue(issues, "runtime_required", "runtime", "缺少运行事实");
  if (!graph) issue(issues, "graph_required", "graphProjection", "缺少自包含图投影");
  const skillId = typeof skill?.skillId === "string" ? skill.skillId : "";
  if (!validId(skillId, "skill")) issue(issues, "skill_id_invalid", "skill.skillId", "skillId 无效");
  if (typeof skill?.name !== "string" || !skill.name.trim()) issue(issues, "skill_name_required", "skill.name", "Skill 名称缺失");
  if (typeof skill?.contentHash !== "string" || !skill.contentHash.startsWith("sha256:")) issue(issues, "content_hash_invalid", "skill.contentHash", "contentHash 无效");
  const identities = [
    ["workspaceId", "workspace"], ["projectId", "project"], ["runId", "run"], ["artifactId", "artifact"]
  ] as const;
  for (const [field, prefix] of identities) {
    if (!validId(source?.[field], prefix)) issue(issues, "source_id_invalid", `source.${field}`, `${field} 无效`);
  }
  if (source?.kind !== undefined && source.kind !== "runtime" && source.kind !== "benchmark") issue(issues, "source_kind_invalid", "source.kind", "报告来源类型无效");
  if (source?.kind === "benchmark") {
    if (typeof source.benchmarkRunId !== "string" || !/^benchmark-run-[0-9a-f-]{36}$/iu.test(source.benchmarkRunId)) issue(issues, "benchmark_run_id_invalid", "source.benchmarkRunId", "benchmarkRunId 无效");
    if (typeof source.caseId !== "string" || !/^case-[0-9a-f-]{36}$/iu.test(source.caseId)) issue(issues, "benchmark_case_id_invalid", "source.caseId", "Benchmark caseId 无效");
  }
  if (typeof source?.revision !== "string" || !source.revision) issue(issues, "revision_required", "source.revision", "revision 缺失");
  const artifactFingerprint = isRecord(runtime?.artifactFingerprint) ? runtime.artifactFingerprint : null;
  if (runtime?.artifactFingerprint !== undefined && !artifactFingerprint) {
    issue(issues, "artifact_fingerprint_invalid", "runtime.artifactFingerprint", "RuntimeArtifact 指纹无效");
  } else if (artifactFingerprint) {
    if (artifactFingerprint.schemaVersion !== "1.0" || artifactFingerprint.algorithm !== "sha256") issue(issues, "artifact_fingerprint_invalid", "runtime.artifactFingerprint", "RuntimeArtifact 指纹版本或算法无效");
    for (const field of ["projectContentHash", "inputHash", "value"] as const) {
      if (typeof artifactFingerprint[field] !== "string" || !artifactFingerprint[field]) issue(issues, "artifact_fingerprint_invalid", `runtime.artifactFingerprint.${field}`, `${field} 缺失`);
    }
    if (artifactFingerprint.projectContentHash !== skill?.contentHash) issue(issues, "artifact_fingerprint_content_mismatch", "runtime.artifactFingerprint.projectContentHash", "RuntimeArtifact 指纹与 Skill contentHash 不一致");
  }
  const benchmarkFingerprint = isRecord(runtime?.benchmarkFingerprint) ? runtime.benchmarkFingerprint : null;
  if (runtime?.benchmarkFingerprint !== undefined && !benchmarkFingerprint) {
    issue(issues, "benchmark_fingerprint_invalid", "runtime.benchmarkFingerprint", "Benchmark 执行指纹无效");
  } else if (benchmarkFingerprint) {
    if (benchmarkFingerprint.schemaVersion !== "1.0") issue(issues, "benchmark_fingerprint_invalid", "runtime.benchmarkFingerprint.schemaVersion", "Benchmark 指纹版本无效");
    for (const field of ["providerId", "requestedModel", "promptTemplateVersion", "runnerImage", "sandboxBackendId", "sandboxPolicyHash"] as const) {
      if (typeof benchmarkFingerprint[field] !== "string" || !benchmarkFingerprint[field]) issue(issues, "benchmark_fingerprint_invalid", `runtime.benchmarkFingerprint.${field}`, `${field} 缺失`);
    }
    if (!Array.isArray(benchmarkFingerprint.resolvedModels) || benchmarkFingerprint.resolvedModels.some((model) => typeof model !== "string" || !model)) issue(issues, "benchmark_fingerprint_invalid", "runtime.benchmarkFingerprint.resolvedModels", "resolvedModels 无效");
    if (!["none", "low", "medium", "high", "xhigh", "max"].includes(String(benchmarkFingerprint.reasoningEffort))) issue(issues, "benchmark_fingerprint_invalid", "runtime.benchmarkFingerprint.reasoningEffort", "reasoningEffort 无效");
    if (benchmarkFingerprint.sandboxBackendId !== "docker-desktop") issue(issues, "benchmark_fingerprint_invalid", "runtime.benchmarkFingerprint.sandboxBackendId", "sandboxBackendId 无效");
    if (benchmarkFingerprint.runtimeArtifactId !== source?.artifactId || benchmarkFingerprint.revision !== source?.revision || benchmarkFingerprint.contentHash !== skill?.contentHash) {
      issue(issues, "benchmark_fingerprint_identity_mismatch", "runtime.benchmarkFingerprint", "Benchmark 指纹与报告来源身份不一致");
    }
  }
  if (graph?.skillId !== skillId) issue(issues, "graph_skill_mismatch", "graphProjection.skillId", "图投影与报告 skillId 不一致");
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  if (!Array.isArray(graph?.nodes)) issue(issues, "graph_nodes_required", "graphProjection.nodes", "图节点必须是数组");
  if (!Array.isArray(graph?.edges)) issue(issues, "graph_edges_required", "graphProjection.edges", "图边必须是数组");
  const nodeIds = new Set<string>();
  nodes.forEach((node, index) => {
    if (!isRecord(node) || typeof node.id !== "string" || !node.id) issue(issues, "graph_node_invalid", `graphProjection.nodes[${index}]`, "图节点无效");
    else if (nodeIds.has(node.id)) issue(issues, "graph_node_duplicate", `graphProjection.nodes[${index}].id`, "图节点 ID 重复");
    else nodeIds.add(node.id);
  });
  edges.forEach((edge, index) => {
    if (!isRecord(edge) || typeof edge.id !== "string" || typeof edge.from !== "string" || typeof edge.to !== "string") {
      issue(issues, "graph_edge_invalid", `graphProjection.edges[${index}]`, "图边无效");
    } else if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      issue(issues, "graph_edge_endpoint_missing", `graphProjection.edges[${index}]`, "图边引用缺失节点");
    }
  });
  const trace = Array.isArray(value.trace) ? value.trace : [];
  if (!Array.isArray(value.trace)) issue(issues, "trace_required", "trace", "Trace 必须是数组");
  let previousSeq = 0;
  trace.forEach((event, index) => {
    if (!isRecord(event)) {
      issue(issues, "trace_event_invalid", `trace[${index}]`, "Trace 事件无效");
      return;
    }
    if (!Number.isInteger(event.seq) || (event.seq as number) <= previousSeq) {
      issue(issues, "trace_seq_invalid", `trace[${index}].seq`, "Trace seq 必须严格递增且唯一");
    } else previousSeq = event.seq as number;
    for (const field of ["workspaceId", "projectId", "runId", "artifactId"] as const) {
      if (event[field] !== source?.[field]) issue(issues, "trace_identity_mismatch", `trace[${index}].${field}`, "Trace 事件来源身份不一致");
    }
    if (event.skillId !== skillId) issue(issues, "trace_identity_mismatch", `trace[${index}].skillId`, "Trace 事件 skillId 不一致");
    if (typeof event.nodeId !== "string" || !event.nodeId) issue(issues, "trace_node_invalid", `trace[${index}].nodeId`, "Trace 节点 ID 无效");
    if (typeof event.type !== "string" || !event.type) issue(issues, "trace_type_invalid", `trace[${index}].type`, "Trace 事件类型无效");
  });
  return issues;
}

function validId(value: unknown, prefix: "workspace" | "project" | "run" | "artifact" | "skill" | "report"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}-[0-9a-f-]{36}$`, "i").test(value);
}

function issue(issues: BugReportValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}
