import { describe, expect, it } from "vitest";
import {
  graphEdgeTypeRegistry,
  graphNodeTypeRegistry,
  isGraphEdgeKind,
  isGraphNodeKind,
  isStableId,
  lintGraph,
  validateCreateManagedSkillInput,
  validateCreateWorkspaceInput
} from "../src/index.js";

describe("workspace schema", () => {
  it("normalizes a valid workspace name", () => {
    expect(validateCreateWorkspaceInput({ name: "  产品研发  " })).toEqual({
      ok: true,
      value: { name: "产品研发" }
    });
  });

  it("rejects empty and reserved names", () => {
    expect(validateCreateWorkspaceInput({ name: "" }).ok).toBe(false);
    expect(validateCreateWorkspaceInput({ name: "CON" }).ok).toBe(false);
  });
});

describe("skill schema", () => {
  it("accepts workflow and content-only capabilities", () => {
    expect(validateCreateManagedSkillInput({ name: "发布流程", capability: "workflow" }).ok).toBe(true);
    expect(validateCreateManagedSkillInput({ name: "术语库", capability: "content-only" }).ok).toBe(true);
  });

  it("rejects an unknown capability", () => {
    expect(validateCreateManagedSkillInput({ name: "错误类型", capability: "agent" }).ok).toBe(false);
  });

  it("recognizes namespaced stable ids", () => {
    expect(isStableId("skill-018f0c4a-7b6d-7a10-8c3f-123456789abc", "skill")).toBe(true);
    expect(isStableId("same-name", "skill")).toBe(false);
  });
});

describe("graph type registry", () => {
  it("keeps node and edge kinds unique and recognizes every registered kind", () => {
    const nodeKinds = graphNodeTypeRegistry.map((item) => item.kind);
    const edgeKinds = graphEdgeTypeRegistry.map((item) => item.kind);

    expect(new Set(nodeKinds).size).toBe(nodeKinds.length);
    expect(new Set(edgeKinds).size).toBe(edgeKinds.length);
    expect(nodeKinds.every(isGraphNodeKind)).toBe(true);
    expect(edgeKinds.every(isGraphEdgeKind)).toBe(true);
    expect(isGraphNodeKind("future-node")).toBe(false);
    expect(isGraphEdgeKind("future-edge")).toBe(false);
  });

  it("declares runtime and knowledge behavior explicitly instead of inferring it from names", () => {
    expect(graphNodeTypeRegistry.find((item) => item.kind === "start")).toMatchObject({ plane: "flow", runtimeRole: "entry" });
    expect(graphNodeTypeRegistry.find((item) => item.kind === "end")).toMatchObject({ plane: "flow", runtimeRole: "completion" });
    expect(graphNodeTypeRegistry.find((item) => item.kind === "knowledge")).toMatchObject({ plane: "knowledge", runtimeRole: "none" });
    expect(graphEdgeTypeRegistry.find((item) => item.kind === "knowledge")).toMatchObject({ plane: "knowledge", executable: false, directional: false });
    expect(graphEdgeTypeRegistry.filter((item) => item.plane === "flow").every((item) => item.executable && item.directional)).toBe(true);
  });

  it("blocks unregistered kinds instead of giving unknown fields execution semantics", () => {
    const issues = lintGraph({
      schemaVersion: "1.0",
      skillId: "skill-018f0c4a-7b6d-7a10-8c3f-123456789abc",
      capability: "workflow",
      entry: "flow.start",
      nodes: [
        { id: "flow.start", kind: "start", title: "开始" },
        { id: "flow.future", kind: "future-node" as never, title: "未来节点", extensions: { runtimeRole: "step" } },
        { id: "flow.end", kind: "end", title: "结束" }
      ],
      edges: [
        { id: "edge.start-future", from: "flow.start", to: "flow.future", kind: "future-edge" as never, extensions: { executable: true } },
        { id: "edge.future-end", from: "flow.future", to: "flow.end", kind: "flow" }
      ]
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "nodes[1].kind", code: "unknown_node_kind", severity: "error" }),
      expect.objectContaining({ path: "edges[0].kind", code: "unknown_edge_kind", severity: "error" })
    ]));
  });
});
