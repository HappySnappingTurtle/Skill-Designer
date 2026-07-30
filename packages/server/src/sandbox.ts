import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import {
  defaultSandboxPolicy,
  type SandboxBackendCapability,
  type SandboxCapabilityCheck,
  type SandboxCapabilityReport,
  type SandboxHostPlatform
} from "@skill-designer/engine";

const execFileAsync = promisify(execFile);

export interface SandboxProbeExecutor {
  run(command: string, args: string[]): Promise<string>;
}

export interface SandboxCapabilityServiceOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => Date;
  executor?: SandboxProbeExecutor;
}

export class SandboxCapabilityService {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly now: () => Date;
  private readonly executor: SandboxProbeExecutor;

  constructor(options: SandboxCapabilityServiceOptions = {}) {
    this.platform = options.platform ?? os.platform();
    this.arch = options.arch ?? os.arch();
    this.now = options.now ?? (() => new Date());
    this.executor = options.executor ?? new LocalSandboxProbeExecutor();
  }

  async probe(): Promise<SandboxCapabilityReport> {
    const platform = normalizePlatform(this.platform);
    const native = nativeBackend(platform);
    if (platform === "unsupported") {
      return {
        schemaVersion: "1.0",
        platform,
        arch: this.arch,
        status: "unsupported",
        readyForBenchmark: false,
        policy: defaultSandboxPolicy(),
        backends: [dockerUnavailable("当前宿主系统不在 1.0 支持范围", []), native],
        checkedAt: this.now().toISOString()
      };
    }

    const checks: SandboxCapabilityCheck[] = [];
    try {
      const contextText = await this.executor.run("docker", ["context", "inspect", "desktop-linux", "--format", "{{json .Endpoints.docker.Host}}"]);
      const endpoint = parseJsonString(contextText);
      checks.push({ id: "docker-cli", status: "pass", message: "Docker CLI 可用" });
      if (!isLocalDesktopEndpoint(platform, endpoint)) {
        checks.push({ id: "local-context", status: "fail", message: "desktop-linux 未指向受支持的本机 Docker Desktop socket" });
        return this.report(platform, "degraded", false, dockerUnavailable("拒绝远程或无法识别的 Docker context", checks), native);
      }
      checks.push({ id: "local-context", status: "pass", message: "desktop-linux 使用本机 Docker Desktop socket" });

      const infoText = await this.executor.run("docker", ["--context", "desktop-linux", "info", "--format", "{{json .}}"]);
      const info = parseObject(infoText);
      checks.push({ id: "daemon", status: "pass", message: "Docker Desktop daemon 可连接" });
      if (info.OSType !== "linux") {
        checks.push({ id: "linux-engine", status: "fail", message: "Docker Desktop 当前不是 Linux containers 模式" });
        return this.report(platform, "degraded", false, dockerUnavailable("需要 desktop-linux Linux containers 模式", checks), native);
      }
      checks.push({ id: "linux-engine", status: "pass", message: "Docker Desktop 使用 Linux VM engine" });
      checks.push({ id: "lifecycle-self-test", status: "warning", message: "T35 尚未执行隔离容器生命周期自测" });
      const docker: SandboxBackendCapability = {
        backendId: "docker-desktop",
        label: "Docker Desktop Linux VM",
        status: "ready",
        isolationLevel: hasUserNamespace(info.SecurityOptions) ? "container-vm-hardened" : "container-vm-standard",
        reason: "本机 Docker Desktop 能力可用；完成 T35 生命周期自测后才能运行 Benchmark",
        checks,
        limitations: [
          "只运行固定 digest 的 Linux runner 镜像，不支持 Windows/macOS 原生命令。",
          "默认 network=none；模型请求由宿主 LLM Provider 发起，网络 allowlist 需受控代理。",
          "标准隔离仍信任 Docker Desktop VM、daemon 与容器运行时；ECI 不是 1.0 的免费前置条件。",
          "当前只完成能力探测和命令计划，尚未创建、取消或清理真实容器。"
        ]
      };
      return this.report(platform, "degraded", false, docker, native, "docker-desktop");
    } catch (error) {
      const message = probeErrorMessage(error);
      checks.push({ id: "docker-cli-daemon", status: "fail", message });
      return this.report(platform, "unavailable", false, dockerUnavailable("未检测到可用的本机 Docker Desktop", checks), native);
    }
  }

