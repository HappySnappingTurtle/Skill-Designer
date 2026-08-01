import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { WorkspaceStore } from "../src/store.js";

interface FingerprintVector {
  schemaVersion: "1.0";
  initialVariables: Record<string, unknown>;
  expected: {
    projectContentHash: string;
    inputHash: string;
    value: string;
  };
}

it("matches the fixed RuntimeArtifact fingerprint vector on every operating system", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-artifact-fingerprint-"));
  try {
    const vector = JSON.parse(await readFile(new URL("./fixtures/runtime-artifact-fingerprint.json", import.meta.url), "utf8")) as FingerprintVector;
    let sequence = 1;
    const store = new WorkspaceStore({
      dataDir: root,
      now: () => new Date("2026-07-27T08:00:00.000Z"),
      idFactory: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`
    });
    await store.initialize();
    const workspace = await store.createWorkspace({ name: "指纹向量" });
    const detail = await store.createManagedSkill(workspace.workspaceId, { name: "指纹向量 Skill", capability: "workflow" });
    const member = detail.members[0]!;
    const run = await store.createRun(member.projectId, {
      workspaceId: workspace.workspaceId,
      initialVariables: vector.initialVariables
    });

    expect(run.artifact?.contentHash).toBe(vector.expected.projectContentHash);
    expect(run.artifact?.fingerprint).toEqual({
      schemaVersion: "1.0",
      algorithm: "sha256",
      projectContentHash: vector.expected.projectContentHash,
      inputHash: vector.expected.inputHash,
      value: vector.expected.value
    });
    const reordered = await store.createRun(member.projectId, {
      workspaceId: workspace.workspaceId,
      initialVariables: {
        count: 3,
        enabled: true,
        lines: "第一行\r\n第二行",
        nested: { a: 1, z: 2 },
        title: "跨系统指纹"
      }
    });
    expect(reordered.artifact?.fingerprint.value).toBe(vector.expected.value);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
