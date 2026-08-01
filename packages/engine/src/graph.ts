import type {
  GraphEdge,
  GraphEdgeKind,
  GraphChangeOperation,
  GraphDiffSummary,
  GraphLintIssue,
  GraphNode,
  GraphNodeKind,
  SkillGraph
} from "./types.js";
import { graphEdgeTypeRegistry, graphNodeTypeRegistry } from "./types.js";
import { validateCondition } from "./condition.js";

const NODE_KINDS = new Set<GraphNodeKind>(graphNodeTypeRegistry.map((item) => item.kind));
const EDGE_KINDS = new Set<GraphEdgeKind>(graphEdgeTypeRegistry.map((item) => item.kind));
const ID_PATTERN = /^[a-z][a-z0-9._-]{1,127}$/i;
const QUERY_KINDS = new Set(["graph.node", "graph.neighborhood", "graph.search", "document.slice"]);

export function isSkillDocumentPath(value: string): boolean {
  if (!value || value !== value.normalize("NFC") || value.length > 500 || value.includes("\\") || value.startsWith("/")) return false;
  const segments = value.split("/");
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  return value.toLowerCase().endsWith(".md") && pathIsNormalized(value) && segments.every((segment) =>
    Boolean(segment) && segment !== "." && segment !== ".." &&
    !/[\u0000-\u001f<>:"|?*]/u.test(segment) && !/[. ]$/u.test(segment) && !reserved.test(segment)
  );
}

function pathIsNormalized(value: string): boolean {
  const normalized: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") normalized.pop();
    else normalized.push(segment);
  }
  return normalized.join("/") === value;
}

export function lintGraph(graph: SkillGraph): GraphLintIssue[] {
  const issues: GraphLintIssue[] = [];
  const nodes = new Map<string, GraphNode>();
  const edges = new Set<string>();

  if (graph.schemaVersion !== "1.0") error(issues, "schemaVersion", "unsupported_version", "仅支持图 Schema 1.0");
  if (!graph.skillId.startsWith("skill-")) error(issues, "skillId", "invalid_skill_id", "图缺少稳定 skillId");
  if (graph.capability !== "workflow" && graph.capability !== "content-only") {
    error(issues, "capability", "invalid_capability", "图 capability 无效");
  }
  if (!Array.isArray(graph.nodes)) error(issues, "nodes", "invalid_nodes", "nodes 必须是数组");
  if (!Array.isArray(graph.edges)) error(issues, "edges", "invalid_edges", "edges 必须是数组");
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return issues;

  graph.nodes.forEach((node, index) => {
    const nodePath = `nodes[${index}]`;
    if (!ID_PATTERN.test(node.id)) error(issues, `${nodePath}.id`, "invalid_node_id", "节点 ID 格式无效");
    if (nodes.has(node.id)) error(issues, `${nodePath}.id`, "duplicate_node_id", "节点 ID 重复");
    else nodes.set(node.id, node);
    if (!NODE_KINDS.has(node.kind)) error(issues, `${nodePath}.kind`, "unknown_node_kind", "节点类型未注册");
    if (!node.title.trim()) error(issues, `${nodePath}.title`, "required", "节点标题不能为空");
    if (node.doc !== undefined && (typeof node.doc !== "string" || !isSkillDocumentPath(node.doc))) {
      error(issues, `${nodePath}.doc`, "document_path_invalid", "节点文档必须是项目内安全的 Markdown 相对路径");
    }
    lintNodeLookups(node, nodePath, issues);
  });

  graph.edges.forEach((edge, index) => {
    const edgePath = `edges[${index}]`;
    if (!ID_PATTERN.test(edge.id)) error(issues, `${edgePath}.id`, "invalid_edge_id", "边 ID 格式无效");
    if (edges.has(edge.id)) error(issues, `${edgePath}.id`, "duplicate_edge_id", "边 ID 重复");
    else edges.add(edge.id);
    if (!EDGE_KINDS.has(edge.kind)) error(issues, `${edgePath}.kind`, "unknown_edge_kind", "边类型未注册");
    if (!nodes.has(edge.from)) error(issues, `${edgePath}.from`, "missing_source", "边的起点不存在");
    if (!nodes.has(edge.to)) error(issues, `${edgePath}.to`, "missing_target", "边的终点不存在");
    if (edge.from === edge.to) warning(issues, edgePath, "self_loop", "边指向自身");
    if (edge.condition !== undefined) {
      for (const issue of validateCondition(edge.condition, `${edgePath}.condition`)) {
        error(issues, issue.path, issue.code, issue.message);
      }
    }
  });

  if (graph.capability === "content-only") {
    if (graph.entry) error(issues, "entry", "content_has_entry", "内容型 Skill 不能声明流程入口");
    graph.nodes.forEach((node, index) => {
      if (node.kind !== "knowledge") {
        error(issues, `nodes[${index}].kind`, "content_executable_node", "内容型 Skill 不能包含可执行节点");
      }
    });
    graph.edges.forEach((edge, index) => {
      if (edge.kind !== "knowledge") {
        error(issues, `edges[${index}].kind`, "content_flow_edge", "内容型 Skill 不能包含流程边");
      }
    });
    return issues;
  }

  if (!graph.entry) {
    error(issues, "entry", "entry_required", "工作流 Skill 必须声明入口");
    return issues;
  }
  const entry = nodes.get(graph.entry);
  if (!entry) error(issues, "entry", "entry_missing", "入口节点不存在");
  else if (entry.kind !== "start") error(issues, "entry", "entry_not_start", "入口节点类型必须是 start");

  const ends = graph.nodes.filter((node) => node.kind === "end");
  if (!ends.length) error(issues, "nodes", "end_required", "工作流至少需要一个 end 节点");

  if (entry) {
    const reachable = reachableFlowNodes(entry.id, graph.edges);
    for (const node of graph.nodes) {
      if (node.kind !== "knowledge" && !reachable.has(node.id)) {
        warning(issues, `nodes.${node.id}`, "unreachable_node", "节点无法从入口到达");
      }
    }
    if (!ends.some((node) => reachable.has(node.id))) {
      error(issues, "edges", "end_unreachable", "没有可从入口到达的 end 节点");
    }
  }

  return issues;
}

