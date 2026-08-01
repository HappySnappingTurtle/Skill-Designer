import type {
  BenchmarkAssertionResult,
  BenchmarkAutomaticVerdict,
  BenchmarkCase,
  BenchmarkCaseIssue,
  BenchmarkObservedResult,
  BenchmarkRunComparison,
  BenchmarkRunRecord,
  BugReportDocument,
  GraphEdge,
  RuntimeTraceEvent,
  SkillGraph
} from "./types.js";

const CASE_ID = /^case-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_PROJECT_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.\-/ ]+$/u;

export function lintBenchmarkCase(value: unknown, graph: SkillGraph, expectedSkillId: string): BenchmarkCaseIssue[] {
  const issues: BenchmarkCaseIssue[] = [];
  const record = asRecord(value);
  if (!record) return [issue("error", "case", "invalid_case", "测试用例必须是对象")];

  if (record.schemaVersion !== "1.0") error(issues, "schemaVersion", "unsupported_version", "仅支持测试用例 Schema 1.0");
  if (typeof record.caseId !== "string" || !CASE_ID.test(record.caseId)) error(issues, "caseId", "invalid_case_id", "caseId 必须是稳定 UUID");
  if (record.skillId !== expectedSkillId) error(issues, "skillId", "skill_identity_mismatch", "测试用例 skillId 与项目不一致");
  textField(issues, record.title, "title", 120, true);
  if (record.status !== "draft" && record.status !== "ready") error(issues, "status", "invalid_status", "状态必须是 draft 或 ready");
  textField(issues, record.intent, "intent", 4000, record.status === "ready");

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const fixture = asRecord(record.fixture);
  if (!fixture) {
    error(issues, "fixture", "invalid_fixture", "fixture 必须是对象");
  } else {
    if (!asRecord(fixture.initialVariables)) error(issues, "fixture.initialVariables", "invalid_variables", "初始变量必须是 JSON 对象");
    if (!Array.isArray(fixture.userReplies)) {
      error(issues, "fixture.userReplies", "invalid_user_replies", "预设用户回答必须是数组");
    } else if (fixture.userReplies.length > 100) {
      error(issues, "fixture.userReplies", "too_many_user_replies", "预设用户回答不能超过 100 条");
    } else {
      fixture.userReplies.forEach((raw, index) => {
        const reply = asRecord(raw);
        if (!reply) return error(issues, `fixture.userReplies[${index}]`, "invalid_user_reply", "用户回答必须是对象");
        textField(issues, reply.message, `fixture.userReplies[${index}].message`, 4000, true);
        if (reply.nodeId !== undefined) {
          if (typeof reply.nodeId !== "string" || !nodeById.has(reply.nodeId)) {
            error(issues, `fixture.userReplies[${index}].nodeId`, "unknown_node", "用户回答引用的节点不存在");
          } else if (nodeById.get(reply.nodeId)?.kind !== "gate") {
            warning(issues, `fixture.userReplies[${index}].nodeId`, "reply_node_not_gate", "预设回答绑定的节点不是确认节点");
          }
        }
      });
    }
  }

  const expected = asRecord(record.expected);
  if (!expected) {
    error(issues, "expected", "invalid_expected", "expected 必须是对象");
  } else {
    lintExpectedPath(issues, expected.path, graph, nodeById);
    lintTerminal(issues, expected.terminal, nodeById);
    if (!asRecord(expected.variables)) error(issues, "expected.variables", "invalid_variables", "期望变量必须是 JSON 对象");
    lintArtifacts(issues, expected.artifacts);
    lintToolResults(issues, expected.toolResults);
    stringArray(issues, expected.forbiddenEffects, "expected.forbiddenEffects", 100, 500);
    if (record.status === "ready" && !hasExpectation(expected)) {
      error(issues, "expected", "expectation_required", "ready 用例至少需要一种期望或禁止副作用");
    }
  }

  const tags = stringArray(issues, record.tags, "tags", 20, 40);
  if (tags && new Set(tags.map((tag) => tag.toLocaleLowerCase("en-US"))).size !== tags.length) {
    error(issues, "tags", "duplicate_tags", "标签不能重复");
  }
  if (record.notes !== undefined) textField(issues, record.notes, "notes", 8000, false);
  if (record.source !== undefined) {
    const source = asRecord(record.source);
    if (!source || source.kind !== "bug-report" || !validSourceId(source.reportImportId, "report-import") || !validSourceId(source.reportId, "report") || !validSourceRunId(source.sourceRunId)) {
      error(issues, "source", "invalid_source", "Bug Report 来源身份无效");
    }
  }

  const replies = fixture && Array.isArray(fixture.userReplies) ? fixture.userReplies : [];
  if (graph.nodes.some((node) => node.kind === "gate") && replies.length === 0) {
    warning(issues, "fixture.userReplies", "fixture_incomplete", "流程包含确认节点但没有预设用户回答；运行结果不能自动判定通过");
  }
  return issues;
}

