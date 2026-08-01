import { lintGraph } from "./graph.js";
import type {
  GraphEdge,
  GraphNode,
  ImportConfidence,
  ImportEdgeCandidate,
  ImportNodeCandidate,
  ImportParseEvidence,
  ImportUnresolvedQuestion,
  SkillGraph,
  SkillImportParseReview,
  SkillImportReviewSnapshot
} from "./types.js";

export interface BuildImportParseReviewInput {
  skillId: string;
  sourceDigest: string;
  markdown: string;
  nativeGraph?: SkillGraph;
  declaredCapability?: "workflow" | "content-only";
}

interface MarkdownStep {
  title: string;
  line: number;
  evidence: ImportParseEvidence;
  confidence: ImportConfidence;
}

const WORKFLOW_SECTION_TITLES = new Set([
  "workflow",
  "step",
  "steps",
  "工作流",
  "流程",
  "执行流程",
  "操作步骤",
  "步骤",
  "快速工作流",
  "快速流程",
  "快速步骤",
  "标准工作流",
  "标准流程",
  "标准步骤",
  "默认工作流",
  "默认流程",
  "默认步骤"
]);

export function buildImportParseReview(input: BuildImportParseReviewInput): SkillImportParseReview {
  const snapshot = input.nativeGraph
    ? nativeSnapshot(input.skillId, input.nativeGraph)
    : input.declaredCapability === "content-only"
      ? declaredContentSnapshot(input.skillId, input.markdown)
      : markdownSnapshot(input.skillId, input.markdown);
  return {
    parserVersion: "static-v2",
    reviewRevision: 1,
    sourceDigest: input.sourceDigest,
    manuallyEdited: false,
    ...snapshot
  };
}

function declaredContentSnapshot(skillId: string, markdown: string): SkillImportReviewSnapshot {
  const title = markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim() || "Skill 内容";
  const evidence: ImportParseEvidence = {
    path: "skill.json",
    startLine: 1,
    endLine: 1,
    snippet: '"capability": "content-only"',
    kind: "skill-manifest"
  };
  return withImportReviewLint(skillId, {
    capability: "content-only",
    nodes: [{
      candidateId: "node:knowledge.overview",
      value: { id: "knowledge.overview", kind: "knowledge", title, doc: "SKILL.md", position: { x: 0, y: 0 } },
      decision: "accepted",
      confidence: "high",
      evidence: [evidence],
      manuallyEdited: false
    }],
    edges: [],
    unresolvedQuestions: [],
    lint: []
  });
}

export function importReviewGraph(skillId: string, review: SkillImportReviewSnapshot): SkillGraph {
  const nodes = review.nodes.filter((candidate) => candidate.decision === "accepted").map((candidate) => structuredClone(candidate.value));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = review.edges
    .filter((candidate) => candidate.decision === "accepted")
    .map((candidate) => structuredClone(candidate.value))
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  return {
    schemaVersion: "1.0",
    skillId,
    capability: review.capability,
    ...(review.capability === "workflow" && review.entry ? { entry: review.entry } : {}),
    nodes,
    edges
  };
}

export function withImportReviewLint(skillId: string, snapshot: SkillImportReviewSnapshot): SkillImportReviewSnapshot {
  return { ...snapshot, lint: lintGraph(importReviewGraph(skillId, snapshot)) };
}

function nativeSnapshot(skillId: string, graph: SkillGraph): SkillImportReviewSnapshot {
  const source = (snippet: string): ImportParseEvidence[] => [{
    path: "graph/main.json",
    startLine: 1,
    endLine: 1,
    snippet: snippet.slice(0, 240),
    kind: "native-graph"
  }];
  const nodes = graph.nodes.map((node): ImportNodeCandidate => ({
    candidateId: `node:${node.id}`,
    value: structuredClone(node),
    decision: "accepted",
    confidence: "high",
    evidence: source(JSON.stringify(node)),
    manuallyEdited: false
  }));
  const edges = graph.edges.map((edge): ImportEdgeCandidate => ({
    candidateId: `edge:${edge.id}`,
    value: structuredClone(edge),
    decision: "accepted",
    confidence: "high",
    evidence: source(JSON.stringify(edge)),
    manuallyEdited: false
  }));
  const snapshot: SkillImportReviewSnapshot = {
    capability: graph.capability,
    ...(graph.entry ? { entry: graph.entry } : {}),
    nodes,
    edges,
    unresolvedQuestions: [],
    lint: []
  };
  return withImportReviewLint(skillId, snapshot);
}

