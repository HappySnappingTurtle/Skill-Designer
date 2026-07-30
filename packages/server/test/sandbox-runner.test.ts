import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultSandboxPolicy,
  type BenchmarkCase,
  type RuntimeArtifact,
  type SandboxCapabilityReport
} from "@skill-designer/engine";
import {
  DockerDesktopSandboxRunner,
  type DockerLifecycleExecutor,
  type DockerProcessResult
} from "../src/sandbox-runner.js";

const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const image = `example/skill-runner@sha256:${"b".repeat(64)}`;
let root: string;
let snapshotRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-sandbox-"));
  snapshotRoot = path.join(root, "snapshot");
  await mkdir(path.join(snapshotRoot, "docs"), { recursive: true });
  await writeFile(path.join(snapshotRoot, "SKILL.md"), "# Frozen\n");
  await writeFile(path.join(snapshotRoot, "docs", "guide.md"), "original\n");
});

afterEach(async () => {
  await restoreWritePermissions(root);
  await rm(root, { recursive: true, force: true });
});

describe("DockerDesktopSandboxRunner", () => {
  it("copies a frozen input, executes a strict plan, collects regular artifacts, and preserves the source", async () => {
    const executor = new FakeDockerExecutor(async (args) => {
      const output = mountSource(args, "/workspace/output");
      await writeFile(path.join(output, "result.json"), '{"ok":true}\n');
      return { exitCode: 0, stdout: Buffer.from("done\n"), stderr: Buffer.alloc(0) };
    });
    const runner = createRunner(executor);
    const handle = await runner.prepare(prepareInput(), defaultSandboxPolicy());
    expect(handle.state).toBe("prepared");

    const events = [];
    for await (const event of runner.run(handle, { image, command: { executable: "node", args: ["runner.mjs"] } }, new AbortController().signal)) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["sandbox.started", "sandbox.stdout", "sandbox.completed"]);
    expect(executor.runArgs).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "65532:65532"]));
    expect(mountSource(executor.runArgs, "/workspace/input")).not.toBe(snapshotRoot);
    expect(await readFile(path.join(snapshotRoot, "docs", "guide.md"), "utf8")).toBe("original\n");

    const collected = await runner.collect(handle);
    expect(collected.artifacts).toEqual([expect.objectContaining({ path: "result.json", size: 12, sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) })]);
    expect(collected.auditEvents.at(-1)?.type).toBe("sandbox.collected");
    const copiedInput = mountSource(executor.runArgs, "/workspace/input");
    const runRoot = path.dirname(copiedInput);
    await runner.cleanup(handle);
    await expect(stat(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await runner.getStatus(handle.handleId)).handle.state).toBe("cleaned");
  });

  it("rejects commands outside the policy before Docker starts", async () => {
    const executor = new FakeDockerExecutor(async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    const runner = createRunner(executor);
    const handle = await runner.prepare(prepareInput(), defaultSandboxPolicy());
    await expect(async () => {
      for await (const event of runner.run(handle, { image, command: { executable: "sh", args: ["-c", "id"] } }, new AbortController().signal)) void event;
    }).rejects.toThrow(/允许列表/u);
    expect(executor.runArgs).toEqual([]);
  });

  it("force-removes a running container on cancellation and leaves an audit record", async () => {
    let finish: ((result: DockerProcessResult) => void) | undefined;
    const executor = new FakeDockerExecutor(() => new Promise((resolve) => { finish = resolve; }));
    executor.onExec = async (args) => {
      if (args.includes("rm")) {
        finish?.({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
        return "removed";
      }
      throw new Error("No such container");
    };
    const runner = createRunner(executor);
    const handle = await runner.prepare(prepareInput(), defaultSandboxPolicy());
    const consume = (async () => {
      const events = [];
      for await (const event of runner.run(handle, { image, command: { executable: "node", args: ["runner.mjs"] } }, new AbortController().signal)) events.push(event);
      return events;
    })();
    await waitFor(() => executor.runArgs.length > 0);
    await runner.cancel(handle);
    const events = await consume;
    expect(events.map((event) => event.type)).toEqual(["sandbox.started", "sandbox.cancelled"]);
    expect(executor.execCalls).toEqual([
      expect.arrayContaining(["rm", "-f"]),
      expect.arrayContaining(["inspect"])
    ]);
    const status = await runner.getStatus(handle.handleId);
    expect(status.handle.state).toBe("cancelled");
    expect(status.auditEvents.filter((event) => event.type === "sandbox.cancelled")).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("rejects symbolic-link artifacts", async () => {
    const executor = new FakeDockerExecutor(async (args) => {
      const output = mountSource(args, "/workspace/output");
      await symlink(path.join(snapshotRoot, "SKILL.md"), path.join(output, "leak.md"));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    const runner = createRunner(executor);
    const handle = await runner.prepare(prepareInput(), defaultSandboxPolicy());
    for await (const event of runner.run(handle, { image, command: { executable: "node", args: ["runner.mjs"] } }, new AbortController().signal)) void event;
    await expect(runner.collect(handle)).rejects.toMatchObject({ code: "sandbox_artifact_special_file" });
  });

  it("rejects hard-linked artifacts", async () => {
    const executor = new FakeDockerExecutor(async (args) => {
      const output = mountSource(args, "/workspace/output");
      await writeFile(path.join(output, "original.txt"), "duplicate\n");
      await link(path.join(output, "original.txt"), path.join(output, "alias.txt"));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    const runner = createRunner(executor);
    const handle = await runner.prepare(prepareInput(), defaultSandboxPolicy());
    for await (const event of runner.run(handle, { image, command: { executable: "node", args: ["runner.mjs"] } }, new AbortController().signal)) void event;
    await expect(runner.collect(handle)).rejects.toMatchObject({ code: "sandbox_artifact_hardlink" });
  });
});

class FakeDockerExecutor implements DockerLifecycleExecutor {
  runArgs: string[] = [];
  execCalls: string[][] = [];
  onExec: (args: string[]) => Promise<string> = async () => { throw new Error("No such container"); };
  constructor(private readonly onRun: (args: string[], signal: AbortSignal) => Promise<DockerProcessResult>) {}
  async run(args: string[], signal: AbortSignal): Promise<DockerProcessResult> {
    this.runArgs = [...args];
    return this.onRun(args, signal);
  }
  async exec(args: string[]): Promise<string> {
    this.execCalls.push([...args]);
    return this.onExec(args);
  }
}

function createRunner(executor: DockerLifecycleExecutor): DockerDesktopSandboxRunner {
  return new DockerDesktopSandboxRunner({
    workRoot: path.join(root, "private-sandboxes"),
    executor,
    capabilityService: { probe: async () => readyCapability() },
    idFactory: () => uuid,
    now: () => new Date("2026-07-28T05:00:00.000Z")
  });
}

function prepareInput(): { runtimeArtifact: RuntimeArtifact; benchmarkCase: BenchmarkCase; snapshotRoot: string } {
  const skillId = "skill-11111111-1111-4111-8111-111111111111";
  return {
    snapshotRoot,
    runtimeArtifact: {
      schemaVersion: "1.0",
      artifactId: "artifact-22222222-2222-4222-8222-222222222222",
      workspaceId: "workspace-33333333-3333-4333-8333-333333333333",
      projectId: "project-44444444-4444-4444-8444-444444444444",
      skillId,
      revision: "rev-20260728050000-aaaaaaaa",
      contentHash: `sha256:${"c".repeat(64)}`,
      initialVariables: {},
      fingerprint: { schemaVersion: "1.0", algorithm: "sha256", projectContentHash: `sha256:${"c".repeat(64)}`, inputHash: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", value: `sha256:${"d".repeat(64)}` },
      graph: { schemaVersion: "1.0", skillId, capability: "workflow", entry: "start", nodes: [{ id: "start", title: "Start", kind: "start" }], edges: [] },
      createdAt: "2026-07-28T05:00:00.000Z"
    },
    benchmarkCase: {
      schemaVersion: "1.0",
      caseId: "case-55555555-5555-4555-8555-555555555555",
      skillId,
      title: "Sandbox lifecycle",
      status: "ready",
      intent: "Verify isolation",
      fixture: { initialVariables: {}, userReplies: [] },
      expected: { path: { mode: "subsequence", nodeIds: ["start"] }, variables: {}, artifacts: [], toolResults: [], forbiddenEffects: [] },
      tags: ["sandbox"]
    }
  };
}

function readyCapability(): SandboxCapabilityReport {
  const policy = defaultSandboxPolicy();
  return {
    schemaVersion: "1.0",
    platform: "macos",
    arch: "arm64",
    status: "degraded",
    readyForBenchmark: false,
    selectedBackend: "docker-desktop",
    policy,
    backends: [{ backendId: "docker-desktop", label: "Docker Desktop", status: "ready", isolationLevel: "container-vm-standard", reason: "detected", checks: [], limitations: [] }],
    checkedAt: "2026-07-28T05:00:00.000Z"
  };
}

function mountSource(args: string[], destination: string): string {
  const mount = args.find((item) => item.startsWith("type=bind,") && item.includes(`dst=${destination}`));
  if (!mount) throw new Error(`missing mount ${destination}`);
  const match = /^type=bind,src=(.*),dst=\/workspace\/(?:input|output)(?:,readonly)?$/u.exec(mount);
  if (!match?.[1]) throw new Error(`invalid mount ${mount}`);
  return match[1];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function restoreWritePermissions(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (!info.isDirectory()) return;
    await chmod(target, 0o700);
    for (const entry of await readdir(target)) await restoreWritePermissions(path.join(target, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