export function evaluateBenchmarkAssertions(
  benchmarkCase: BenchmarkCase,
  observed: BenchmarkObservedResult
): { verdict: BenchmarkAutomaticVerdict; assertions: BenchmarkAssertionResult[] } {
  const assertions: BenchmarkAssertionResult[] = [];
  const expectedPath = benchmarkCase.expected.path.nodeIds;
  const pathMatches = benchmarkCase.expected.path.mode === "exact"
    ? deepEqual(expectedPath, observed.visitedNodeIds)
    : isSubsequence(expectedPath, observed.visitedNodeIds);
  assertions.push({
    assertionId: "path",
    kind: "path",
    status: pathMatches ? "pass" : "fail",
    message: pathMatches ? "节点路径符合预期" : "节点路径与预期不一致",
    expected: benchmarkCase.expected.path,
    actual: observed.visitedNodeIds
  });

  if (benchmarkCase.expected.terminal) {
    const expected = benchmarkCase.expected.terminal;
    const matches = expected.status === observed.terminal.status && (!expected.nodeId || expected.nodeId === observed.terminal.nodeId);
    assertions.push({ assertionId: "terminal", kind: "terminal", status: matches ? "pass" : "fail", message: matches ? "终态符合预期" : "终态与预期不一致", expected, actual: observed.terminal });
  }

  for (const [key, expected] of Object.entries(benchmarkCase.expected.variables)) {
    const actual = observed.variables[key];
    const matches = deepEqual(expected, actual);
    assertions.push({ assertionId: `variable:${key}`, kind: "variable", status: matches ? "pass" : "fail", message: matches ? `变量 ${key} 符合预期` : `变量 ${key} 与预期不一致`, expected, actual });
  }

  for (const expected of benchmarkCase.expected.artifacts) {
    const artifact = observed.artifacts.find((item) => item.path === expected.path);
    let status: BenchmarkAssertionResult["status"] = expected.exists === Boolean(artifact) ? "pass" : "fail";
    let message = status === "pass" ? `产物 ${expected.path} 存在性符合预期` : `产物 ${expected.path} 存在性与预期不一致`;
    if (status === "pass" && expected.exists && expected.contains !== undefined) {
      if (artifact?.text === undefined) {
        status = "inconclusive";
        message = `产物 ${expected.path} 不是可检查的 UTF-8 文本`;
      } else {
        status = artifact.text.includes(expected.contains) ? "pass" : "fail";
        message = status === "pass" ? `产物 ${expected.path} 包含期望内容` : `产物 ${expected.path} 缺少期望内容`;
      }
    }
    assertions.push({
      assertionId: `artifact:${expected.path}`,
      kind: "artifact",
      status,
      message,
      expected,
      actual: artifact ? { path: artifact.path, size: artifact.size, sha256: artifact.sha256 } : null
    });
  }

  for (const expected of benchmarkCase.expected.toolResults) {
    const candidates = observed.toolResults.filter((item) => item.tool === expected.tool);
    const actual = expected.field ? candidates.map((item) => readField(item.result, expected.field!)).find((item) => item !== undefined) : candidates[0]?.result;
    const matches = actual !== undefined && (expected.equals === undefined || deepEqual(expected.equals, actual));
    assertions.push({ assertionId: `tool:${expected.tool}:${expected.field ?? "result"}`, kind: "tool-result", status: matches ? "pass" : "fail", message: matches ? `工具 ${expected.tool} 结果符合预期` : `工具 ${expected.tool} 结果与预期不一致`, expected, actual });
  }

  for (const effect of benchmarkCase.expected.forbiddenEffects) {
    const observedEffect = observed.observedEffects.includes(effect);
    assertions.push({ assertionId: `effect:${effect}`, kind: "forbidden-effect", status: observedEffect ? "fail" : "pass", message: observedEffect ? `检测到禁止副作用：${effect}` : `未检测到禁止副作用：${effect}`, expected: false, actual: observedEffect });
  }

  const verdict: BenchmarkAutomaticVerdict = assertions.some((item) => item.status === "fail")
    ? "failed"
    : assertions.some((item) => item.status === "inconclusive")
      ? "inconclusive"
      : "passed";
  return { verdict, assertions };
}

