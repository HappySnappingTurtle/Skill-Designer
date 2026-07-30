import { describe, expect, it, vi } from "vitest";
import { OpenAIResponsesProvider } from "../src/model-provider.js";

describe("OpenAIResponsesProvider", () => {
  it("sends a non-stored structured Responses request and extracts actual usage", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "gpt-5.6-terra", store: false, reasoning: { effort: "low" } });
      expect(body.text).toMatchObject({ format: { type: "json_schema", strict: true, name: "decision" } });
      expect(String((init?.headers as Record<string, string>).Authorization)).toBe("Bearer test-key");
      return new Response(JSON.stringify({
        id: "resp_123",
        model: "gpt-5.6-terra-2026-07-01",
        output: [
          { type: "reasoning", summary: [] },
          { type: "message", content: [{ type: "output_text", text: JSON.stringify({ decision: "advance", nextNodeId: "end", summary: "继续" }) }] }
        ],
        usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 5 } }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    let clock = 100;
    const provider = new OpenAIResponsesProvider({ apiKey: "test-key", fetch, monotonicNow: () => (clock += 25) });
    const result = await provider.invoke<{ decision: string }>({
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
      instructions: "choose",
      input: { node: "start" },
      responseSchema: { name: "decision", schema: { type: "object" } }
    }, new AbortController().signal);
    expect(result).toMatchObject({ responseId: "resp_123", model: "gpt-5.6-terra-2026-07-01", output: { decision: "advance" }, durationMs: 25 });
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 12, totalTokens: 42, cachedInputTokens: 10, reasoningTokens: 5, cacheWriteTokens: 2 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports missing credentials without making a network request", async () => {
    const fetch = vi.fn();
    const provider = new OpenAIResponsesProvider({ fetch });
    expect(await provider.probe()).toMatchObject({ status: "unavailable", keyConfigured: false });
    await expect(provider.invoke({ model: "gpt-5.6-terra", reasoningEffort: "low", instructions: "x", input: {}, responseSchema: { name: "x", schema: {} } }, new AbortController().signal))
      .rejects.toMatchObject({ category: "authentication" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies rate limits and redacts credential-shaped provider messages", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      fetch: async () => new Response(JSON.stringify({ error: { message: "bad sk-secret-token" } }), { status: 429, headers: { "Content-Type": "application/json" } })
    });
    await expect(provider.invoke({ model: "gpt-5.6-terra", reasoningEffort: "low", instructions: "x", input: {}, responseSchema: { name: "x", schema: {} } }, new AbortController().signal))
      .rejects.toMatchObject({ category: "rate-limit", retryable: true, message: "bad [REDACTED]" });
  });

  it("checks model connectivity without generating tokens", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/models/gpt-5.6-terra");
      expect(init).toMatchObject({ method: "GET" });
      expect(String((init?.headers as Record<string, string>).Authorization)).toBe("Bearer test-key");
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify({ id: "gpt-5.6-terra" }), { status: 200 });
    });
    const provider = new OpenAIResponsesProvider({ apiKey: "test-key", fetch });
    await expect(provider.testConnection()).resolves.toMatchObject({ model: "gpt-5.6-terra" });
  });

  it("distinguishes provider timeouts from caller cancellation", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const provider = new OpenAIResponsesProvider({ apiKey: "test-key", fetch, timeoutMs: 5 });
    await expect(provider.testConnection()).rejects.toMatchObject({ category: "timeout", retryable: true });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.testConnection("gpt-5.6-terra", controller.signal)).rejects.toMatchObject({ category: "cancelled", retryable: false });
  });
});
