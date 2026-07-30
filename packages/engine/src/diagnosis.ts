import type { BugReportDocument, DiagnosisCandidate, DiagnosisRecord } from "./types.js";

export function diagnoseBugReport(input: {
  diagnosisId: string;
  workspaceId: string;
  reportImportId: string;
  report: BugReportDocument;
  generatedAt: string;
}): DiagnosisRecord {
  const candidates: DiagnosisCandidate[] = [];
  const limitations: string[] = [];
  for (const symptom of input.report.symptoms) {
    if (symptom.code === "transition_rejected") {
      const event = input.report.trace.find((item) => item.seq === symptom.seq);
      const allowedNodeIds = Array.isArray(event?.data.allowedNodeIds)
        ? event.data.allowedNodeIds.filter((item): item is string => typeof item === "string")
        : [];
      candidates.push(withVerification({
        candidateId: `candidate-transition-${symptom.seq}`,
        category: "invalid-transition",
        title: "下一节点提交不符合当前合法出口",
        statement: `在 ${symptom.nodeId} 提交的目标 ${symptom.requestedNodeId ?? "未记录"} 未被运行引擎接受。这个近因可以确定，但提交来源尚未确定。`,
        confidence: "high",
        evidence: [
          { source: "trace", seq: symptom.seq, nodeId: symptom.nodeId, field: "type", fact: "事件类型为 engine.reject" },
          { source: "trace", seq: symptom.seq, nodeId: symptom.nodeId, field: "data.requestedNodeId", fact: `提交目标为 ${symptom.requestedNodeId ?? "未记录"}` },
          { source: "trace", seq: symptom.seq, nodeId: symptom.nodeId, field: "data.allowedNodeIds", fact: `当时合法出口为 ${allowedNodeIds.length ? allowedNodeIds.join("、") : "未记录"}` }
        ],
        suggestions: [
          "检查产生下一节点 ID 的调用方是否使用了引擎返回的合法出口集合。",
          "若业务确实需要该跳转，通过图编辑器提出节点或边 ChangeSet，并由用户确认；不要在运行时自动绕行。"
        ],
        ...repairOption(input.report, symptom.seq, symptom.nodeId, symptom.requestedNodeId)
      }));
      if (symptom.requestedNodeId && !input.report.graphProjection.nodes.some((node) => node.id === symptom.requestedNodeId)) {
        candidates.push(withVerification({
          candidateId: `candidate-missing-node-${symptom.seq}`,
          category: "graph-reference",
          title: "提交目标未声明在运行图中",
          statement: `报告绑定的 RuntimeArtifact 图中不存在节点 ${symptom.requestedNodeId}。可能是调用方输出了错误 ID，也可能是 Skill 图缺少用户期望的节点；仅凭当前报告不能二选一。`,
          confidence: "medium",
          evidence: [
            { source: "trace", seq: symptom.seq, nodeId: symptom.nodeId, field: "data.requestedNodeId", fact: `Trace 引用了 ${symptom.requestedNodeId}` },
            { source: "graph", field: "nodes", fact: `报告图投影中没有精确 nodeId ${symptom.requestedNodeId}` }
          ],
          suggestions: [
            "核对调用方结构化输出中的 nodeId 是否拼写错误。",
            "核对用户期望流程是否已经在图中建模；需要修改时生成 ChangeSet 供用户选择。"
          ]
        }));
      }
      const conditionEvidence = rejectedConditionEvidence(input.report, symptom.seq, symptom.nodeId, symptom.requestedNodeId);
      if (conditionEvidence) candidates.push(withVerification({
        candidateId: `candidate-condition-${symptom.seq}`,
        category: "condition-evaluation",
        title: "提交目标对应条件在本次运行中为 false",
        statement: `目标 ${symptom.requestedNodeId} 存在于图中，但边 ${conditionEvidence.edgeId} 的 ${conditionEvidence.conditionOp} 条件在提交前计算为 false，因此未进入合法出口。这个结论只针对报告冻结的输入与运行状态。`,
        confidence: "high",
        evidence: [
          { source: "trace", seq: conditionEvidence.seq, nodeId: symptom.nodeId, field: "data.evaluations", fact: `边 ${conditionEvidence.edgeId} -> ${symptom.requestedNodeId} 的 ${conditionEvidence.conditionOp} 条件结果为 false` },
          { source: "trace", seq: symptom.seq, nodeId: symptom.nodeId, field: "type", fact: "随后事件类型为 engine.reject" }
        ],
        suggestions: ["核对本次 RuntimeArtifact 的初始变量和条件表达式是否符合业务预期。", "需要改变条件或测试输入时分别生成明确 ChangeSet，并使用新 Artifact 运行验证。"]
      }));
    } else if (symptom.code === "run_stopped") {
      candidates.push(withVerification({
        candidateId: `candidate-stop-${symptom.seq}`,
        category: "run-control",
        title: "运行在完成前被停止",
        statement: `运行在节点 ${symptom.nodeId} 收到停止事件。报告没有证明停止由用户、模型、工具还是环境触发。`,
        confidence: "high",
        evidence: [{ source: "trace", seq: symptom.seq, nodeId: symptom.nodeId, field: "type", fact: "事件类型为 engine.stop" }],
        suggestions: ["查看停止操作附近的 conversation、tool 或 sandbox 事件；缺少这些事件时补充复现材料。"]
      }));
    } else if (symptom.code === "assertion_failed" || symptom.code === "assertion_inconclusive") {
      const event = input.report.trace.find((item) => item.seq === symptom.seq);
      const failed = symptom.code === "assertion_failed";
      candidates.push(withVerification({
        candidateId: `candidate-assertion-${symptom.assertionId ?? symptom.seq}`,
        category: "benchmark-assertion",
        title: failed ? "Benchmark 自动断言失败" : "Benchmark 自动断言证据不足",
        statement: `${symptom.assertionKind ?? "未知"} 断言 ${symptom.assertionId ?? "未记录"}${failed ? "未满足预期" : "没有足够证据形成通过或失败结论"}。这只说明观察结果与用例期望的关系，不直接证明根因在 Skill、模型、工具或环境。`,
        confidence: "high",
        evidence: [
          { source: "trace", seq: symptom.seq, nodeId: symptom.nodeId, field: "type", fact: `事件类型为 ${event?.type ?? "assertion.result"}` },
          { source: "trace", seq: symptom.seq, nodeId: symptom.nodeId, field: "data.message", fact: typeof event?.data.message === "string" ? event.data.message : "报告未保留断言说明" }
        ],
        suggestions: [
          "对照 RuntimeFingerprint、实际路径和该断言的 expected/actual，先确认是用例期望错误还是运行结果错误。",
          "需要修改 Skill 或用例时生成 ChangeSet 并由用户确认；修改后必须创建新的真实 Benchmark run 验证。"
        ]
      }));
    } else {
      const event = input.report.trace.find((item) => item.seq === symptom.seq);
      const category = failureCategory(symptom.failureCategory);
      candidates.push(withVerification({
        candidateId: `candidate-benchmark-failure-${symptom.seq}`,
        category,
        title: category === "model-output" ? "Benchmark 模型调用或结构化协议失败" : category === "tool-execution" ? "Benchmark 工具执行失败" : category === "environment" ? "Benchmark 运行环境失败" : "Benchmark 技术执行失败",
        statement: `Benchmark 因 ${symptom.failureCategory ?? "未分类技术原因"} 结束。该状态不能人工改成业务通过，应先恢复执行条件或修正协议后重新运行。`,
        confidence: "high",
        evidence: [{ source: "trace", seq: symptom.seq, nodeId: symptom.nodeId, field: "data.message", fact: typeof event?.data.message === "string" ? event.data.message : `失败类别为 ${symptom.failureCategory ?? "未记录"}` }],
        suggestions: ["检查失败事件附近的 Provider、sandbox 和 tool 事件，解决技术失败后使用同一用例重新运行。"]
      }));
    }
  }
  appendDocumentCandidates(input.report, candidates);
  appendObservedFailureCandidates(input.report, candidates);
  if (!input.report.coverage.conversation) limitations.push("报告没有 conversation 事件，无法判断提交来自模型、用户还是测试脚本。");
  if (!input.report.coverage.tools) limitations.push("报告没有 tool 事件，无法判断工具调用或工具结果是否参与问题。");
  if (input.report.coverage.externalAgentMayBypass) limitations.push("外部 Agent 可能绕过引擎，报告只覆盖 Skill Designer 实际观测到的过程。");
  if (!candidates.length) {
    candidates.push(withVerification({
      candidateId: "candidate-insufficient-evidence",
      category: "insufficient-evidence",
      title: "证据不足",
      statement: "报告没有拒绝或停止等已定义症状，当前无法提出有证据支持的候选原因。",
      confidence: "low",
      evidence: [{ source: "report", field: "symptoms", fact: "事实症状列表为空" }],
      suggestions: ["补充失败时的 Trace、用户观察说明或工具事件后重新分析。"]
    }));
  }
  return {
    schemaVersion: "1.0",
    diagnosisId: input.diagnosisId,
    workspaceId: input.workspaceId,
    reportImportId: input.reportImportId,
    reportId: input.report.reportId,
    skillId: input.report.skill.skillId,
    candidates,
    limitations,
    generatedAt: input.generatedAt
  };
}

