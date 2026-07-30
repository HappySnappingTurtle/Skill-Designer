import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelCredentialStoreCapability } from "@skill-designer/engine";
import { AppError } from "./errors.js";

const SERVICE = "com.skill-designer.model-credentials";
const ACCOUNT = "openai-responses";

export interface CredentialStore {
  capability(): ModelCredentialStoreCapability;
  get(): Promise<string | null>;
  set(secret: string): Promise<void>;
  delete(): Promise<void>;
}

export interface CommandResult { stdout: string; stderr: string }
export type CommandRunner = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<CommandResult>;

export function createCredentialStore(options: {
  dataDir: string;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
}): CredentialStore {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runCommand;
  if (platform === "darwin") return new MacKeychainCredentialStore(runner);
  if (platform === "win32") return new WindowsDpapiCredentialStore(path.join(options.dataDir, "credentials", "openai.dpapi"), runner);
  return new UnavailableCredentialStore();
}

export class MacKeychainCredentialStore implements CredentialStore {
  constructor(private readonly runner: CommandRunner = runCommand) {}

  capability(): ModelCredentialStoreCapability {
    return { backend: "macos-keychain", status: "ready", label: "macOS 钥匙串", reason: "密钥由当前 macOS 用户的钥匙串保存" };
  }

  async get(): Promise<string | null> {
    try {
      const result = await this.runner("/usr/bin/security", ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"]);
      return result.stdout.trim() || null;
    } catch (error) {
      if (commandExitCode(error) === 44) return null;
      throw credentialError("无法读取 macOS 钥匙串", error);
    }
  }

  async set(secret: string): Promise<void> {
    try {
      await this.runner("/usr/bin/security", ["add-generic-password", "-U", "-a", ACCOUNT, "-s", SERVICE, "-w", secret]);
    } catch (error) {
      throw credentialError("无法写入 macOS 钥匙串", error);
    }
  }

  async delete(): Promise<void> {
    try {
      await this.runner("/usr/bin/security", ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE]);
    } catch (error) {
      if (commandExitCode(error) !== 44) throw credentialError("无法删除 macOS 钥匙串凭据", error);
    }
  }
}

export class WindowsDpapiCredentialStore implements CredentialStore {
  constructor(
    private readonly target: string,
    private readonly runner: CommandRunner = runCommand
  ) {}

  capability(): ModelCredentialStoreCapability {
    return { backend: "windows-dpapi", status: "ready", label: "Windows DPAPI", reason: "密钥经当前 Windows 用户的 DPAPI 加密后保存在应用数据目录" };
  }

  async get(): Promise<string | null> {
    let encrypted: string;
    try {
      encrypted = (await readFile(this.target, "utf8")).trim();
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw credentialError("无法读取 Windows 凭据文件", error);
    }
    if (!encrypted) return null;
    const script = "$e=[Convert]::FromBase64String($env:SKILL_DESIGNER_CIPHER);$d=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))";
    try {
      const result = await this.runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { ...process.env, SKILL_DESIGNER_CIPHER: encrypted });
      return result.stdout || null;
    } catch (error) {
      throw credentialError("无法使用 Windows DPAPI 解密凭据", error);
    }
  }

  async set(secret: string): Promise<void> {
    const script = "$p=[Convert]::FromBase64String($env:SKILL_DESIGNER_SECRET_B64);$e=[Security.Cryptography.ProtectedData]::Protect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($e))";
    try {
      const result = await this.runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        ...process.env,
        SKILL_DESIGNER_SECRET_B64: Buffer.from(secret, "utf8").toString("base64")
      });
      const encrypted = result.stdout.trim();
      if (!encrypted) throw new Error("DPAPI 未返回密文");
      await mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 });
      const temporary = `${this.target}.${process.pid}.tmp`;
      await writeFile(temporary, encrypted + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.target);
    } catch (error) {
      throw credentialError("无法使用 Windows DPAPI 保存凭据", error);
    }
  }

  async delete(): Promise<void> {
    try {
      await rm(this.target, { force: true });
    } catch (error) {
      throw credentialError("无法删除 Windows 凭据文件", error);
    }
  }
}

class UnavailableCredentialStore implements CredentialStore {
  capability(): ModelCredentialStoreCapability {
    return { backend: "unavailable", status: "unavailable", label: "仅环境变量", reason: "当前系统不支持本地安全凭据写入，请使用 OPENAI_API_KEY" };
  }
  async get(): Promise<null> { return null; }
  async set(): Promise<void> { throw new AppError(409, "credential_store_unavailable", "当前系统不支持本地安全凭据写入，请使用 OPENAI_API_KEY"); }
  async delete(): Promise<void> {}
}

function runCommand(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function commandExitCode(error: unknown): number | string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code?: number | string }).code : undefined;
}

function isMissingFile(error: unknown): boolean {
  return commandExitCode(error) === "ENOENT";
}

function credentialError(message: string, _cause: unknown): AppError {
  return new AppError(503, "credential_store_failed", message);
}
