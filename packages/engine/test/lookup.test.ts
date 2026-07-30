import { describe, expect, it } from "vitest";
import { executeProjectFactQueries, lintGraph, type SkillGraph } from "../src/index.js";

const graph: SkillGraph = {
  schemaVersion: "1.0",
  skillId: "skill-11111111-1111-4111-8111-111111111111",
  capability: "workflow",
  entry: "flow.start",
  nodes: [
    { id: "flow.start", kind: "start", title: "开始" },
    { id: "flow.review", kind: "lookup", title: "复核资料", description: "读取重试规则" },
    { id: "flow.end", kind: "end", title: "结束" }
  ],
  edges: [
    { id: "edge.start-review", from: "flow.start", to: "flow.review", kind: "flow" },
    { id: "edge.review-end", from: "flow.review", to: "flow.end", kind: "continue" }
  ]
};

const document = `# Guide

## Windows

### Retry

Windows content.

## macOS

### Retry

macOS content.

## Support

Support content.
`;

describe("declarative project fact queries", () => {
  it("queries nodes, neighborhoods and deterministic bounded search results", () => {
    const results = executeProjectFactQueries(graph, {}, [
      { queryId: "fact.node", kind: "graph.node", nodeId: "flow.review" },
      { queryId: "fact.neighbors", kind: "graph.neighborhood", nodeId: "flow.review", direction: "both" },
      { queryId: "fact.search", kind: "graph.search", text: "复核", limit: 1 },
      { queryId: "fact.empty", kind: "graph.search", text: "不存在" }
    ]);
    expect(results.map((item) => item.status)).toEqual(["found", "found", "found", "empty"]);
    expect(results[1]?.value).toMatchObject({ nodes: expect.arrayContaining([expect.objectContaining({ id: "flow.start" }), expect.objectContaining({ id: "flow.end" })]), edges: expect.any(Array) });
    expect(results[2]?.value).toMatchObject({ nodes: [expect.objectContaining({ id: "flow.review" })] });
  });

  it("distinguishes exact document paths and never silently selects an ambiguous fallback", () => {
    const results = executeProjectFactQueries(graph, { "docs/guide.md": document }, [
      { queryId: "doc.exact", kind: "document.slice", path: "docs/guide.md", anchor: "Guide/macOS/Retry" },
      { queryId: "doc.degraded", kind: "document.slice", path: "docs/guide.md", anchor: "Support", fallback: "title" },
      { queryId: "doc.ambiguous", kind: "document.slice", path: "docs/guide.md", anchor: "Retry", fallback: "title" },
      { queryId: "doc.missing", kind: "document.slice", path: "docs/missing.md", anchor: "Guide" }
    ]);
    expect(results.map((item) => item.status)).toEqual(["found", "degraded", "ambiguous", "missing"]);
    expect(results[0]?.value).toMatchObject({ heading: { path: "Guide/macOS/Retry" }, content: expect.stringContaining("macOS content") });
    expect(results[1]?.degradation).toEqual({ strategy: "title", requestedAnchor: "Support", resolvedPath: "Guide/Support" });
    expect(results[2]?.candidates?.map((item) => item.path)).toEqual(["Guide/Windows/Retry", "Guide/macOS/Retry"]);
  });

  it("lints malformed declarations before a graph can be confirmed", () => {
    const broken: SkillGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "flow.review" ? {
        ...node,
        lookup: [
          { queryId: "fact.valid", kind: "graph.search", text: "" },
          { queryId: "fact.valid", kind: "document.slice", path: "../secret.md", anchor: "Secret" },
          { queryId: "doc.empty-segment", kind: "document.slice", path: "docs//secret.md", anchor: "Secret" }
        ]
      } : node)
    };
    expect(lintGraph(broken).map((item) => item.code)).toEqual(expect.arrayContaining([
      "lookup_text_invalid", "lookup_id_duplicate", "lookup_document_path_invalid"
    ]));
    expect(lintGraph(broken).filter((item) => item.code === "lookup_document_path_invalid")).toHaveLength(2);
  });
});