function rejectedConditionEvidence(report: BugReportDocument, symptomSeq: number, nodeId: string, requestedNodeId?: string): { seq: number; edgeId: string; conditionOp: string } | null {
  if (!requestedNodeId) return null;
  const events = [...report.trace].reverse();
  for (const event of events) {
    if (event.seq >= symptomSeq || event.nodeId !== nodeId || event.type !== "condition.evaluated" || !Array.isArray(event.data.evaluations)) continue;
    for (const value of event.data.evaluations) {
      if (!isRecord(value) || value.to !== requestedNodeId || value.result !== false || typeof value.edgeId !== "string") continue;
      return { seq: event.seq, edgeId: value.edgeId, conditionOp: typeof value.conditionOp === "string" ? value.conditionOp : "未知" };
    }
  }
  return null;
}

function appendDocumentCandidates(report: BugReportDocument, candidates: DiagnosisCandidate[]): void {
  const failures = report.trace.filter((event) => event.type === "document.context" && (event.data.status === "missing" || event.data.status === "ambiguous"));
  if (!failures.length) return;
  candidates.push(withVerification({
    candidateId: `candidate-document-${failures[0]!.seq}`,
    category: "document-context",
    title: "运行节点的文档上下文不可用",
    statement: "Trace 记录了节点绑定文档缺失或标题切片不唯一。工具可以确认本次运行没有得到明确文档上下文，但不能据此断言文档内容本身错误。",
    confidence: "high",
    evidence: failures.map((event) => ({ source: "trace", seq: event.seq, nodeId: event.nodeId, field: "data.status", fact: `${String(event.data.path ?? "未记录路径")} · ${String(event.data.anchor ?? "整篇")} · ${String(event.data.status)}` })),
    suggestions: ["在冻结 revision 中检查文档路径与完整标题路径是否存在且唯一。", "通过文档或节点绑定 ChangeSet 修正后，创建新 RuntimeArtifact 重新运行。"]
  }));
}

