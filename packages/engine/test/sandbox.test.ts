import { describe, expect, it } from "vitest";
import { buildDockerDesktopRunArguments, defaultSandboxPolicy } from "../src/index.js";

const image = `example/skill-runner@sha256:${"a".repeat(64)}`;

describe("SandboxRunner contract", () => {
  it("builds a pinned, networkless, least-privilege Docker Desktop plan", () => {
    const args = buildDockerDesktopRunArguments({
      containerName: "skill-benchmark-123",
      image,
      inputRoot: "/private/tmp/input",
      outputRoot: "/private/tmp/output",
      command: ["node", "runner.mjs"]
    });
    expect(args).toEqual(expect.arrayContaining([
      "--context", "desktop-linux", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "64", "--memory", "512m", "--cpus", "1",
      "--user", "65532:65532"
    ]));
    expect(args).toContain(`type=bind,src=/private/tmp/input,dst=/workspace/input,readonly`);
    expect(args).toContain(`type=bind,src=/private/tmp/output,dst=/workspace/output`);
    expect(args.at(-3)).toBe(image);
    expect(args.slice(-2)).toEqual(["node", "runner.mjs"]);
  });

  it("rejects mutable images, network access, and unsafe mount syntax", () => {
    expect(() => buildDockerDesktopRunArguments({ containerName: "run", image: "node:22", inputRoot: "/tmp/in", outputRoot: "/tmp/out", command: ["node"] })).toThrow(/digest/u);
    const policy = defaultSandboxPolicy();
    policy.network = { mode: "allowlist", allowedHosts: ["api.example.test"] };
    expect(() => buildDockerDesktopRunArguments({ containerName: "run", image, inputRoot: "/tmp/in", outputRoot: "/tmp/out", command: ["node"], policy })).toThrow(/受控代理/u);
    expect(() => buildDockerDesktopRunArguments({ containerName: "run", image, inputRoot: "/tmp/in,bad", outputRoot: "/tmp/out", command: ["node"] })).toThrow(/bind mount/u);
    expect(() => buildDockerDesktopRunArguments({ containerName: "run", image, inputRoot: "/tmp/in", outputRoot: "/tmp/out", command: ["sh"] })).toThrow(/允许列表/u);
  });
});
