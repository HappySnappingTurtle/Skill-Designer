import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MacKeychainCredentialStore, WindowsDpapiCredentialStore } from "../src/credential-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("credential stores", () => {
  it("uses fixed macOS Keychain service and never returns a secret in capabilities", async () => {
    const calls: string[][] = [];
    const runner = vi.fn(async (_file: string, args: string[]) => {
      calls.push(args);
      return { stdout: args[0] === "find-generic-password" ? "sk-private-value\n" : "", stderr: "" };
    });
    const store = new MacKeychainCredentialStore(runner);
    await store.set("sk-private-value");
    expect(await store.get()).toBe("sk-private-value");
    await store.delete();
    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args.includes("com.skill-designer.model-credentials"))).toBe(true);
    expect(JSON.stringify(store.capability())).not.toContain("sk-private-value");
  });

  it("persists only DPAPI ciphertext and decrypts in the current Windows user context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-dpapi-"));
    roots.push(root);
    const target = path.join(root, "credentials", "openai.dpapi");
    const runner = vi.fn(async (_file: string, _args: string[], env?: NodeJS.ProcessEnv) => {
      if (env?.SKILL_DESIGNER_SECRET_B64) return { stdout: "encrypted-value", stderr: "" };
      if (env?.SKILL_DESIGNER_CIPHER === "encrypted-value") return { stdout: "sk-windows-private", stderr: "" };
      throw new Error("unexpected command");
    });
    const store = new WindowsDpapiCredentialStore(target, runner);
    await store.set("sk-windows-private");
    expect(await readFile(target, "utf8")).toBe("encrypted-value\n");
    expect(await store.get()).toBe("sk-windows-private");
    expect(JSON.stringify(store.capability())).not.toContain("sk-windows-private");
    await store.delete();
    expect(await store.get()).toBeNull();
  });
});