function appendObservedFailureCandidates(report: BugReportDocument, candidates: DiagnosisCandidate[]): void {
  const groups = new Map<DiagnosisCandidate["category"], typeof report.trace>();
  for (const event of report.trace) {
    const category = eventFailureCategory(event.type, event.data);
    if (!category) continue;
    const events = groups.get(category) ?? [];
    events.push(event);
    groups.set(category, events);
  }
  for (const [category, events] of groups) {
    const existing = candidates.find((candidate) => candidate.category === category);
    const evidence = events.map((event) => ({
      source: "trace" as const,
      seq: event.seq,
      nodeId: event.nodeId,
      field: "type",
      fact: `${event.type}${failureMessage(event.data) ? `：${failureMessage(event.data)}` : ""}`
    }));
    if (existing) {
      const known = new Set(existing.evidence.map((item) => `${item.seq ?? ""}:${item.field ?? ""}`));
      existing.evidence.push(...evidence.filter((item) => !known.has(`${item.seq}:${item.field}`)));
      continue;
    }
    const first = events[0]!;
    const copy = domainCopy(category);
    candidates.push(withVerification({
      candidateId: `candidate-${category}-${first.seq}`,
      category,
      title: copy.title,
      statement: `${copy.statement} 这里只能确认已记录的失败域，不能仅凭事件断言 Skill 设计本身有错。`,
      confidence: "high",
      evidence,
      suggestions: copy.suggestions
    }));
  }
}

