import { describe, expect, it } from "vitest";
import { SandboxCapabilityService, type SandboxProbeExecutor } from "../src/sandbox.js";

class FakeExecutor implements SandboxProbeExecutor {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly responses: Array<string | Error>) {}
  async run(command: string, args: string[]): Promise<string> {
    this.calls.push({ command, args });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error("缺少探测响应");
    return response;
  }
}

const now = () => new Date("2026-07-28T04:00:00.000Z");

describe("SandboxCapabilityService", () => {
  it("reports Docker Desktop as detected but not Benchmark-ready before T35", async () => {
    const executor = new FakeExecutor([
      '"unix:///Users/test/.docker/run/docker.sock"',
      JSON.stringify({ OSType: "linux", OperatingSystem: "Docker Desktop", SecurityOptions: ["name=seccomp"] })
    ]);
    const result = await new SandboxCapabilityService({ platform: "darwin", arch: "arm64", now, executor }).probe();
    expect(result).toMatchObject({
      platform: "macos",
      status: "degraded",
      readyForBenchmark: false,
      selectedBackend: "docker-desktop",
      backends: [{ status: "ready", isolationLevel: "container-vm-standard" }, { backendId: "native-macos", status: "unsupported" }]
    });
    expect(executor.calls[0]?.args).toEqual(["context", "inspect", "desktop-linux", "--format", "{{json .Endpoints.docker.Host}}"]);
    expect(executor.calls[1]?.args).toEqual(["--context", "desktop-linux", "info", "--format", "{{json .}}"]);
  });

  it("rejects a remote desktop-linux context instead of silently using it", async () => {
    const executor = new FakeExecutor(['"tcp://remote.example:2376"']);
    const result = await new SandboxCapabilityService({ platform: "darwin", now, executor }).probe();
    expect(result).toMatchObject({ status: "degraded", readyForBenchmark: false });
    expect(result.backends[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("远程") });
    expect(result.backends[0]?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "local-context", status: "fail" })]));
  });

  it("reports a missing CLI and keeps native fallback unsupported", async () => {
    const missing = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    const result = await new SandboxCapabilityService({ platform: "win32", arch: "x64", now, executor: new FakeExecutor([missing]) }).probe();
    expect(result).toMatchObject({
      platform: "windows",
      status: "unavailable",
      readyForBenchmark: false,
      backends: [
        { backendId: "docker-desktop", isolationLevel: "none", checks: [{ message: "未安装 Docker CLI" }] },
        { backendId: "windows-sandbox", status: "unsupported" }
      ]
    });
  });
});
