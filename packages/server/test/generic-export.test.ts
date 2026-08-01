import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { genericEngineCli, genericEngineUsage } from "../src/generic-export.js";

const execFileAsync = promisify(execFile);
let root: string;
let cli: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-generic-cli-"));
  cli = path.join(root, "engine", "skill-engine.mjs");
  await mkdir(path.join(root, "engine"), { recursive: true });
  await mkdir(path.join(root, "graph"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "skill.json"), JSON.stringify({ skillId: "skill-11111111-1111-4111-8111-111111111111", name: "条件流程" }));
  await writeFile(path.join(root, "graph", "main.json"), JSON.stringify({
    schemaVersion: "1.0",
    skillId: "skill-11111111-1111-4111-8111-111111111111",
    capability: "workflow",
    entry: "flow.start",
    nodes: [
      { id: "flow.start", kind: "start", title: "开始" },
      { id: "flow.approved", kind: "end", title: "通过" },
      { id: "flow.rejected", kind: "end", title: "拒绝" }
    ],
    edges: [
      {
        id: "edge.approved",
        from: "flow.start",
        to: "flow.approved",
        kind: "flow",
        condition: {
          op: "and",
          conditions: [
            { op: "equals", left: { kind: "ref", path: "skill.approved" }, right: { kind: "literal", value: true } },
            { op: "equals", left: { kind: "ref", path: "runtime.step" }, right: { kind: "literal", value: 0 } }
          ]
        }
      },
      { id: "edge.rejected", from: "flow.start", to: "flow.rejected", kind: "flow", condition: { op: "notEquals", left: { kind: "ref", path: "skill.approved" }, right: { kind: "literal", value: true } } }
    ]
  }));
  await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n\nIntegrity fixture.\n");
  await writeFile(cli, genericEngineCli());
  await writeFile(path.join(root, "engine", "README.md"), genericEngineUsage());
  const packageFiles = await Promise.all(["skill.json", "graph/main.json", "docs/guide.md", "engine/skill-engine.mjs", "engine/README.md"].map(async (relativePath) => {
    const bytes = await readFile(path.join(root, relativePath));
    return { path: relativePath, size: bytes.length, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  }));
  await writeFile(path.join(root, "export-manifest.json"), JSON.stringify({
    schemaVersion: "1.0",
    profile: "generic/1",
    skillId: "skill-11111111-1111-4111-8111-111111111111",
    revisionId: "revision-11111111-1111-4111-8111-111111111111",
    contentHash: "sha256:" + "1".repeat(64),
    files: packageFiles
  }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("genericEngineCli", () => {
  it("documents that rejected transitions persist Trace without moving the run", () => {
    const usage = genericEngineUsage();
    expect(usage).toContain("keeps the current node, step, and variables unchanged");
    expect(usage).toContain("persisting an `engine.reject` Trace event");
    expect(usage).not.toContain("without modifying the state file");
  });

  it("verifies every declared package file and reports tampered or missing assets", async () => {
    const verified = JSON.parse((await execFileAsync(process.execPath, [cli, "verify"])).stdout) as { valid: boolean; checkedFiles: number };
    expect(verified).toMatchObject({ valid: true, checkedFiles: 5 });

    const guide = path.join(root, "docs", "guide.md");
    await writeFile(guide, "tampered\n");
    await expect(execFileAsync(process.execPath, [cli, "verify"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/"code":"package_integrity_failed".*"path":"docs\/guide\.md".*"code":"mismatch"/u)
    });

    await writeFile(guide, "# Guide\n\nIntegrity fixture.\n");
    await rm(path.join(root, "engine", "README.md"));
    await expect(execFileAsync(process.execPath, [cli, "verify"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/"code":"package_integrity_failed".*"path":"engine\/README\.md".*"code":"missing"/u)
    });
  });

  it("evaluates conditions and records a rejected target without moving the run", async () => {
    const approvedTransitions = JSON.parse((await execFileAsync(process.execPath, [cli, "transitions", "flow.start", "--variables", JSON.stringify({ approved: true })])).stdout) as Array<{ to: string }>;
    expect(approvedTransitions.map((item) => item.to)).toEqual(["flow.approved"]);
    const transitions = JSON.parse((await execFileAsync(process.execPath, [cli, "transitions", "flow.start", "--variables", JSON.stringify({ approved: false })])).stdout) as Array<{ to: string }>;
    expect(transitions.map((item) => item.to)).toEqual(["flow.rejected"]);

    const stateFile = path.join(root, "private", "run.json");
    await execFileAsync(process.execPath, [cli, "run", "start", "--state", stateFile, "--variables", JSON.stringify({ approved: false })]);
    const rejected = JSON.parse((await execFileAsync(process.execPath, [cli, "run", "next", "--state", stateFile, "--to", "flow.approved"])).stdout) as {
      status: string; state: { currentNodeId: string; step: number }; newEvents: Array<{ type: string }>;
    };
    expect(rejected).toMatchObject({ status: "rejected", state: { currentNodeId: "flow.start", step: 0 }, newEvents: [{ type: "engine.reject" }] });

    const completed = JSON.parse((await execFileAsync(process.execPath, [cli, "run", "next", "--state", stateFile, "--to", "flow.rejected"])).stdout) as {
      status: string; state: { status: string; currentNodeId: string; step: number; events: Array<{ seq: number }> };
    };
    expect(completed).toMatchObject({ status: "done", state: { status: "completed", currentNodeId: "flow.rejected", step: 1 } });
    expect(completed.state.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects a damaged exported graph before any command runs", async () => {
    const graphPath = path.join(root, "graph", "main.json");
    const graph = JSON.parse(await readFile(graphPath, "utf8")) as { edges: Array<{ condition?: unknown }> };
    graph.edges[0]!.condition = {
      op: "equals",
      left: { kind: "ref", path: "skill.__proto__.approved" },
      right: { kind: "literal", value: true }
    };
    await writeFile(graphPath, JSON.stringify(graph), "utf8");
    await expect(execFileAsync(process.execPath, [cli, "inspect"])).rejects.toMatchObject({
      stderr: expect.stringContaining('"code":"invalid_condition_operand"')
    });
  });
});