export function compareBenchmarkRuns(before: BenchmarkRunRecord, after: BenchmarkRunRecord): BenchmarkRunComparison {
  const beforePath = benchmarkPath(before);
  const afterPath = benchmarkPath(after);
  const sharedPrefixNodeIds: string[] = [];
  const sharedLength = Math.min(beforePath.length, afterPath.length);
  let divergenceIndex = sharedLength;
  for (let index = 0; index < sharedLength; index++) {
    if (beforePath[index] !== afterPath[index]) {
      divergenceIndex = index;
      break;
    }
    sharedPrefixNodeIds.push(beforePath[index]!);
  }
  const pathsEqual = divergenceIndex === sharedLength && beforePath.length === afterPath.length;
  const beforeAssertions = new Map(before.assertions.map((assertion) => [assertion.assertionId, assertion]));
  const afterAssertions = new Map(after.assertions.map((assertion) => [assertion.assertionId, assertion]));
  const assertions = [...new Set([...beforeAssertions.keys(), ...afterAssertions.keys()])].sort().map((assertionId) => {
    const left = beforeAssertions.get(assertionId);
    const right = afterAssertions.get(assertionId);
    const change = !left ? "added" as const : !right ? "removed" as const : canonicalBenchmarkValue(left) === canonicalBenchmarkValue(right) ? "unchanged" as const : "changed" as const;
    return {
      assertionId,
      kind: (right ?? left)!.kind,
      change,
      beforeStatus: left?.status ?? null,
      afterStatus: right?.status ?? null,
      ...(left ? { beforeMessage: left.message } : {}),
      ...(right ? { afterMessage: right.message } : {})
    };
  });
  const beforeCounts = benchmarkEventCounts(before);
  const afterCounts = benchmarkEventCounts(after);
  const eventTypes = [...new Set([...Object.keys(beforeCounts), ...Object.keys(afterCounts)])].sort().map((type) => {
    const beforeCount = beforeCounts[type] ?? 0;
    const afterCount = afterCounts[type] ?? 0;
    return { type, beforeCount, afterCount, delta: afterCount - beforeCount };
  });
  const usageMetrics = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens", "cacheWriteTokens"] as const;
  const lineage = after.lineage?.parentBenchmarkRunId === before.benchmarkRunId ? after.lineage.relation : null;
  return {
    schemaVersion: "1.0",
    beforeRunId: before.benchmarkRunId,
    afterRunId: after.benchmarkRunId,
    relation: lineage,
    artifact: {
      ...(before.fingerprint.runtimeArtifactId ? { beforeId: before.fingerprint.runtimeArtifactId } : {}),
      ...(after.fingerprint.runtimeArtifactId ? { afterId: after.fingerprint.runtimeArtifactId } : {}),
      ...(before.fingerprint.revision ? { beforeRevision: before.fingerprint.revision } : {}),
      ...(after.fingerprint.revision ? { afterRevision: after.fingerprint.revision } : {}),
      ...(before.fingerprint.contentHash ? { beforeContentHash: before.fingerprint.contentHash } : {}),
      ...(after.fingerprint.contentHash ? { afterContentHash: after.fingerprint.contentHash } : {}),
      idChanged: before.fingerprint.runtimeArtifactId !== after.fingerprint.runtimeArtifactId,
      revisionChanged: before.fingerprint.revision !== after.fingerprint.revision,
      contentHashChanged: before.fingerprint.contentHash !== after.fingerprint.contentHash
    },
    path: {
      beforeNodeIds: beforePath,
      afterNodeIds: afterPath,
      sharedPrefixNodeIds,
      firstDivergence: pathsEqual ? null : {
        index: divergenceIndex,
        beforeNodeId: beforePath[divergenceIndex] ?? null,
        afterNodeId: afterPath[divergenceIndex] ?? null
      }
    },
    assertions,
    trace: { beforeEventCount: before.events.length, afterEventCount: after.events.length, eventTypes },
    usage: usageMetrics.map((metric) => ({ metric, before: before.usage[metric], after: after.usage[metric], delta: after.usage[metric] - before.usage[metric] })),
    modelCalls: { before: before.modelCallCount, after: after.modelCallCount, delta: after.modelCallCount - before.modelCallCount },
    latestHumanVerdicts: { before: before.humanReviews.at(-1)?.verdict ?? null, after: after.humanReviews.at(-1)?.verdict ?? null }
  };
}

