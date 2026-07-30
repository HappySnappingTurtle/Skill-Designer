import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectRun, RuntimeTraceEvent } from "@skill-designer/engine";
import { AppError } from "./errors.js";

export class ExecutionTraceStore {
  private readonly root: string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  sync(run: ProjectRun): Promise<RuntimeTraceEvent[]> {
    const key = `${run.projectId}:${run.runId}`;
    return this.exclusive(key, () => this.syncUnlocked(run));
  }

  private async syncUnlocked(run: ProjectRun): Promise<RuntimeTraceEvent[]> {
    this.validateRunEvents(run);
    const target = this.traceFile(run.projectId, run.runId);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const stored = await this.readStored(target);
    if (!stored.valid || stored.events.length > run.events.length || !isPrefix(stored.events, run.events)) {
      await this.rewrite(target, run.events);
      return structuredClone(run.events);
    }
    const missing = run.events.slice(stored.events.length);
    if (missing.length) await this.append(target, missing);
    return structuredClone([...stored.events, ...missing]);
  }

  private async readStored(target: string): Promise<{ valid: boolean; events: RuntimeTraceEvent[] }> {
    try {
      const content = await readFile(target, "utf8");
      if (!content) return { valid: true, events: [] };
      const lines = content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const events: RuntimeTraceEvent[] = [];
      for (const line of lines) {
        if (!line) return { valid: false, events: [] };
        try {
          events.push(JSON.parse(line) as RuntimeTraceEvent);
        } catch {
          return { valid: false, events: [] };
        }
      }
      return { valid: true, events };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { valid: true, events: [] };
      throw error;
    }
  }

  private validateRunEvents(run: ProjectRun): void {
    for (let index = 0; index < run.events.length; index++) {
      const event = run.events[index]!;
      if (
        event.schemaVersion !== "1.0" || event.seq !== index + 1 ||
        event.runId !== run.runId || event.workspaceId !== run.workspaceId ||
        event.projectId !== run.projectId || event.skillId !== run.skillId ||
        event.artifactId !== run.artifactId
      ) {
        throw new AppError(500, "trace_run_invalid", "运行中的 Trace 事件身份或序号无效");
      }
    }
  }

  private async append(target: string, events: readonly RuntimeTraceEvent[]): Promise<void> {
    const handle = await open(target, "a", 0o600);
    try {
      await handle.writeFile(events.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async rewrite(target: string, events: readonly RuntimeTraceEvent[]): Promise<void> {
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, events.map((event) => `${JSON.stringify(event)}\n`).join(""), { encoding: "utf8", mode: 0o600 });
    await rename(temp, target);
  }

  private traceFile(projectId: string, runId: string): string {
    if (!/^project-[0-9a-f-]{36}$/iu.test(projectId) || !/^run-[0-9a-f-]{36}$/iu.test(runId)) {
      throw new AppError(400, "trace_identity_invalid", "Trace 存储身份无效");
    }
    return path.join(this.root, projectId, `${runId}.ndjson`);
  }

  private exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.finally(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return result;
  }
}

function isPrefix(stored: readonly RuntimeTraceEvent[], expected: readonly RuntimeTraceEvent[]): boolean {
  return stored.every((event, index) => JSON.stringify(event) === JSON.stringify(expected[index]));
}
