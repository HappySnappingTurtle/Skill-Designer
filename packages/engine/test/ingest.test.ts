import { describe, expect, it } from "vitest";
import { buildImportParseReview, importReviewGraph, type SkillGraph } from "../src/index.js";

const skillId = "skill-018f0c4a-7b6d-7a10-8c3f-123456789abc";

describe("import parse review", () => {
  it("extracts an explicit ordered workflow with evidence and a review question", () => {
    const review = buildImportParseReview({
      skillId,
      sourceDigest: "source-a",
      markdown: "# 发布助手\n\n## 流程\n\n### 收集需求\n说明。\n\n### 确认范围\n说明。\n"
    });

    expect(review.capability).toBe("workflow");
    expect(review.nodes.map((item) => item.value.title)).toEqual(["开始", "收集需求", "确认范围", "完成"]);
    expect(review.edges).toHaveLength(3);
    expect(review.nodes[1]?.evidence[0]).toMatchObject({ path: "SKILL.md", startLine: 5, kind: "markdown-heading" });
    expect(review.unresolvedQuestions[0]?.questionId).toBe("sequential-flow-assumption");
    expect(review.lint).toEqual([]);
  });

  it("recognizes a qualified quick-flow heading when it contains explicit ordered steps", () => {
    const review = buildImportParseReview({
      skillId,
      sourceDigest: "source-quick-flow",
      markdown: "# 风险研判\n\n## 快速流程\n\n1. 抓取信息\n2. 分类风险\n3. 写入结果\n"
    });

    expect(review).toMatchObject({ parserVersion: "static-v2", capability: "workflow", entry: "flow.start" });
    expect(review.nodes.map((item) => item.value.title)).toEqual(["开始", "抓取信息", "分类风险", "写入结果", "完成"]);
    expect(review.edges).toHaveLength(4);
    expect(review.lint).toEqual([]);
  });

  it("keeps an explicitly empty default-workflow section content-only", () => {
    const review = buildImportParseReview({
      skillId,
      sourceDigest: "source-empty-default-flow",
      markdown: "# 参考知识库\n\n## 默认工作流\n本 skill 无工作流，调用方直接读取参考文档。\n\n## 知识索引\n- API 文档\n- 示例代码\n"
    });

    expect(review).toMatchObject({ parserVersion: "static-v2", capability: "content-only" });
    expect(review.nodes).toHaveLength(1);
    expect(review.edges).toEqual([]);
    expect(review.unresolvedQuestions[0]?.message).toContain("未发现至少两个");
  });

  it("generates bounded deterministic IDs for long and duplicate workflow step titles", () => {
    const longTitle = `Validate ${"nested-workflow-contract-".repeat(12)}`;
    const markdown = [
      "# Complex Skill",
      "",
      "## Workflow",
      "",
      `### ${longTitle}`,
      "",
      `### ${longTitle}`,
      "",
      `### ${"超长中文步骤".repeat(40)}`,
      ""
    ].join("\n");

    const first = buildImportParseReview({ skillId, sourceDigest: "source-long", markdown });
    const second = buildImportParseReview({ skillId, sourceDigest: "source-long", markdown });
    const nodeIds = first.nodes.map((item) => item.value.id);
    const edgeIds = first.edges.map((item) => item.value.id);

    expect(first.capability).toBe("workflow");
    expect(first.lint).toEqual([]);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
    expect(nodeIds.every((id) => id.length <= 128)).toBe(true);
    expect(edgeIds.every((id) => id.length <= 128)).toBe(true);
    expect(edgeIds).toEqual(["edge.flow-1", "edge.flow-2", "edge.flow-3", "edge.flow-4"]);
    expect(second.nodes.map((item) => item.value.id)).toEqual(nodeIds);
    expect(second.edges.map((item) => item.value.id)).toEqual(edgeIds);
  });

  it("keeps ambiguous Markdown content-only instead of inventing a flow", () => {
    const review = buildImportParseReview({
      skillId,
      sourceDigest: "source-b",
      markdown: "# 知识助手\n\n## 流程\n\n1. 只有一个步骤\n"
    });

    expect(review.capability).toBe("content-only");
    expect(review.nodes).toHaveLength(1);
    expect(review.edges).toEqual([]);
    expect(review.unresolvedQuestions[0]?.message).toContain("一个步骤");
  });

  it("preserves native graph candidates with high-confidence source evidence", () => {
    const graph: SkillGraph = {
      schemaVersion: "1.0",
      skillId,
      capability: "content-only",
      nodes: [{ id: "knowledge.main", kind: "knowledge", title: "知识入口", doc: "SKILL.md" }],
      edges: []
    };
    const review = buildImportParseReview({ skillId, sourceDigest: "source-c", markdown: "# ignored", nativeGraph: graph });

    expect(review.nodes[0]).toMatchObject({ confidence: "high", decision: "accepted", manuallyEdited: false });
    expect(review.nodes[0]?.evidence[0]).toMatchObject({ path: "graph/main.json", kind: "native-graph" });
    expect(importReviewGraph(skillId, review)).toEqual(graph);
  });

  it("does not override an explicit content-only manifest with inferred Markdown workflow", () => {
    const review = buildImportParseReview({
      skillId,
      sourceDigest: "source-d",
      declaredCapability: "content-only",
      markdown: "# 内容助手\n\n## 流程\n\n### 收集\n\n### 输出\n"
    });

    expect(review.capability).toBe("content-only");
    expect(review.nodes).toHaveLength(1);
    expect(review.edges).toEqual([]);
    expect(review.nodes[0]?.evidence[0]).toMatchObject({ path: "skill.json", kind: "skill-manifest" });
  });
});