function benchmarkPath(run: BenchmarkRunRecord): string[] {
  return [...run.events]
    .sort((left, right) => left.seq - right.seq)
    .filter((event) => event.type === "engine.enter" && typeof event.nodeId === "string")
    .map((event) => event.nodeId!);
}

function benchmarkEventCounts(run: BenchmarkRunRecord): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of run.events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function canonicalBenchmarkValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalBenchmarkValue).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalBenchmarkValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isSubsequence(expected: readonly string[], actual: readonly string[]): boolean {
  let index = 0;
  for (const item of actual) if (item === expected[index]) index++;
  return index === expected.length;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return deepEqual(leftKeys, rightKeys) && leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
}

function readField(value: unknown, field: string): unknown {
  return field.split(".").reduce<unknown>((current, segment) => asRecord(current)?.[segment], value);
}

export function createBenchmarkCaseFromReport(input: {
  caseId: string;
  reportImportId: string;
  report: BugReportDocument;
}): BenchmarkCase {
  const path = input.report.trace.filter((event) => event.type === "engine.enter").map((event) => event.nodeId);
  const terminalEvent = [...input.report.trace].reverse().find((event) => event.type === "engine.complete" || event.type === "engine.stop");
  const terminal = terminalEvent ? {
    status: terminalEvent.type === "engine.complete" ? "completed" as const : "stopped" as const,
    nodeId: terminalEvent.nodeId
  } : undefined;
  return {
    schemaVersion: "1.0",
    caseId: input.caseId,
    skillId: input.report.skill.skillId,
    title: `${input.report.skill.name}：报告回归候选`,
    status: "draft",
    intent: "复现 Bug Report 中记录的流程路径；运行前需人工补充输入、回答和业务期望。",
    fixture: { initialVariables: {}, userReplies: [] },
    expected: {
      path: { mode: "subsequence", nodeIds: path },
      ...(terminal ? { terminal } : {}),
      variables: {},
      artifacts: [],
      toolResults: [],
      forbiddenEffects: []
    },
    tags: ["bug-report", "candidate"],
    notes: `来源报告 ${input.report.reportId}；来源运行 ${input.report.source.benchmarkRunId ?? input.report.source.runId}。候选用例不代表 Benchmark 已通过。`,
    source: {
      kind: "bug-report",
      reportImportId: input.reportImportId,
      reportId: input.report.reportId,
      sourceRunId: input.report.source.benchmarkRunId ?? input.report.source.runId
    }
  };
}

