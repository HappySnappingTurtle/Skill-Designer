import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectRun, RuntimeTraceEvent } from "@skill-designer/engine";
import { ExecutionTraceStore } from "../src/trace-store.js";

const workspaceId = "workspace-11111111-1111-4111-8111-111111111111";
const projectId = "project-22222222-2222-4222-8222-222222222222";
const skillId = "skill-33333333-3333-4333-8333-333333333333";
const artifactId = "artifact-44444444-4444-4444-8444-444444444444";
const runId = "run-55555555-5555-4555-8555-555555555555";
let root: string;
let traceStore: ExecutionTraceStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-trace-store-"));
  traceStore = new ExecutionTraceStore(path.join(root, "traces"));
  await traceStore.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ExecutionTraceStore", () => {
  it("appends missing events and repairs a truncated NDJSON tail from the persisted Run", async () => {
    const run = makeRun([event(1, "engine.start"), event(2, "engine.enter")]);
    expect((await traceStore.sync(run)).map((item) => item.seq)).toEqual([1, 2]);
    run.events.push(event(3, "provider.future"));
    run.state.eventSeq = 3;
    expect((await traceStore.sync(run)).map((item) => item.type)).toEqual(["engine.start", "engine.enter", "provider.future"]);

    const target = path.join(root, "traces", projectId, `${runId}.ndjson`);
    const lines = (await readFile(target, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    await writeFile(target, `${lines[0]}\n${lines[1]}\n{\"seq\":`, "utf8");
    expect((await traceStore.sync(run)).map((item) => item.seq)).toEqual([1, 2, 3]);
    expect((await readFile(target, "utf8")).trimEnd().split("\n")).toHaveLength(3);
  });

  it("rejects a Run whose embedded Trace identity cannot be trusted", async () => {
    const run = makeRun([event(1, "engine.start")]);
    run.events[0] = { ...run.events[0]!, skillId: "skill-99999999-9999-4999-8999-999999999999" };
    await expect(traceStore.sync(run)).rejects.toMatchObject({ code: "trace_run_invalid" });
  });
});

function makeRun(events: RuntimeTraceEvent[]): ProjectRun {
  return {
    schemaVersion: "1.0",
    runId,
    workspaceId,
    projectId,
    skillId,
    artifactId,
    revision: "rev-20260729190000-abcdef",
    state: { currentNodeId: "flow.start", status: "running", step: 0, eventSeq: events.length, visitedNodeIds: ["flow.start"], skillVariables: {} },
    events,
    createdAt: "2026-07-29T11:00:00.000Z",
    updatedAt: "2026-07-29T11:00:00.000Z"
  };
}

function event(seq: number, type: string): RuntimeTraceEvent {
  return {
    schemaVersion: "1.0",
    seq,
    type,
    nodeId: "flow.start",
    data: {},
    runId,
    workspaceId,
    projectId,
    skillId,
    artifactId,
    at: "2026-07-29T11:00:00.000Z",
    actor: type.startsWith("engine.") ? "engine" : "system"
  };
}