function lintNodeLookups(node: GraphNode, nodePath: string, issues: GraphLintIssue[]): void {
  if (node.lookup === undefined) return;
  if (!Array.isArray(node.lookup)) {
    error(issues, `${nodePath}.lookup`, "lookup_invalid", "lookup 必须是查询数组");
    return;
  }
  if (node.lookup.length > 20) error(issues, `${nodePath}.lookup`, "lookup_limit", "单个节点最多声明 20 个查询");
  const ids = new Set<string>();
  node.lookup.forEach((query, index) => {
    const queryPath = `${nodePath}.lookup[${index}]`;
    if (!query || typeof query !== "object" || Array.isArray(query)) {
      error(issues, queryPath, "lookup_invalid", "查询必须是对象");
      return;
    }
    const candidate = query as unknown as Record<string, unknown>;
    if (typeof candidate.queryId !== "string" || !ID_PATTERN.test(candidate.queryId)) error(issues, `${queryPath}.queryId`, "lookup_id_invalid", "查询 ID 格式无效");
    else if (ids.has(candidate.queryId)) error(issues, `${queryPath}.queryId`, "lookup_id_duplicate", "节点内查询 ID 重复");
    else ids.add(candidate.queryId);
    if (typeof candidate.kind !== "string" || !QUERY_KINDS.has(candidate.kind)) {
      error(issues, `${queryPath}.kind`, "lookup_kind_invalid", "查询类型未注册");
      return;
    }
    if (candidate.kind === "graph.node") {
      if (typeof candidate.nodeId !== "string" || !ID_PATTERN.test(candidate.nodeId)) error(issues, `${queryPath}.nodeId`, "lookup_node_id_invalid", "节点查询需要有效 nodeId");
    } else if (candidate.kind === "graph.neighborhood") {
      if (typeof candidate.nodeId !== "string" || !ID_PATTERN.test(candidate.nodeId)) error(issues, `${queryPath}.nodeId`, "lookup_node_id_invalid", "邻域查询需要有效 nodeId");
      if (candidate.direction !== "in" && candidate.direction !== "out" && candidate.direction !== "both") error(issues, `${queryPath}.direction`, "lookup_direction_invalid", "邻域方向无效");
      if (candidate.edgeKinds !== undefined && (!Array.isArray(candidate.edgeKinds) || candidate.edgeKinds.some((kind) => typeof kind !== "string" || !EDGE_KINDS.has(kind as GraphEdgeKind)))) error(issues, `${queryPath}.edgeKinds`, "lookup_edge_kinds_invalid", "关系类型过滤无效");
    } else if (candidate.kind === "graph.search") {
      if (typeof candidate.text !== "string" || !candidate.text.trim() || candidate.text.length > 200) error(issues, `${queryPath}.text`, "lookup_text_invalid", "搜索文本必须为 1 到 200 个字符");
      if (candidate.limit !== undefined && (!Number.isInteger(candidate.limit) || Number(candidate.limit) < 1 || Number(candidate.limit) > 20)) error(issues, `${queryPath}.limit`, "lookup_limit_invalid", "搜索上限必须为 1 到 20");
      if (candidate.nodeKinds !== undefined && (!Array.isArray(candidate.nodeKinds) || candidate.nodeKinds.some((kind) => typeof kind !== "string" || !NODE_KINDS.has(kind as GraphNodeKind)))) error(issues, `${queryPath}.nodeKinds`, "lookup_node_kinds_invalid", "节点类型过滤无效");
    } else {
      if (typeof candidate.path !== "string" || !isSkillDocumentPath(candidate.path)) error(issues, `${queryPath}.path`, "lookup_document_path_invalid", "文档查询路径必须是项目内安全的 Markdown 相对路径");
      if (typeof candidate.anchor !== "string" || !candidate.anchor.trim() || candidate.anchor.length > 500) error(issues, `${queryPath}.anchor`, "lookup_anchor_invalid", "文档查询需要精确标题路径或锚点");
      if (candidate.fallback !== undefined && candidate.fallback !== "none" && candidate.fallback !== "title") error(issues, `${queryPath}.fallback`, "lookup_fallback_invalid", "文档降级策略无效");
    }
  });
}

