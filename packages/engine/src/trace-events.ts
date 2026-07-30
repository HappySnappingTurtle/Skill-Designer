export type TraceEventDomain = "engine" | "condition" | "document" | "conversation" | "llm" | "model" | "tool" | "sandbox" | "benchmark" | "assertion" | "review" | "system";
export type TraceEventSensitivity = "structural" | "content" | "sensitive";

export interface TraceEventRegistration {
  type: string;
  domain: TraceEventDomain;
  sensitivity: TraceEventSensitivity;
  structuralFields: readonly string[];
}

const engineFields = ["code", "requestedNodeId", "allowedNodeIds", "viaEdgeId", "step"];
const registryEntries: TraceEventRegistration[] = [
  ...["engine.start", "engine.enter", "engine.reject", "engine.pause", "engine.resume", "engine.stop", "engine.complete"].map((type) => ({ type, domain: "engine" as const, sensitivity: "structural" as const, structuralFields: engineFields })),
  { type: "condition.evaluated", domain: "condition", sensitivity: "structural", structuralFields: ["evaluations", "edgeId", "to", "conditionOp", "result", "allowedNodeIds"] },
  { type: "document.context", domain: "document", sensitivity: "content", structuralFields: ["path", "anchor", "status", "contentCharacters", "truncated"] },
  { type: "context.queried", domain: "system", sensitivity: "structural", structuralFields: ["queries", "queryId", "kind", "status", "valueCharacters", "degradation", "strategy", "requestedAnchor", "resolvedPath"] },
  ...["conversation.user", "conversation.assistant"].map((type) => ({ type, domain: "conversation" as const, sensitivity: "sensitive" as const, structuralFields: ["messageId", "kind", "decision", "action", "nextNodeId", "accepted"] })),
  ...["llm.request", "llm.response", "llm.error"].map((type) => ({ type, domain: "llm" as const, sensitivity: "content" as const, structuralFields: ["messageId", "requestedModel", "reasoningEffort", "allowedNodeIds", "action", "nextNodeId", "providerId", "resolvedModel", "category", "durationMs", "usage"] })),
  ...["model.request", "model.response", "model.error", "model.failed", "model.protocol-error"].map((type) => ({ type, domain: "model" as const, sensitivity: "content" as const, structuralFields: ["nodeId", "allowedNodeIds", "responseId", "model", "decision", "nextNodeId", "durationMs", "usage", "category"] })),
  ...["tool.result", "tool.error", "tool.failed"].map((type) => ({ type, domain: "tool" as const, sensitivity: "content" as const, structuralFields: ["nodeId", "tool", "handleId", "status", "exitCode", "stdoutBytes", "stderrBytes"] })),
  ...["sandbox.prepared", "sandbox.started", "sandbox.stdout", "sandbox.stderr", "sandbox.completed", "sandbox.failed", "sandbox.cancelled", "sandbox.timed-out", "sandbox.collected", "sandbox.cleaned"].map((type) => ({ type, domain: "sandbox" as const, sensitivity: "content" as const, structuralFields: ["handleId", "purpose", "nodeId", "status", "exitCode", "fileCount", "totalBytes", "containerRemoved", "workingCopyRemoved"] })),
  ...["benchmark.queued", "benchmark.preflight", "benchmark.completed", "benchmark.failed", "benchmark.blocked", "benchmark.cancelled"].map((type) => ({ type, domain: "benchmark" as const, sensitivity: "structural" as const, structuralFields: ["queuePosition", "sandboxReady", "providerConfigured", "automaticVerdict", "category", "status", "modelCallCount", "totalTokens"] })),
  { type: "assertion.result", domain: "assertion", sensitivity: "content", structuralFields: ["assertionId", "kind", "status"] },
  { type: "review.recorded", domain: "review", sensitivity: "content", structuralFields: ["reviewId", "verdict", "noteLength"] }
];

export const traceEventRegistry: ReadonlyMap<string, TraceEventRegistration> = new Map(registryEntries.map((registration) => [registration.type, registration]));

export function traceEventRegistration(type: string): TraceEventRegistration | null {
  return traceEventRegistry.get(type) ?? null;
}

export function isRegisteredTraceEvent(type: string): boolean {
  return traceEventRegistry.has(type);
}
