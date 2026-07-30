import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSandboxPolicy, type SandboxCapabilityReport } from "@skill-designer/engine";
import { SandboxControlService } from "../src/sandbox-control.js";
import { DockerDesktopSandboxRunner, type DockerLifecycleExecutor, type DockerProcessResult } from "../src/sandbox-runner.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-sandbox-control-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("SandboxControlService", () => {
  it("persists an honest unavailable self-test when Docker is missing", async () => {
    const unavailable = capability(false);
    const service = new SandboxControlService({
      dataRoot: root,
      capabilityService: { probe: async () => unavailable },
      idFactory: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      now: () => new Date("2026-07-28T06:00:00.000Z")
    });
    const result = await service.runSelfTest();
    expect(result).toMatchObject({ status: "unavailable", reason: "未检测到可用的本机 Docker Desktop", checks: [{ status: "fail" }] });
    expect(await service.latestSelfTest()).toMatchObject({ selfTestId: result.selfTestId, status: "unavailable" });
    expect((await service.probe()).readyForBenchmark).toBe(false);
  });

  it("marks the backend ready only after fixed behavioral and cancellation checks pass", async () => {
    const ready = capability(true);
    const executor = new SelfTestDockerExecutor();
    const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"];
    const runner = new DockerDesktopSandboxRunner({
      workRoot: path.join(root, "lifecycle"),
      capabilityService: { probe: async () => ready },
      executor,
      idFactory: () => ids.shift()!,
      now: () => new Date("2026-07-28T06:00:00.000Z")
    });
    const service = new SandboxControlService({
      dataRoot: root,
      capabilityService: { probe: async () => ready },
      runner,
      runnerImage: `example/runner@sha256:${"e".repeat(64)}`,
      idFactory: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      now: () => new Date("2026-07-28T06:00:00.000Z")
    });
    const result = await service.runSelfTest();
    expect(result.status).toBe("passed");
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["input-read-only", "pass"],
      ["network-none", "pass"],
      ["process-exit", "pass"],
      ["output-collection", "pass"],
      ["source-unchanged", "pass"],
      ["cancel-no-residual", "pass"],
      ["working-copy-cleaned", "pass"]
    ]);
    const report = await service.probe();
    expect(report).toMatchObject({ status: "ready", readyForBenchmark: true, selectedBackend: "docker-desktop" });
    expect(report.backends[0]?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "lifecycle-self-test", status: "pass" })]));
  });

  it("preserves image and prepared handles when a behavioral self-test fails", async () => {
    const ready = capability(true);
    const image = `example/runner@sha256:${"f".repeat(64)}`;
    const runner = new DockerDesktopSandboxRunner({
      workRoot: path.join(root, "lifecycle"),
      capabilityService: { probe: async () => ready },
      executor: {
        run: async () => ({ exitCode: 0, stdout: Buffer.from("not-json"), stderr: Buffer.alloc(0) }),
        exec: async () => { throw new Error("No such container"); }
      },
      idFactory: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      now: () => new Date("2026-07-28T06:00:00.000Z")
    });
    const service = new SandboxControlService({
      dataRoot: root,
      capabilityService: { probe: async () => ready },
      runner,
      runnerImage: image,
      idFactory: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      now: () => new Date("2026-07-28T06:00:00.000Z")
    });

    const result = await service.runSelfTest();

    expect(result).toMatchObject({ status: "failed", image, handleIds: ["sandbox-cccccccc-cccc-4ccc-8ccc-cccccccccccc"] });
    expect(await service.latestSelfTest()).toMatchObject({ image, handleIds: result.handleIds });
    expect((await runner.getStatus(result.handleIds[0]!)).handle.state).toBe("cleaned");
    expect((await service.probe()).readyForBenchmark).toBe(false);
  });
});

class SelfTestDockerExecutor implements DockerLifecycleExecutor {
  private finishCancellation?: (result: DockerProcessResult) => void;

  async run(args: string[]): Promise<DockerProcessResult> {
    if (args.includes("setInterval(()=>{},1000)")) {
      return new Promise((resolve) => { this.finishCancellation = resolve; });
    }
    const output = mountSource(args, "/workspace/output");
    await writeFile(path.join(output, "self-test.json"), JSON.stringify({ inputDenied: true, networkDenied: true }));
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ inputDenied: true, networkDenied: true })), stderr: Buffer.alloc(0) };
  }

  async exec(args: string[]): Promise<string> {
    if (args.includes("rm")) {
      this.finishCancellation?.({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      return "removed";
    }
    throw new Error("No such container");
  }
}

function capability(ready: boolean): SandboxCapabilityReport {
  return {
    schemaVersion: "1.0",
    platform: "macos",
    arch: "arm64",
    status: ready ? "degraded" : "unavailable",
    readyForBenchmark: false,
    ...(ready ? { selectedBackend: "docker-desktop" as const } : {}),
    policy: defaultSandboxPolicy(),
    backends: [
      {
        backendId: "docker-desktop",
        label: "Docker Desktop Linux VM",
        status: ready ? "ready" : "unavailable",
        isolationLevel: ready ? "container-vm-standard" : "none",
        reason: ready ? "检测成功" : "未检测到可用的本机 Docker Desktop",
        checks: ready ? [] : [{ id: "docker-cli-daemon", status: "fail", message: "未安装 Docker CLI" }],
        limitations: ready ? ["当前只完成能力探测和命令计划，尚未创建、取消或清理真实容器。"] : []
      },
      { backendId: "native-macos", label: "macOS native", status: "unsupported", isolationLevel: "none", reason: "不采用", checks: [], limitations: [] }
    ],
    checkedAt: "2026-07-28T06:00:00.000Z"
  };
}

function mountSource(args: string[], destination: string): string {
  const mount = args.find((item) => item.startsWith("type=bind,") && item.includes(`dst=${destination}`));
  const match = mount && /^type=bind,src=(.*),dst=\/workspace\/(?:input|output)(?:,readonly)?$/u.exec(mount);
  if (!match?.[1]) throw new Error(`missing mount ${destination}`);
  return match[1];
}
