import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/credential-store.js";
import { ModelSettingsService } from "../src/model-settings.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function memoryCredentials(initial = ""): CredentialStore & { current: string } {
  return {
    current: initial,
    capability: () => ({ backend: "macos-keychain", status: "ready", label: "测试钥匙串", reason: "测试" }),
    async get() { return this.current || null; },
    async set(secret) { this.current = secret; },
    async delete() { this.current = ""; }
  };
}

describe("ModelSettingsService", () => {
  it("stores configuration outside projects without serializing the API key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-model-settings-"));
    roots.push(root);
    const credentials = memoryCredentials();
    const service = new ModelSettingsService({ dataDir: root, credentialStore: credentials, environment: {} });
    await service.initialize();
    const settings = await service.update({ model: "gpt-5.6-terra", timeoutMs: 120_000, apiKey: "sk-private-value" });
    const persisted = await readFile(path.join(root, "config", "model.json"), "utf8");
    expect(persisted).not.toContain("sk-private-value");
    expect(JSON.stringify(settings)).not.toContain("sk-private-value");
    expect(settings).toMatchObject({ keyConfigured: true, keySource: "os-store", timeoutMs: 120_000, generationRetries: 0 });
    expect(credentials.current).toBe("sk-private-value");
  });

  it("prefers the environment credential and keeps it active when the stored key is deleted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-model-env-"));
    roots.push(root);
    const credentials = memoryCredentials("sk-stored-value");
    const service = new ModelSettingsService({ dataDir: root, credentialStore: credentials, environment: { OPENAI_API_KEY: "sk-environment-value" } });
    await service.initialize();
    expect(await service.settings()).toMatchObject({ keyConfigured: true, keySource: "environment" });
    expect(await service.deleteStoredKey()).toMatchObject({ keyConfigured: true, keySource: "environment" });
    expect(credentials.current).toBe("");
  });

  it("retries a token-free connectivity lookup once and records diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-model-probe-"));
    roots.push(root);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "gpt-5.6-terra" }), { status: 200 }));
    const service = new ModelSettingsService({
      dataDir: root,
      credentialStore: memoryCredentials("sk-test-value"),
      environment: {},
      fetch,
      retryDelay: async () => {}
    });
    await service.initialize();
    const result = await service.testConnection();
    expect(result).toMatchObject({ status: "ready", model: "gpt-5.6-terra", attempts: 2, message: "连接成功，模型可用" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url, init]) => String(url).endsWith("/models/gpt-5.6-terra") && init?.method === "GET")).toBe(true);
  });
});
