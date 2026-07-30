import type {
  LLMProvider,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelProviderCapability,
  ModelUsage
} from "@skill-designer/engine";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ModelProviderError extends Error {
  constructor(
    public readonly category: "authentication" | "rate-limit" | "provider" | "protocol" | "timeout" | "cancelled",
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

export interface OpenAIResponsesProviderOptions {
  apiKey?: string;
  defaultModel?: string;
  fetch?: FetchLike;
  now?: () => Date;
  monotonicNow?: () => number;
  timeoutMs?: number;
}

export class OpenAIResponsesProvider implements LLMProvider {
  readonly providerId = "openai-responses";
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly fetch: FetchLike;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly timeoutMs: number;

  constructor(options: OpenAIResponsesProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.defaultModel = options.defaultModel?.trim() || "gpt-5.6-terra";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async probe(): Promise<ModelProviderCapability> {
    return {
      schemaVersion: "1.0",
      providerId: this.providerId,
      label: "OpenAI Responses API",
      status: this.apiKey ? "ready" : "unavailable",
      keyConfigured: Boolean(this.apiKey),
      defaultModel: this.defaultModel,
      reason: this.apiKey ? "API Key 已在服务端配置；真实连通性在 Benchmark 调用时验证" : "服务端未配置 OPENAI_API_KEY",
      checkedAt: this.now().toISOString()
    };
  }

  async invoke<T>(request: ModelInvocationRequest, signal: AbortSignal): Promise<ModelInvocationResponse<T>> {
    if (!this.apiKey) throw new ModelProviderError("authentication", "OpenAI API Key 未配置", false);
    if (signal.aborted) throw new ModelProviderError("cancelled", "模型调用已取消", false);
    if (!/^[a-z0-9][a-z0-9._-]{1,120}$/iu.test(request.model)) throw new ModelProviderError("protocol", "模型 ID 无效", false);
    const started = this.monotonicNow();
    let response: Response;
    const timed = timeoutSignal(signal, this.timeoutMs);
    let payload: unknown;
    try {
      response = await this.fetch(OPENAI_RESPONSES_ENDPOINT, {
        method: "POST",
        signal: timed.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: request.model,
          store: false,
          reasoning: { effort: request.reasoningEffort },
          instructions: request.instructions,
          input: [{ role: "user", content: JSON.stringify(request.input) }],
          text: {
            format: {
              type: "json_schema",
              name: request.responseSchema.name,
              strict: true,
              schema: request.responseSchema.schema
            }
          }
        })
      });
      payload = await parseJsonResponse(response);
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (signal.aborted) throw new ModelProviderError("cancelled", "模型调用已取消", false);
      if (timed.timedOut) throw new ModelProviderError("timeout", `模型调用超过 ${this.timeoutMs}ms`, true);
      if (error instanceof Error && error.name === "AbortError") throw new ModelProviderError("cancelled", "模型调用已取消", false);
      throw new ModelProviderError("provider", "无法连接 OpenAI Responses API", true);
    } finally {
      timed.dispose();
    }
    if (!response.ok) throw providerHttpError(response.status, payload, this.apiKey);
    const record = asRecord(payload);
    const outputText = collectOutputText(record?.output);
    if (!record || typeof record.id !== "string" || typeof record.model !== "string" || !outputText) {
      throw new ModelProviderError("protocol", "OpenAI 响应缺少 id、model 或结构化文本输出", false);
    }
    let output: T;
    try {
      output = JSON.parse(outputText) as T;
    } catch {
      throw new ModelProviderError("protocol", "OpenAI 结构化输出不是有效 JSON", false);
    }
    const usage = parseUsage(record.usage);
    return {
      providerId: this.providerId,
      responseId: record.id,
      model: record.model,
      output,
      usage,
      durationMs: Math.max(0, Math.round(this.monotonicNow() - started))
    };
  }

  async testConnection(model = this.defaultModel, signal = new AbortController().signal): Promise<{ model: string; durationMs: number }> {
    if (!this.apiKey) throw new ModelProviderError("authentication", "OpenAI API Key 未配置", false);
    if (signal.aborted) throw new ModelProviderError("cancelled", "连通性检查已取消", false);
    if (!/^[a-z0-9][a-z0-9._-]{1,120}$/iu.test(model)) throw new ModelProviderError("protocol", "模型 ID 无效", false);
    const started = this.monotonicNow();
    const timed = timeoutSignal(signal, this.timeoutMs);
    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetch(`${OPENAI_MODELS_ENDPOINT}/${encodeURIComponent(model)}`, {
        method: "GET",
        signal: timed.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" }
      });
      payload = await parseJsonResponse(response);
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (signal.aborted) throw new ModelProviderError("cancelled", "连通性检查已取消", false);
      if (timed.timedOut) throw new ModelProviderError("timeout", `连通性检查超过 ${this.timeoutMs}ms`, true);
      if (error instanceof Error && error.name === "AbortError") throw new ModelProviderError("cancelled", "连通性检查已取消", false);
      throw new ModelProviderError("provider", "无法连接 OpenAI API", true);
    } finally {
      timed.dispose();
    }
    if (!response.ok) throw providerHttpError(response.status, payload, this.apiKey);
    const record = asRecord(payload);
    if (!record || typeof record.id !== "string") throw new ModelProviderError("protocol", "模型查询响应缺少 id", false);
    return { model: record.id, durationMs: Math.max(0, Math.round(this.monotonicNow() - started)) };
  }
}

function collectOutputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const rawItem of value) {
    const item = asRecord(rawItem);
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const rawContent of item.content) {
      const content = asRecord(rawContent);
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("");
}

function parseUsage(value: unknown): ModelUsage {
  const usage = asRecord(value);
  const inputDetails = asRecord(usage?.input_tokens_details);
  const outputDetails = asRecord(usage?.output_tokens_details);
  return {
    inputTokens: count(usage?.input_tokens),
    outputTokens: count(usage?.output_tokens),
    totalTokens: count(usage?.total_tokens),
    cachedInputTokens: count(inputDetails?.cached_tokens),
    reasoningTokens: count(outputDetails?.reasoning_tokens),
    cacheWriteTokens: count(inputDetails?.cache_write_tokens)
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ModelProviderError("protocol", `模型服务返回不可解析的响应（HTTP ${response.status}）`, response.status >= 500);
  }
}

function providerHttpError(status: number, payload: unknown, apiKey = ""): ModelProviderError {
  const message = asRecord(asRecord(payload)?.error)?.message;
  const safeMessage = typeof message === "string" ? redactProviderMessage(message, apiKey).slice(0, 500) : `OpenAI API 返回 HTTP ${status}`;
  if (status === 401 || status === 403) return new ModelProviderError("authentication", safeMessage, false);
  if (status === 429) return new ModelProviderError("rate-limit", safeMessage, true);
  return new ModelProviderError("provider", safeMessage, status >= 500);
}

export function redactProviderMessage(message: string, apiKey = ""): string {
  let safe = message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/("?(?:api[_-]?key|authorization)"?\s*[:=]\s*"?)[^"\s,}]+/giu, "$1[REDACTED]");
  if (apiKey) safe = safe.split(apiKey).join("[REDACTED]");
  return safe;
}

function timeoutSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; timedOut: boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