function eventFailureCategory(type: string, data: Record<string, unknown>): DiagnosisCandidate["category"] | null {
  if (/^(llm|model)\.(error|failed|protocol-error)$/u.test(type)) return "model-output";
  if (/^tool\.(error|failed)$/u.test(type)) return "tool-execution";
  if (type === "tool.result" && (data.status === "failed" || data.status === "error" || (typeof data.exitCode === "number" && data.exitCode !== 0))) return "tool-execution";
  if (/^sandbox\.(failed|timed-out)$/u.test(type) || /^provider\.(error|unavailable)$/u.test(type)) return "environment";
  return null;
}

function failureCategory(category: string | undefined): DiagnosisCandidate["category"] {
  if (category === "model-error" || category === "model-protocol-error") return "model-output";
  if (category === "tool-error") return "tool-execution";
  if (category === "sandbox-unavailable" || category === "provider-unavailable") return "environment";
  return "benchmark-execution";
}

function failureMessage(data: Record<string, unknown>): string {
  return typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function domainCopy(category: DiagnosisCandidate["category"]): { title: string; statement: string; suggestions: string[] } {
  if (category === "model-output") return { title: "模型调用或结构化输出失败", statement: "Trace 记录了模型调用或协议失败。", suggestions: ["检查相邻模型请求、响应或错误类别，并使用同一 Artifact 显式重试。"] };
  if (category === "tool-execution") return { title: "工具执行返回失败", statement: "Trace 记录了工具失败或非零退出结果。", suggestions: ["核对工具参数、退出码和对应沙箱输出，再在隔离环境中重跑同一动作。"] };
  return { title: "沙箱或 Provider 环境失败", statement: "Trace 记录了沙箱、超时或 Provider 可用性失败。", suggestions: ["先恢复运行环境并通过自检，再使用同一用例重新运行。"] };
}

function withVerification(candidate: Omit<DiagnosisCandidate, "verification">): DiagnosisCandidate {
  const verification = candidate.category === "environment" ? {
    method: "check-environment" as const,
    steps: ["执行对应 Provider 或沙箱自检。", "自检通过后使用同一用例创建新运行。"],
    successEvidence: ["自检记录为通过。", "新运行不再出现同类环境失败事件。"]
  } : candidate.category === "benchmark-assertion" || candidate.category === "benchmark-execution" ? {
    method: "rerun-benchmark" as const,
    steps: ["核对报告中的断言、Artifact 和执行指纹。", "使用同一用例创建新的真实 Benchmark。"],
    successEvidence: ["新 Benchmark 技术状态 completed。", "自动断言和人工判定形成明确结论。"]
  } : candidate.category === "insufficient-evidence" ? {
    method: "inspect-trace" as const,
    steps: ["补充缺失事件域或用户观察。", "重新生成并分析报告。"],
    successEvidence: ["候选原因引用新增 Trace 或报告事实。"]
  } : {
    method: "rerun-runtime" as const,
    steps: ["核对候选引用的 Trace 与图事实。", "保持输入明确并创建新 RuntimeArtifact 运行。"],
    successEvidence: ["新运行覆盖原问题路径。", "同类失败事件未再次出现或形成可比较的新证据。"]
  };
  return { ...candidate, verification };
}

function repairOption(
  report: BugReportDocument,
  symptomSeq: number,
  from: string,
  requestedNodeId?: string
): Pick<DiagnosisCandidate, "repair"> | Record<string, never> {
  if (!requestedNodeId || !report.graphProjection.nodes.some((node) => node.id === requestedNodeId)) return {};
  if (report.graphProjection.edges.some((edge) => edge.from === from && edge.to === requestedNodeId && edge.kind !== "knowledge")) return {};
  const targetWasVisited = report.trace.some((event) => event.seq < symptomSeq && event.nodeId === requestedNodeId && (event.type === "engine.start" || event.type === "engine.enter"));
  const edgeId = `edge.diagnosis-${symptomSeq}`;
  return {
    repair: {
      kind: "graph.add-edge",
      title: `添加 ${from} -> ${requestedNodeId} 的${targetWasVisited ? "回退" : "流程"}边`,
      operation: {
        op: "graph.edge.create",
        target: edgeId,
        value: { id: edgeId, from, to: requestedNodeId, kind: targetWasVisited ? "back" : "flow" }
      }
    }
  };
}