export function createBenchmarkCaseFromRuntime(input: {
  caseId: string;
  skillId: string;
  skillName: string;
  initialVariables: Record<string, unknown>;
  finalVariables: Record<string, unknown>;
  status: "completed" | "stopped";
  currentNodeId: string;
  trace: RuntimeTraceEvent[];
}): BenchmarkCase {
  const path = input.trace
    .filter((event) => event.type === "engine.enter")
    .map((event) => event.nodeId);
  return {
    schemaVersion: "1.0",
    caseId: input.caseId,
    skillId: input.skillId,
    title: `${input.skillName}：运行回归候选`,
    status: "draft",
    intent: "把一次手动运行的观察结果整理为回归测试；保存前需人工确认输入、路径、终态和变量确实是业务期望。",
    fixture: {
      initialVariables: structuredClone(input.initialVariables),
      userReplies: []
    },
    expected: {
      path: { mode: "subsequence", nodeIds: path },
      terminal: { status: input.status, nodeId: input.currentNodeId },
      variables: structuredClone(input.finalVariables),
      artifacts: [],
      toolResults: [],
      forbiddenEffects: []
    },
    tags: ["runtime-trace", "candidate"],
    notes: "由手动运行观察结果生成。观察到的结果不等于正确期望；确认 ChangeSet 前请逐项审阅。"
  };
}