function markdownSnapshot(skillId: string, markdown: string): SkillImportReviewSnapshot {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const section = findWorkflowSection(lines);
  const steps = section ? collectSteps(lines, section.line, section.level) : [];
  if (steps.length >= 2) return workflowSnapshot(skillId, steps, section!.evidence);

  const headingIndex = lines.findIndex((line) => /^#\s+\S/u.test(line));
  const title = headingIndex >= 0 ? lines[headingIndex]!.replace(/^#\s+/u, "").trim() : "Skill 内容";
  const evidence: ImportParseEvidence = {
    path: "SKILL.md",
    startLine: Math.max(headingIndex + 1, 1),
    endLine: Math.max(headingIndex + 1, 1),
    snippet: headingIndex >= 0 ? lines[headingIndex]!.trim() : "未找到一级标题",
    kind: "fallback"
  };
  const node: GraphNode = { id: "knowledge.overview", kind: "knowledge", title, doc: "SKILL.md", position: { x: 0, y: 0 } };
  const questions: ImportUnresolvedQuestion[] = [{
    questionId: "workflow-evidence-missing",
    message: steps.length === 1 ? "流程章节只提取到一个步骤，无法证明节点间关系，按内容型 Skill 展示。" : "未发现至少两个具有明确顺序的流程步骤，按内容型 Skill 展示。",
    blocking: false,
    evidence: section ? [section.evidence] : [evidence]
  }];
  const snapshot: SkillImportReviewSnapshot = {
    capability: "content-only",
    nodes: [{ candidateId: "node:knowledge.overview", value: node, decision: "accepted", confidence: "low", evidence: [evidence], manuallyEdited: false }],
    edges: [],
    unresolvedQuestions: questions,
    lint: []
  };
  return withImportReviewLint(skillId, snapshot);
}

function workflowSnapshot(skillId: string, steps: MarkdownStep[], sectionEvidence: ImportParseEvidence): SkillImportReviewSnapshot {
  const start: GraphNode = { id: "flow.start", kind: "start", title: "开始", doc: "SKILL.md", position: { x: 0, y: 120 } };
  const end: GraphNode = { id: "flow.end", kind: "end", title: "完成", doc: "SKILL.md", position: { x: (steps.length + 1) * 220, y: 120 } };
  const usedIds = new Set([start.id, end.id]);
  const stepNodes = steps.map((step, index): GraphNode => ({
    id: uniqueNodeId(step.title, usedIds),
    kind: "step",
    title: step.title.slice(0, 200),
    doc: "SKILL.md",
    position: { x: (index + 1) * 220, y: 120 }
  }));
  const allNodes = [start, ...stepNodes, end];
  const nodes: ImportNodeCandidate[] = allNodes.map((node, index) => ({
    candidateId: `node:${node.id}`,
    value: node,
    decision: "accepted",
    confidence: index === 0 || index === allNodes.length - 1 ? "medium" : steps[index - 1]!.confidence,
    evidence: index === 0 || index === allNodes.length - 1 ? [sectionEvidence] : [steps[index - 1]!.evidence],
    manuallyEdited: false
  }));
  const edges: ImportEdgeCandidate[] = allNodes.slice(0, -1).map((node, index) => {
    const next = allNodes[index + 1]!;
    const edge: GraphEdge = { id: `edge.flow-${index + 1}`, from: node.id, to: next.id, kind: "flow" };
    return {
      candidateId: `edge:${edge.id}`,
      value: edge,
      decision: "accepted",
      confidence: index === 0 || index === allNodes.length - 2 ? "medium" : steps[index]!.confidence,
      evidence: [index === 0 ? sectionEvidence : steps[Math.min(index - 1, steps.length - 1)]!.evidence],
      manuallyEdited: false
    };
  });
  const snapshot: SkillImportReviewSnapshot = {
    capability: "workflow",
    entry: "flow.start",
    nodes,
    edges,
    unresolvedQuestions: [{
      questionId: "sequential-flow-assumption",
      message: "当前有向边按文档中的出现顺序生成；请确认是否存在条件分支、回退或并行关系。",
      blocking: false,
      evidence: [sectionEvidence]
    }],
    lint: []
  };
  return withImportReviewLint(skillId, snapshot);
}

function findWorkflowSection(lines: string[]): { line: number; level: number; evidence: ImportParseEvidence } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^(#{1,6})\s+(.+?)\s*$/u);
    if (!match || !WORKFLOW_SECTION_TITLES.has(match[2]!.trim().toLocaleLowerCase("en-US"))) continue;
    return {
      line: index,
      level: match[1]!.length,
      evidence: { path: "SKILL.md", startLine: index + 1, endLine: index + 1, snippet: lines[index]!.trim(), kind: "markdown-heading" }
    };
  }
  return null;
}

function collectSteps(lines: string[], sectionLine: number, sectionLevel: number): MarkdownStep[] {
  const headings: MarkdownStep[] = [];
  const listItems: MarkdownStep[] = [];
  for (let index = sectionLine + 1; index < lines.length; index += 1) {
    const heading = lines[index]!.match(/^(#{1,6})\s+(.+?)\s*$/u);
    if (heading && heading[1]!.length <= sectionLevel) break;
    if (heading) {
      headings.push({
        title: heading[2]!.trim(),
        line: index + 1,
        confidence: "high",
        evidence: { path: "SKILL.md", startLine: index + 1, endLine: index + 1, snippet: lines[index]!.trim(), kind: "markdown-heading" }
      });
      continue;
    }
    const list = lines[index]!.match(/^\s*(?:\d+[.)]|[-*]\s+\[[ xX]\])\s+(.+?)\s*$/u);
    if (list) listItems.push({
      title: list[1]!.trim(),
      line: index + 1,
      confidence: "medium",
      evidence: { path: "SKILL.md", startLine: index + 1, endLine: index + 1, snippet: lines[index]!.trim(), kind: "markdown-list" }
    });
  }
  return headings.length >= 2 ? headings : listItems;
}

function uniqueNodeId(title: string, used: Set<string>): string {
  const ascii = title.toLocaleLowerCase("en-US").normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  const stem = `flow.${ascii || "step"}`.slice(0, 120).replace(/-+$/u, "");
  let candidate = stem;
  let sequence = 2;
  while (used.has(candidate)) candidate = `${stem.slice(0, 116)}-${sequence++}`;
  used.add(candidate);
  return candidate;
}
