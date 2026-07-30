import type { SandboxPolicy } from "./types.js";

export interface DockerDesktopRunPlanInput {
  containerName: string;
  image: string;
  inputRoot: string;
  outputRoot: string;
  command: string[];
  policy?: SandboxPolicy;
}

export function defaultSandboxPolicy(): SandboxPolicy {
  return {
    schemaVersion: "1.0",
    filesystem: {
      root: "read-only",
      input: "read-only",
      output: "read-write",
      hostAccess: "deny",
      temporaryMiB: 64
    },
    network: { mode: "none", allowedHosts: [] },
    process: { allowedCommands: ["node"], maxProcesses: 64 },
    resources: { timeoutMs: 120_000, memoryMiB: 512, cpuCores: 1 }
  };
}

export function buildDockerDesktopRunArguments(input: DockerDesktopRunPlanInput): string[] {
  const policy = input.policy ?? defaultSandboxPolicy();
  if (!/^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/iu.test(input.image)) {
    throw new Error("沙箱镜像必须使用 sha256 digest 固定");
  }
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/iu.test(input.containerName)) {
    throw new Error("沙箱容器名称无效");
  }
  for (const [label, value] of [["inputRoot", input.inputRoot], ["outputRoot", input.outputRoot]] as const) {
    if (!value || /[,\r\n\0]/u.test(value)) throw new Error(`${label} 不是安全的 bind mount 路径`);
  }
  if (policy.network.mode !== "none" || policy.network.allowedHosts.length) {
    throw new Error("当前 Docker Desktop 原型只支持 network=none；allowlist 需要受控代理");
  }
  if (policy.filesystem.root !== "read-only" || policy.filesystem.input !== "read-only" || policy.filesystem.output !== "read-write" || policy.filesystem.hostAccess !== "deny") {
    throw new Error("当前 Docker Desktop 原型不接受弱化文件系统策略");
  }
  if (!input.command.length || input.command.some((value) => !value || /[\r\n\0]/u.test(value))) {
    throw new Error("沙箱命令必须是非空参数数组");
  }
  if (!policy.process.allowedCommands.includes(input.command[0]!)) {
    throw new Error(`命令 ${input.command[0]} 不在沙箱允许列表中`);
  }
  return [
    "--context", "desktop-linux", "run", "--rm",
    "--name", input.containerName,
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(policy.process.maxProcesses),
    "--memory", `${policy.resources.memoryMiB}m`,
    "--cpus", String(policy.resources.cpuCores),
    "--user", "65532:65532",
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${policy.filesystem.temporaryMiB}m`,
    "--mount", `type=bind,src=${input.inputRoot},dst=/workspace/input,readonly`,
    "--mount", `type=bind,src=${input.outputRoot},dst=/workspace/output`,
    "--workdir", "/workspace/input",
    input.image,
    ...input.command
  ];
}
