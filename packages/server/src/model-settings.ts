import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  LLMProvider,
  ModelConnectionResult,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelProviderCapability,
  ModelSettings,
  UpdateModelSettingsInput
} from "@skill-designer/engine";
import type { CredentialStore } from "./credential-store.js";
import { createCredentialStore } from "./credential-store.js";
import { AppError } from "./errors.js";
import { ModelProviderError, OpenAIResponsesProvider } from "./model-provider.js";

interface PersistedModelConfig {
  schemaVersion: "1.0";
  providerId: "openai-responses";
  model: string;
  timeoutMs: number;
  updatedAt: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ModelSettingsServiceOptions {
  dataDir: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  credentialStore?: CredentialStore;
  fetch?: FetchLike;
  now?: () => Date;
  monotonicNow?: () => number;
  retryDelay?: (milliseconds: number) => Promise<void>;
}

export class ModelSettingsService implements LLMProvider {
  readonly providerId = "openai-responses";
  private readonly configFile: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly credentialStore: CredentialStore;
  private readonly fetch: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly retryDelay: (milliseconds: number) => Promise<void>;
  private config!: PersistedModelConfig;
  private lastConnection: ModelConnectionResult | undefined;

  constructor(options: ModelSettingsServiceOptions) {
    this.configFile = path.join(path.resolve(options.dataDir), "config", "model.json");
    this.environment = options.environment ?? process.env;
    this.credentialStore = options.credentialStore ?? createCredentialStore({ dataDir: options.dataDir, ...(options.platform ? { platform: options.platform } : {}) });
    this.fetch = options.fetch;
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.retryDelay = options.retryDelay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  get defaultModel(): string { return this.config.model; }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.configFile), { recursive: true, mode: 0o700 });
    const fallback = this.defaultConfig();
    try {
      const parsed = JSON.parse(await readFile(this.configFile, "utf8")) as unknown;
      this.config = validPersistedConfig(parsed) ? parsed : fallback;
      if (!validPersistedConfig(parsed)) await this.persist();
    } catch (error) {
      if (!isMissingFile(error)) throw new AppError(500, "model_config_unreadable", "模型配置文件无法读取");
      this.config = fallback;
      await this.persist();
    }
  }

  async settings(): Promise<ModelSettings> {
    const credential = await this.resolveCredential();
    return {
      schemaVersion: "1.0",
      providerId: "openai-responses",
      providerLabel: "OpenAI Responses API",
      model: this.config.model,
      timeoutMs: this.config.timeoutMs,
      generationRetries: 0,
      keyConfigured: Boolean(credential.key),
      keySource: credential.source,
      credentialStore: this.credentialStore.capability(),
      connectionStatus: this.lastConnection?.status ?? "untested",
      ...(this.lastConnection ? { lastConnection: this.lastConnection } : {}),
      updatedAt: this.config.updatedAt
    };
  }

  async update(input: UpdateModelSettingsInput): Promise<ModelSettings> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new AppError(400, "invalid_model_settings", "模型设置必须是 JSON 对象");
    if (input.providerId && input.providerId !== "openai-responses") throw new AppError(400, "unsupported_model_provider", "当前版本仅支持 OpenAI Responses API");
    const model = input.model === undefined ? this.config.model : validateModel(input.model);
    const timeoutMs = input.timeoutMs === undefined ? this.config.timeoutMs : validateTimeout(input.timeoutMs);
    if (input.apiKey !== undefined && input.apiKey !== "") {
      const key = validateApiKey(input.apiKey);
      await this.credentialStore.set(key);
    }
    this.config = { schemaVersion: "1.0", providerId: "openai-responses", model, timeoutMs, updatedAt: this.now().toISOString() };
    this.lastConnection = undefined;
    await this.persist();
    return this.settings();
  }

  async deleteStoredKey(): Promise<ModelSettings> {
    await this.credentialStore.delete();
    this.lastConnection = undefined;
    return this.settings();
  }

  async testConnection(): Promise<ModelConnectionResult> {
    const credential = await this.resolveCredential();
    const checkedAt = this.now().toISOString();
    if (!credential.key) {
      return this.remember({ status: "failed", model: this.config.model, checkedAt, durationMs: 0, attempts: 0, category: "authentication", message: "API Key 未配置" });
    }
    const started = this.monotonicNow();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await this.provider(credential.key).testConnection(this.config.model);
        return this.remember({ status: "ready", model: result.model, checkedAt, durationMs: Math.max(result.durationMs, Math.round(this.monotonicNow() - started)), attempts: attempt, message: "连接成功，模型可用" });
      } catch (error) {
        const providerError = error instanceof ModelProviderError ? error : new ModelProviderError("provider", "连通性检查失败", true);
        if (attempt === 1 && providerError.retryable && providerError.category !== "authentication") {
          await this.retryDelay(200);
          continue;
        }
        return this.remember({
          status: "failed",
          model: this.config.model,
          checkedAt,
          durationMs: Math.max(0, Math.round(this.monotonicNow() - started)),
          attempts: attempt,
          category: providerError.category,
          message: providerError.message
        });
      }
    }
    throw new Error("unreachable");
  }

  async probe(): Promise<ModelProviderCapability> {
    const settings = await this.settings();
    return {
      schemaVersion: "1.0",
      providerId: this.providerId,
      label: settings.providerLabel,
      status: settings.keyConfigured ? "ready" : "unavailable",
      keyConfigured: settings.keyConfigured,
      defaultModel: settings.model,
      reason: settings.keyConfigured ? `API Key 已通过${sourceLabel(settings.keySource)}配置` : "API Key 未配置",
      checkedAt: this.now().toISOString()
    };
  }

  async invoke<T>(request: ModelInvocationRequest, signal: AbortSignal): Promise<ModelInvocationResponse<T>> {
    const credential = await this.resolveCredential();
    return this.provider(credential.key).invoke<T>(request, signal);
  }

  private provider(apiKey: string): OpenAIResponsesProvider {
    return new OpenAIResponsesProvider({
      apiKey,
      defaultModel: this.config.model,
      timeoutMs: this.config.timeoutMs,
      ...(this.fetch ? { fetch: this.fetch } : {}),
      now: this.now,
      monotonicNow: this.monotonicNow
    });
  }

  private async resolveCredential(): Promise<{ key: string; source: "environment" | "os-store" | "none" }> {
    const environmentKey = this.environment.OPENAI_API_KEY?.trim();
    if (environmentKey) return { key: environmentKey, source: "environment" };
    const stored = await this.credentialStore.get();
    return stored ? { key: stored, source: "os-store" } : { key: "", source: "none" };
  }

  private remember(result: ModelConnectionResult): ModelConnectionResult {
    this.lastConnection = result;
    return result;
  }

  private defaultConfig(): PersistedModelConfig {
    const model = safeEnvironmentModel(this.environment.SKILL_DESIGNER_OPENAI_MODEL) ?? "gpt-5.6-terra";
    return { schemaVersion: "1.0", providerId: "openai-responses", model, timeoutMs: 60_000, updatedAt: this.now().toISOString() };
  }

  private async persist(): Promise<void> {
    const temporary = `${this.configFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.configFile);
  }
}

function validPersistedConfig(value: unknown): value is PersistedModelConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Partial<PersistedModelConfig>;
  return config.schemaVersion === "1.0" && config.providerId === "openai-responses" && safeEnvironmentModel(config.model) !== null && Number.isInteger(config.timeoutMs) && Number(config.timeoutMs) >= 5_000 && Number(config.timeoutMs) <= 300_000 && typeof config.updatedAt === "string";
}

function validateModel(value: unknown): string {
  if (typeof value !== "string" || !safeEnvironmentModel(value)) throw new AppError(400, "invalid_model_id", "模型 ID 格式无效");
  return value.trim();
}

function safeEnvironmentModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[a-z0-9][a-z0-9._-]{1,120}$/iu.test(trimmed) ? trimmed : null;
}

function validateTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5_000 || value > 300_000) throw new AppError(400, "invalid_model_timeout", "超时时间必须是 5000 到 300000 毫秒之间的整数");
  return value;
}

function validateApiKey(value: unknown): string {
  if (typeof value !== "string") throw new AppError(400, "invalid_api_key", "API Key 格式无效");
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 1000 || /[\r\n\0]/u.test(trimmed)) throw new AppError(400, "invalid_api_key", "API Key 格式无效");
  return trimmed;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function sourceLabel(source: "environment" | "os-store" | "none"): string {
  if (source === "environment") return "环境变量";
  if (source === "os-store") return "系统凭据库";
  return "未配置来源";
}