function validSourceId(value: unknown, prefix: "report-import" | "report" | "run"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}-[0-9a-f-]{36}$`, "i").test(value);
}

function validSourceRunId(value: unknown): value is string {
  return validSourceId(value, "run") || (typeof value === "string" && /^benchmark-run-[0-9a-f-]{36}$/iu.test(value));
}

function lintExpectedPath(
  issues: BenchmarkCaseIssue[],
  raw: unknown,
  graph: SkillGraph,
  nodeById: Map<string, SkillGraph["nodes"][number]>
): void {
  const path = asRecord(raw);
  if (!path) return error(issues, "expected.path", "invalid_path", "期望路径必须是对象");
  if (path.mode !== "subsequence" && path.mode !== "exact") error(issues, "expected.path.mode", "invalid_path_mode", "路径模式必须是 subsequence 或 exact");
  if (!Array.isArray(path.nodeIds) || path.nodeIds.some((id) => typeof id !== "string")) {
    return error(issues, "expected.path.nodeIds", "invalid_node_ids", "期望路径节点必须是字符串数组");
  }
  if (path.nodeIds.length > 500) return error(issues, "expected.path.nodeIds", "path_too_long", "期望路径不能超过 500 个节点");
  path.nodeIds.forEach((id, index) => {
    if (!nodeById.has(id)) error(issues, `expected.path.nodeIds[${index}]`, "unknown_node", `期望路径节点 ${id} 不存在`);
  });
  if (issues.some((item) => item.code === "unknown_node" && item.path.startsWith("expected.path"))) return;
  const edges = graph.edges.filter((edge) => edge.kind !== "knowledge");
  for (let index = 1; index < path.nodeIds.length; index++) {
    const from = path.nodeIds[index - 1] as string;
    const to = path.nodeIds[index] as string;
    const possible = path.mode === "exact" ? hasDirectEdge(edges, from, to) : isReachable(edges, from, to);
    if (!possible) error(issues, `expected.path.nodeIds[${index}]`, "impossible_path", `${from} 无法按 ${path.mode} 模式到达 ${to}`);
  }
}

function lintTerminal(issues: BenchmarkCaseIssue[], raw: unknown, nodeById: Map<string, SkillGraph["nodes"][number]>): void {
  if (raw === undefined) return;
  const terminal = asRecord(raw);
  if (!terminal) return error(issues, "expected.terminal", "invalid_terminal", "终态断言必须是对象");
  if (terminal.status !== "completed" && terminal.status !== "stopped") {
    error(issues, "expected.terminal.status", "invalid_terminal_status", "终态必须是 completed 或 stopped");
  }
  if (terminal.nodeId !== undefined) {
    if (typeof terminal.nodeId !== "string" || !nodeById.has(terminal.nodeId)) {
      error(issues, "expected.terminal.nodeId", "unknown_node", "终态节点不存在");
    } else if (terminal.status === "completed" && nodeById.get(terminal.nodeId)?.kind !== "end") {
      warning(issues, "expected.terminal.nodeId", "completed_node_not_end", "完成状态通常应落在 end 节点");
    }
  }
}

function lintArtifacts(issues: BenchmarkCaseIssue[], raw: unknown): void {
  if (!Array.isArray(raw)) return error(issues, "expected.artifacts", "invalid_artifacts", "产物断言必须是数组");
  if (raw.length > 100) return error(issues, "expected.artifacts", "too_many_artifacts", "产物断言不能超过 100 条");
  raw.forEach((item, index) => {
    const artifact = asRecord(item);
    if (!artifact) return error(issues, `expected.artifacts[${index}]`, "invalid_artifact", "产物断言必须是对象");
    if (typeof artifact.path !== "string" || !SAFE_PROJECT_PATH.test(artifact.path) || artifact.path.length > 300) {
      error(issues, `expected.artifacts[${index}].path`, "invalid_artifact_path", "产物路径必须是安全相对路径");
    }
    if (typeof artifact.exists !== "boolean") error(issues, `expected.artifacts[${index}].exists`, "invalid_exists", "exists 必须是布尔值");
    if (artifact.contains !== undefined) textField(issues, artifact.contains, `expected.artifacts[${index}].contains`, 4000, false);
  });
}

function lintToolResults(issues: BenchmarkCaseIssue[], raw: unknown): void {
  if (!Array.isArray(raw)) return error(issues, "expected.toolResults", "invalid_tool_results", "工具结果断言必须是数组");
  if (raw.length > 100) return error(issues, "expected.toolResults", "too_many_tool_results", "工具结果断言不能超过 100 条");
  raw.forEach((item, index) => {
    const result = asRecord(item);
    if (!result) return error(issues, `expected.toolResults[${index}]`, "invalid_tool_result", "工具结果断言必须是对象");
    textField(issues, result.tool, `expected.toolResults[${index}].tool`, 120, true);
    if (result.field !== undefined) textField(issues, result.field, `expected.toolResults[${index}].field`, 300, false);
  });
}

function hasExpectation(expected: Record<string, unknown>): boolean {
  const path = asRecord(expected.path);
  return Boolean(
    (Array.isArray(path?.nodeIds) && path.nodeIds.length) ||
    expected.terminal ||
    (asRecord(expected.variables) && Object.keys(expected.variables as object).length) ||
    (Array.isArray(expected.artifacts) && expected.artifacts.length) ||
    (Array.isArray(expected.toolResults) && expected.toolResults.length) ||
    (Array.isArray(expected.forbiddenEffects) && expected.forbiddenEffects.length)
  );
}

function stringArray(issues: BenchmarkCaseIssue[], raw: unknown, path: string, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    error(issues, path, "invalid_string_array", "字段必须是字符串数组");
    return undefined;
  }
  if (raw.length > maxItems) error(issues, path, "too_many_items", `最多允许 ${maxItems} 项`);
  raw.forEach((item, index) => textField(issues, item, `${path}[${index}]`, maxLength, true));
  return raw as string[];
}

function textField(issues: BenchmarkCaseIssue[], raw: unknown, path: string, maxLength: number, required: boolean): void {
  if (typeof raw !== "string") return error(issues, path, "invalid_text", "字段必须是字符串");
  if (required && !raw.trim()) error(issues, path, "required", "字段不能为空");
  if (raw.length > maxLength) error(issues, path, "too_long", `字段不能超过 ${maxLength} 个字符`);
}

function hasDirectEdge(edges: GraphEdge[], from: string, to: string): boolean {
  return edges.some((edge) => edge.from === from && edge.to === to);
}

function isReachable(edges: GraphEdge[], from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.from !== current || seen.has(edge.to)) continue;
      if (edge.to === to) return true;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function issue(severity: BenchmarkCaseIssue["severity"], path: string, code: string, message: string): BenchmarkCaseIssue {
  return { severity, path, code, message };
}

function error(issues: BenchmarkCaseIssue[], path: string, code: string, message: string): void {
  issues.push(issue("error", path, code, message));
}

function warning(issues: BenchmarkCaseIssue[], path: string, code: string, message: string): void {
  issues.push(issue("warning", path, code, message));
}