export function flowTargets(graph: SkillGraph, currentNodeId: string): string[] {
  return graph.edges
    .filter((edge) => edge.from === currentNodeId && edge.kind !== "knowledge")
    .map((edge) => edge.to);
}

export class GraphOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly target: string
  ) {
    super(message);
    this.name = "GraphOperationError";
  }
}

export function applyGraphOperations(graph: SkillGraph, operations: GraphChangeOperation[]): SkillGraph {
  const next: SkillGraph = structuredClone(graph);

  for (const operation of operations) {
    if (operation.op === "graph.node.create") {
      assertMatchingTarget(operation.target, operation.value.id);
      if (next.nodes.some((node) => node.id === operation.target)) {
        throw new GraphOperationError("node_exists", "节点已经存在", operation.target);
      }
      next.nodes.push(structuredClone(operation.value));
      continue;
    }
    if (operation.op === "graph.node.update") {
      assertMatchingTarget(operation.target, operation.value.id);
      const index = next.nodes.findIndex((node) => node.id === operation.target);
      if (index < 0) throw new GraphOperationError("node_missing", "要修改的节点不存在", operation.target);
      next.nodes[index] = structuredClone(operation.value);
      continue;
    }
    if (operation.op === "graph.node.delete") {
      const index = next.nodes.findIndex((node) => node.id === operation.target);
      if (index < 0) throw new GraphOperationError("node_missing", "要删除的节点不存在", operation.target);
      if (next.edges.some((edge) => edge.from === operation.target || edge.to === operation.target)) {
        throw new GraphOperationError("node_has_edges", "删除节点前必须先删除关联边", operation.target);
      }
      next.nodes.splice(index, 1);
      continue;
    }
    if (operation.op === "graph.edge.create") {
      assertMatchingTarget(operation.target, operation.value.id);
      if (next.edges.some((edge) => edge.id === operation.target)) {
        throw new GraphOperationError("edge_exists", "边已经存在", operation.target);
      }
      next.edges.push(structuredClone(operation.value));
      continue;
    }
    if (operation.op === "graph.edge.update") {
      assertMatchingTarget(operation.target, operation.value.id);
      const index = next.edges.findIndex((edge) => edge.id === operation.target);
      if (index < 0) throw new GraphOperationError("edge_missing", "要修改的边不存在", operation.target);
      next.edges[index] = structuredClone(operation.value);
      continue;
    }
    const index = next.edges.findIndex((edge) => edge.id === operation.target);
    if (index < 0) throw new GraphOperationError("edge_missing", "要删除的边不存在", operation.target);
    next.edges.splice(index, 1);
  }

  return next;
}

export function diffGraph(before: SkillGraph, after: SkillGraph): GraphDiffSummary {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  return {
    addedNodeIds: addedIds(beforeNodes, afterNodes),
    updatedNodeIds: updatedIds(beforeNodes, afterNodes),
    removedNodeIds: addedIds(afterNodes, beforeNodes),
    addedEdgeIds: addedIds(beforeEdges, afterEdges),
    updatedEdgeIds: updatedIds(beforeEdges, afterEdges),
    removedEdgeIds: addedIds(afterEdges, beforeEdges)
  };
}

function assertMatchingTarget(target: string, valueId: string): void {
  if (target !== valueId) throw new GraphOperationError("target_mismatch", "操作目标与对象 ID 不一致", target);
}

function addedIds<T>(before: Map<string, T>, after: Map<string, T>): string[] {
  return [...after.keys()].filter((id) => !before.has(id)).sort();
}

function updatedIds<T>(before: Map<string, T>, after: Map<string, T>): string[] {
  return [...after.entries()]
    .filter(([id, value]) => before.has(id) && JSON.stringify(before.get(id)) !== JSON.stringify(value))
    .map(([id]) => id)
    .sort();
}

function reachableFlowNodes(entry: string, edges: GraphEdge[]): Set<string> {
  const reached = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.from !== current || edge.kind === "knowledge" || reached.has(edge.to)) continue;
      reached.add(edge.to);
      queue.push(edge.to);
    }
  }
  return reached;
}

function error(issues: GraphLintIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message, severity: "error" });
}

function warning(issues: GraphLintIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message, severity: "warning" });
}
