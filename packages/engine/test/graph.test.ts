import { describe, expect, it } from "vitest";
import { applyGraphOperations, diffGraph, flowTargets, isSkillDocumentPath, lintGraph, type SkillGraph } from "../src/index.js";

const workflow: SkillGraph = {
  schemaVersion: "1.0",
  skillId: "skill-018f0c4a-7b6d-7a10-8c3f-123456789abc",
  capability: "workflow",
  entry: "node.start",
  nodes: [
    { id: "node.start", kind: "start", title: "开始" },
    { id: "node.step", kind: "step", title: "执行" },
    { id: "node.end", kind: "end", title: "完成" }
  ],
  edges: [
    { id: "edge.start-step", from: "node.start", to: "node.step", kind: "flow" },
    { id: "edge.step-end", from: "node.step", to: "node.end", kind: "flow" }
  ]
};

describe("graph lint", () => {
  it("accepts a valid directed workflow", () => {
    expect(lintGraph(workflow)).toEqual([]);
    expect(flowTargets(workflow, "node.step")).toEqual(["node.end"]);
  });

  it("rejects missing targets and unreachable end nodes", () => {
    const broken: SkillGraph = {
      ...workflow,
      edges: [{ id: "edge.invalid", from: "node.start", to: "node.missing", kind: "flow" }]
    };
    const codes = lintGraph(broken).map((issue) => issue.code);
    expect(codes).toContain("missing_target");
    expect(codes).toContain("end_unreachable");
  });

  it("accepts cross-platform-safe Markdown paths anywhere in the Skill project", () => {
    expect(isSkillDocumentPath("SKILL.md")).toBe(true);
    expect(isSkillDocumentPath("workflows/routing-table.md")).toBe(true);
    expect(isSkillDocumentPath("mdd-controller-rest/references/rest-patterns.md")).toBe(true);
    expect(isSkillDocumentPath("assets/deliverable-template.md")).toBe(true);
    expect(isSkillDocumentPath("../outside.md")).toBe(false);
    expect(isSkillDocumentPath("references//broken.md")).toBe(false);
    expect(isSkillDocumentPath("CON/readme.md")).toBe(false);

    const nestedDocuments: SkillGraph = {
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === "node.step" ? {
        ...node,
        doc: "workflows/routing-table.md",
        lookup: [{ queryId: "doc.routing", kind: "document.slice", path: "mdd-controller-rest/references/rest-patterns.md", anchor: "REST" }]
      } : node)
    };
    expect(lintGraph(nestedDocuments)).toEqual([]);
    expect(lintGraph({
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === "node.step" ? { ...node, doc: "../outside.md" } : node)
    }).map((issue) => issue.code)).toContain("document_path_invalid");
  });

  it("does not invent a workflow for content-only skills", () => {
    const content: SkillGraph = {
      schemaVersion: "1.0",
      skillId: workflow.skillId,
      capability: "content-only",
      nodes: [{ id: "knowledge.skill", kind: "knowledge", title: "SKILL.md" }],
      edges: []
    };
    expect(lintGraph(content)).toEqual([]);
    expect(lintGraph({ ...content, entry: "knowledge.skill" })[0]?.code).toBe("content_has_entry");
  });

  it("applies whitelisted node and edge operations and reports a stable diff", () => {
    const changed = applyGraphOperations(workflow, [
      {
        op: "graph.node.create",
        target: "node.review",
        value: { id: "node.review", kind: "gate", title: "人工确认" }
      },
      { op: "graph.edge.delete", target: "edge.step-end" },
      {
        op: "graph.edge.create",
        target: "edge.step-review",
        value: { id: "edge.step-review", from: "node.step", to: "node.review", kind: "flow" }
      },
      {
        op: "graph.edge.create",
        target: "edge.review-end",
        value: { id: "edge.review-end", from: "node.review", to: "node.end", kind: "flow" }
      }
    ]);

    expect(lintGraph(changed)).toEqual([]);
    expect(diffGraph(workflow, changed)).toEqual({
      addedNodeIds: ["node.review"],
      updatedNodeIds: [],
      removedNodeIds: [],
      addedEdgeIds: ["edge.review-end", "edge.step-review"],
      updatedEdgeIds: [],
      removedEdgeIds: ["edge.step-end"]
    });
  });

  it("refuses to delete nodes while incident edges remain", () => {
    expect(() => applyGraphOperations(workflow, [{ op: "graph.node.delete", target: "node.step" }]))
      .toThrowError(/必须先删除关联边/);
  });
});