  private report(
    platform: SandboxHostPlatform,
    status: SandboxCapabilityReport["status"],
    readyForBenchmark: boolean,
    docker: SandboxBackendCapability,
    native: SandboxBackendCapability,
    selectedBackend?: SandboxBackendCapability["backendId"]
  ): SandboxCapabilityReport {
    return {
      schemaVersion: "1.0",
      platform,
      arch: this.arch,
      status,
      readyForBenchmark,
      ...(selectedBackend ? { selectedBackend } : {}),
      policy: defaultSandboxPolicy(),
      backends: [docker, native],
      checkedAt: this.now().toISOString()
    };
  }
}

class LocalSandboxProbeExecutor implements SandboxProbeExecutor {
  async run(command: string, args: string[]): Promise<string> {
    const allowed = new Set(["PATH", "HOME", "USERPROFILE", "SystemRoot", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key) && value !== undefined)) as NodeJS.ProcessEnv;
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 4_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
      env
    });
    return result.stdout;
  }
}

function normalizePlatform(platform: NodeJS.Platform): SandboxHostPlatform {
  return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "unsupported";
}

function nativeBackend(platform: SandboxHostPlatform): SandboxBackendCapability {
  if (platform === "windows") {
    return {
      backendId: "windows-sandbox",
      label: "Windows Sandbox",
      status: "unsupported",
      isolationLevel: "none",
      reason: "1.0 不采用交互式 Windows Sandbox 作为自动 Benchmark Runner",
      checks: [],
      limitations: ["需要可选系统功能和虚拟化，且缺少本产品所需的可靠无界面生命周期/产物协议。"]
    };
  }
  return {
    backendId: "native-macos",
    label: "macOS native sandbox",
    status: "unsupported",
    isolationLevel: "none",
    reason: platform === "macos" ? "sandbox-exec 已弃用，不作为可声明的 1.0 隔离边界" : "宿主系统不受支持",
    checks: [],
    limitations: ["不会退回 sandbox-exec、App Sandbox 或裸宿主进程执行用户 Skill。"]
  };
}

function dockerUnavailable(reason: string, checks: SandboxCapabilityCheck[]): SandboxBackendCapability {
  return {
    backendId: "docker-desktop",
    label: "Docker Desktop Linux VM",
    status: "unavailable",
    isolationLevel: "none",
    reason,
    checks,
    limitations: ["未达到容器 VM 隔离条件时禁止启动真实 Benchmark。"]
  };
}

function isLocalDesktopEndpoint(platform: SandboxHostPlatform, endpoint: string): boolean {
  return platform === "macos"
    ? endpoint.startsWith("unix://") && /docker(?:\.raw)?\.sock$/u.test(endpoint)
    : platform === "windows" && /^npipe:\/{4}\.\/pipe\/dockerDesktopLinuxEngine$/iu.test(endpoint);
}

function parseJsonString(value: string): string {
  const parsed = JSON.parse(value.trim()) as unknown;
  if (typeof parsed !== "string") throw new Error("Docker context 输出格式无效");
  return parsed;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value.trim()) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Docker info 输出格式无效");
  return parsed as Record<string, unknown>;
}

function hasUserNamespace(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => typeof item === "string" && /userns|rootless|sysbox/iu.test(item));
}

function probeErrorMessage(error: unknown): string {
  const candidate = error as NodeJS.ErrnoException & { stderr?: string };
  if (candidate.code === "ENOENT") return "未安装 Docker CLI";
  if (candidate.code === "ETIMEDOUT") return "Docker Desktop 能力探测超时";
  return candidate.stderr?.trim().split("\n")[0] || (error instanceof Error ? error.message : "Docker Desktop 能力探测失败");
}
