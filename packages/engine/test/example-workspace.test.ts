import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintGraph } from "../src/graph.js";
import type { SkillCapability, SkillGraph, SkillManifest } from "../src/types.js";

interface ExampleWorkspace {
  schemaVersion: "1.0";
  name: string;
  members: Array<{ relativePath: string; skillId: string; capability: SkillCapability }>;
}

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/multi-skill-workspace");

describe("multi-Skill example workspace", () => {
  it("contains one valid workflow and one valid content-only project", async () => {
    const descriptor = await readJson<ExampleWorkspace>(path.join(fixtureRoot, "example-workspace.json"));
    expect(descriptor.schemaVersion).toBe("1.0");
    expect(descriptor.members.map((member) => member.capability).sort()).toEqual(["content-only", "workflow"]);
    expect(new Set(descriptor.members.map((member) => member.skillId)).size).toBe(descriptor.members.length);

    for (const member of descriptor.members) {
      const root = path.resolve(fixtureRoot, member.relativePath);
      expect(root.startsWith(`${fixtureRoot}${path.sep}`)).toBe(true);
      const [manifest, graph] = await Promise.all([
        readJson<SkillManifest>(path.join(root, "skill.json")),
        readJson<SkillGraph>(path.join(root, "graph/main.json"))
      ]);
      expect(manifest.skillId).toBe(member.skillId);
      expect(graph.skillId).toBe(member.skillId);
      expect(manifest.capability).toBe(member.capability);
      expect(graph.capability).toBe(member.capability);
      expect(lintGraph(graph).filter((issue) => issue.severity === "error")).toEqual([]);
      if (member.capability === "workflow") {
        expect(graph.vendorGraphMetadata).toEqual({ source: "example", preserve: true });
        expect(graph.nodes.find((node) => node.id === "flow.checklist")?.vendorNodeMetadata).toEqual({ owner: "release-team", priority: 2 });
        expect(graph.edges.find((edge) => edge.id === "edge.decision-end")?.vendorEdgeMetadata).toEqual({ audit: true });
      }
      await access(path.join(root, "SKILL.md"));
      await Promise.all(graph.nodes.filter((node) => node.doc).map((node) => access(path.join(root, node.doc!))));
    }
  });
});

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
