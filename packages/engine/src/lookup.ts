import { sliceDocument } from "./document.js";
import type { GraphEdge, GraphNode, ProjectFactQuery, ProjectFactQueryResult, SkillGraph } from "./types.js";

export function executeProjectFactQueries(
  graph: SkillGraph,
  documents: Readonly<Record<string, string>>,
  queries: readonly ProjectFactQuery[]
): ProjectFactQueryResult[] {
  return queries.map((query) => executeQuery(graph, documents, query));
}

function executeQuery(graph: SkillGraph, documents: Readonly<Record<string, string>>, query: ProjectFactQuery): ProjectFactQueryResult {
  if (query.kind === "graph.node") {
    const node = graph.nodes.find((item) => item.id === query.nodeId);
    return node
      ? result(query, "found", { node: cloneNode(node) })
      : failure(query, "missing", `节点 ${query.nodeId} 不存在`);
  }

  if (query.kind === "graph.neighborhood") {
    const center = graph.nodes.find((item) => item.id === query.nodeId);
    if (!center) return failure(query, "missing", `中心节点 ${query.nodeId} 不存在`);
    const edgeKindSet = query.edgeKinds?.length ? new Set(query.edgeKinds) : null;
    const edges = graph.edges.filter((edge) => {
      if (edgeKindSet && !edgeKindSet.has(edge.kind)) return false;
      if (query.direction === "in") return edge.to === query.nodeId;
      if (query.direction === "out") return edge.from === query.nodeId;
      return edge.from === query.nodeId || edge.to === query.nodeId;
    });
    const nodeIds = new Set([query.nodeId]);
    for (const edge of edges) { nodeIds.add(edge.from); nodeIds.add(edge.to); }
    return result(query, edges.length ? "found" : "empty", {
      center: cloneNode(center),
      nodes: graph.nodes.filter((node) => nodeIds.has(node.id)).map(cloneNode),
      edges: edges.map(cloneEdge)
    }, edges.length ? undefined : "查询成功，但中心节点没有符合条件的关系");
  }

  if (query.kind === "graph.search") {
    const key = normalize(query.text);
    const kinds = query.nodeKinds?.length ? new Set(query.nodeKinds) : null;
    const limit = Math.min(20, Math.max(1, query.limit ?? 10));
    const nodes = graph.nodes
      .filter((node) => !kinds || kinds.has(node.kind))
      .filter((node) => [node.id, node.title, node.description ?? ""].some((value) => normalize(value).includes(key)))
      .slice(0, limit)
      .map(cloneNode);
    return result(query, nodes.length ? "found" : "empty", { nodes }, nodes.length ? undefined : "查询成功，但没有匹配节点");
  }

  const markdown = documents[query.path];
  if (markdown === undefined) return failure(query, "missing", `文档 ${query.path} 不存在于冻结 revision`);
  const exact = sliceDocument(markdown, query.anchor, false);
  if (exact.status === "found" || exact.status === "whole-document") {
    return result(query, "found", documentValue(query.path, exact));
  }
  if (exact.status === "ambiguous") {
    return { ...failure(query, "ambiguous", `精确引用 ${query.anchor} 匹配到多个标题`), candidates: exact.candidates };
  }
  if (query.fallback !== "title") return failure(query, "missing", `未找到文档片段 ${query.path}#${query.anchor}`);

  const fallback = sliceDocument(markdown, query.anchor, true);
  if (fallback.status === "ambiguous") {
    return { ...failure(query, "ambiguous", `标题降级匹配 ${query.anchor} 不唯一`), candidates: fallback.candidates };
  }
  if (fallback.status !== "found") return failure(query, "missing", `标题降级仍未找到 ${query.path}#${query.anchor}`);
  return {
    ...result(query, "degraded", documentValue(query.path, fallback), "精确标题路径未命中，已按显式标题降级匹配"),
    degradation: { strategy: "title", requestedAnchor: query.anchor, resolvedPath: fallback.slice!.heading.path }
  };
}

function result(query: ProjectFactQuery, status: ProjectFactQueryResult["status"], value: unknown, diagnostic?: string): ProjectFactQueryResult {
  return { queryId: query.queryId, kind: query.kind, status, value: structuredClone(value), ...(diagnostic ? { diagnostic } : {}) };
}

function failure(query: ProjectFactQuery, status: "missing" | "ambiguous", diagnostic: string): ProjectFactQueryResult {
  return { queryId: query.queryId, kind: query.kind, status, diagnostic };
}

function documentValue(path: string, sliced: ReturnType<typeof sliceDocument>): unknown {
  return {
    path,
    query: sliced.query,
    heading: sliced.slice?.heading ?? null,
    content: sliced.slice?.content ?? sliced.content ?? ""
  };
}

function cloneNode(node: GraphNode): GraphNode {
  const { lookup: _lookup, ...fact } = node;
  return structuredClone(fact);
}
function cloneEdge(edge: GraphEdge): GraphEdge { return structuredClone(edge); }
function normalize(value: string): string { return value.trim().normalize("NFC").toLocaleLowerCase("zh-CN"); }
