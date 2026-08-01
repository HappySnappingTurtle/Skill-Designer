import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { UpdateModelSettingsInput } from "@skill-designer/engine";
import { AppError } from "./errors.js";
import type { BenchmarkRunnerService } from "./benchmark-runner.js";
import type { DesignAssistantService } from "./design-assistant.js";
import type { ModelSettingsService } from "./model-settings.js";
import type { ImportLLMParserService } from "./import-llm-parser.js";
import type { RuntimeDebugService } from "./runtime-debug.js";
import type { SandboxControlService } from "./sandbox-control.js";
import { SandboxCapabilityService } from "./sandbox.js";
import { WorkspaceStore } from "./store.js";

interface AppOptions {
  store: WorkspaceStore;
  sandboxCapabilities?: Pick<SandboxCapabilityService, "probe">;
  sandboxControl?: Pick<SandboxControlService, "probe" | "latestSelfTest" | "runSelfTest">;
  benchmarkRunner?: Pick<BenchmarkRunnerService, "capabilities" | "start" | "startBatch" | "list" | "get" | "cancel" | "review" | "createReport" | "startPostRepair" | "verifyPostRepair">;
  designAssistant?: Pick<DesignAssistantService, "capabilities" | "createSession" | "getSession" | "listSessions" | "message" | "cancel">;
  modelSettings?: Pick<ModelSettingsService, "settings" | "update" | "deleteStoredKey" | "testConnection">;
  importLLMParser?: Pick<ImportLLMParserService, "start" | "latest" | "cancel">;
  runtimeDebug?: Pick<RuntimeDebugService, "history" | "message" | "cancel">;
  allowedOrigins?: string[];
  webRoot?: string;
}

const BODY_LIMIT = 2 * 1024 * 1024;
const IMPORT_BODY_LIMIT = 24 * 1024 * 1024;

export function createApp(options: AppOptions): Server {
  const sessionToken = randomBytes(32).toString("base64url");
  const allowedOrigins = new Set(
    options.allowedOrigins ?? [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://127.0.0.1:4310",
      "http://localhost:4310"
    ]
  );
  const webRoot = options.webRoot ?? path.resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
  const sandboxCapabilities = options.sandboxControl ?? options.sandboxCapabilities ?? new SandboxCapabilityService();
  const sandboxControl = options.sandboxControl;

  const server = createServer(async (request, response) => {
    try {
      secureHeaders(response);
      validateHost(request);

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        validateOrigin(request, allowedOrigins);
        if (request.method === "OPTIONS") return sendEmpty(response, 204);
        if (request.method === "GET" && url.pathname === "/api/session") {
          return sendJson(response, 200, { ok: true, data: { token: sessionToken } });
        }
        if (request.headers["x-skill-designer-token"] !== sessionToken) {
          throw new AppError(401, "unauthorized", "访问令牌无效");
        }
        return await routeApi(options.store, sandboxCapabilities, sandboxControl, options.benchmarkRunner, options.designAssistant, options.modelSettings, options.importLLMParser, options.runtimeDebug, request, response, url);
      }

      return await serveWeb(response, webRoot, url.pathname);
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(500, "internal_error", "服务器内部错误");
      if (!(error instanceof AppError)) console.error(error);
      return sendJson(response, appError.status, {
        ok: false,
        error: { code: appError.code, message: appError.message, ...(appError.details ? { details: appError.details } : {}) }
      });
    }
  });

  const traceSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    try {
      validateHost(request);
      validateOrigin(request, allowedOrigins);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/traces\/(run-[0-9a-f-]{36})\/stream$/i);
      const protocols = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((item) => item.trim());
      if (!match?.[1] || !match[2] || protocols[0] !== "skill-designer.trace.v1" || !protocols.includes(sessionToken)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      const rawAfterSeq = url.searchParams.get("afterSeq") ?? "0";
      if (!/^\d+$/u.test(rawAfterSeq)) {
        rejectUpgrade(socket, 400, "Invalid afterSeq");
        return;
      }
      traceSockets.handleUpgrade(request, socket, head, (webSocket) => {
        attachTraceSocket(webSocket, options.store, match[1]!, match[2]!, Number(rawAfterSeq));
      });
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      rejectUpgrade(socket, status, status === 403 ? "Forbidden" : "Upgrade failed");
    }
  });
  server.on("close", () => {
    for (const client of traceSockets.clients) client.terminate();
    traceSockets.close();
  });
  return server;
}

function attachTraceSocket(
  socket: WebSocket,
  store: WorkspaceStore,
  projectId: string,
  runId: string,
  initialAfterSeq: number
): void {
  let afterSeq = initialAfterSeq;
  let sending = false;
  let queued = false;
  const push = async () => {
    if (sending) {
      queued = true;
      return;
    }
    sending = true;
    try {
      const page = await store.getTraceEvents(projectId, runId, afterSeq);
      if (socket.readyState === WebSocket.OPEN && (page.events.length > 0 || afterSeq === initialAfterSeq)) {
        socket.send(JSON.stringify({ type: "trace.page", data: page }));
      }
      afterSeq = Math.max(afterSeq, page.latestSeq);
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) {
        const appError = error instanceof AppError ? error : new AppError(500, "trace_stream_failed", "Trace 推送失败");
        socket.send(JSON.stringify({ type: "trace.error", error: { code: appError.code, message: appError.message } }));
        socket.close(1011, "Trace unavailable");
      }
    } finally {
      sending = false;
      if (queued) {
        queued = false;
        void push();
      }
    }
  };
  const unsubscribe = store.subscribeTrace(projectId, runId, () => void push());
  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, 20_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  socket.once("close", cleanup);
  socket.once("error", cleanup);
  void push();
}

function rejectUpgrade(socket: import("node:stream").Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

async function routeApi(
  store: WorkspaceStore,
  sandboxCapabilities: Pick<SandboxCapabilityService, "probe">,
  sandboxControl: Pick<SandboxControlService, "latestSelfTest" | "runSelfTest"> | undefined,
  benchmarkRunner: Pick<BenchmarkRunnerService, "capabilities" | "start" | "startBatch" | "list" | "get" | "cancel" | "review" | "createReport" | "startPostRepair" | "verifyPostRepair"> | undefined,
  designAssistant: Pick<DesignAssistantService, "capabilities" | "createSession" | "getSession" | "listSessions" | "message" | "cancel"> | undefined,
  modelSettings: Pick<ModelSettingsService, "settings" | "update" | "deleteStoredKey" | "testConnection"> | undefined,
  importLLMParser: Pick<ImportLLMParserService, "start" | "latest" | "cancel"> | undefined,
  runtimeDebug: Pick<RuntimeDebugService, "history" | "message" | "cancel"> | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  if (url.pathname === "/api/settings/model") {
    if (!modelSettings) throw new AppError(501, "model_settings_unavailable", "当前服务未配置模型设置");
    if (request.method === "GET") return sendJson(response, 200, { ok: true, data: await modelSettings.settings() });
    if (request.method === "PUT") return sendJson(response, 200, { ok: true, data: await modelSettings.update(await readJson(request) as UpdateModelSettingsInput) });
    if (request.method === "DELETE") return sendJson(response, 200, { ok: true, data: await modelSettings.deleteStoredKey() });
  }
  if (request.method === "POST" && url.pathname === "/api/settings/model/test") {
    if (!modelSettings) throw new AppError(501, "model_settings_unavailable", "当前服务未配置模型设置");
    return sendJson(response, 200, { ok: true, data: await modelSettings.testConnection() });
  }
  if (request.method === "GET" && url.pathname === "/api/assistant/capabilities") {
    if (!designAssistant) throw new AppError(501, "design_assistant_unavailable", "当前服务未配置设计助手");
    return sendJson(response, 200, { ok: true, data: await designAssistant.capabilities() });
  }
  if (request.method === "GET" && url.pathname === "/api/benchmark/capabilities") {
    if (!benchmarkRunner) throw new AppError(501, "benchmark_runner_unavailable", "当前服务未配置真实 Benchmark Runner");
    return sendJson(response, 200, { ok: true, data: await benchmarkRunner.capabilities() });
  }
  if (request.method === "GET" && url.pathname === "/api/sandbox/capabilities") {
    return sendJson(response, 200, { ok: true, data: await sandboxCapabilities.probe() });
  }
  if (request.method === "GET" && url.pathname === "/api/sandbox/self-test") {
    return sendJson(response, 200, { ok: true, data: sandboxControl ? await sandboxControl.latestSelfTest() : null });
  }
  if (request.method === "POST" && url.pathname === "/api/sandbox/self-test") {
    if (!sandboxControl) throw new AppError(501, "sandbox_self_test_unavailable", "当前服务未配置沙箱自检");
    return sendJson(response, 200, { ok: true, data: await sandboxControl.runSelfTest() });
  }
  if (request.method === "GET" && url.pathname === "/api/workspaces") {
    return sendJson(response, 200, { ok: true, data: await store.listWorkspaces() });
  }
  if (request.method === "POST" && url.pathname === "/api/workspaces") {
    return sendJson(response, 201, { ok: true, data: await store.createWorkspace(await readJson(request)) });
  }

  const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/(workspace-[0-9a-f-]{36})$/i);
  if (request.method === "GET" && workspaceMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.getWorkspace(workspaceMatch[1]) });
  }
  if (request.method === "PATCH" && workspaceMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.renameWorkspace(workspaceMatch[1], await readJson(request)) });
  }
  if (request.method === "DELETE" && workspaceMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.deleteWorkspace(workspaceMatch[1]) });
  }

  const workspaceReportImportsMatch = url.pathname.match(/^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/report-imports$/i);
  if (request.method === "GET" && workspaceReportImportsMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.listImportedBugReports(workspaceReportImportsMatch[1]) });
  }
  if (request.method === "POST" && workspaceReportImportsMatch?.[1]) {
    return sendJson(response, 201, {
      ok: true,
      data: await store.importBugReport(workspaceReportImportsMatch[1], await readJson(request, IMPORT_BODY_LIMIT))
    });
  }

  const workspaceReportImportMatch = url.pathname.match(
    /^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/report-imports\/(report-import-[0-9a-f-]{36})$/i
  );
  if (request.method === "DELETE" && workspaceReportImportMatch?.[1] && workspaceReportImportMatch[2]) {
    return sendJson(response, 200, { ok: true, data: await store.deleteImportedBugReport(workspaceReportImportMatch[1], workspaceReportImportMatch[2]) });
  }

  const reportDiagnosesMatch = url.pathname.match(
    /^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/report-imports\/(report-import-[0-9a-f-]{36})\/diagnoses$/i
  );
  if (request.method === "GET" && reportDiagnosesMatch?.[1] && reportDiagnosesMatch[2]) {
    return sendJson(response, 200, { ok: true, data: await store.listDiagnoses(reportDiagnosesMatch[1], reportDiagnosesMatch[2]) });
  }
  if (request.method === "POST" && reportDiagnosesMatch?.[1] && reportDiagnosesMatch[2]) {
    return sendJson(response, 201, { ok: true, data: await store.createDiagnosis(reportDiagnosesMatch[1], reportDiagnosesMatch[2]) });
  }

  const reportFixturesMatch = url.pathname.match(
    /^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/report-imports\/(report-import-[0-9a-f-]{36})\/fixtures$/i
  );
  if (request.method === "GET" && reportFixturesMatch?.[1] && reportFixturesMatch[2]) {
    return sendJson(response, 200, { ok: true, data: await store.listReportFixtures(reportFixturesMatch[1], reportFixturesMatch[2]) });
  }
  if (request.method === "POST" && reportFixturesMatch?.[1] && reportFixturesMatch[2]) {
    return sendJson(response, 201, { ok: true, data: await store.createReportFixture(reportFixturesMatch[1], reportFixturesMatch[2]) });
  }

  const reportBenchmarkCandidatesMatch = url.pathname.match(
    /^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/report-imports\/(report-import-[0-9a-f-]{36})\/benchmark-candidates$/i
  );
  if (request.method === "GET" && reportBenchmarkCandidatesMatch?.[1] && reportBenchmarkCandidatesMatch[2]) {
    return sendJson(response, 200, { ok: true, data: await store.listReportBenchmarkCandidates(reportBenchmarkCandidatesMatch[1], reportBenchmarkCandidatesMatch[2]) });
  }
  if (request.method === "POST" && reportBenchmarkCandidatesMatch?.[1] && reportBenchmarkCandidatesMatch[2]) {
    return sendJson(response, 201, { ok: true, data: await store.createReportBenchmarkCandidate(reportBenchmarkCandidatesMatch[1], reportBenchmarkCandidatesMatch[2]) });
  }

  const reportBenchmarkCandidateActionMatch = url.pathname.match(
    /^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/report-imports\/(report-import-[0-9a-f-]{36})\/benchmark-candidates\/(benchmark-candidate-[0-9a-f-]{36})\/(changeset|confirm-and-apply|reject)$/i
  );
  if (request.method === "POST" && reportBenchmarkCandidateActionMatch?.[1] && reportBenchmarkCandidateActionMatch[2] && reportBenchmarkCandidateActionMatch[3]) {
    const action = reportBenchmarkCandidateActionMatch[4];
    const body = await readJson(request);
    const data = action === "changeset"
      ? await store.createReportBenchmarkChangeSet(reportBenchmarkCandidateActionMatch[1], reportBenchmarkCandidateActionMatch[2], reportBenchmarkCandidateActionMatch[3], body)
      : action === "reject"
        ? await store.rejectReportBenchmarkCandidate(reportBenchmarkCandidateActionMatch[1], reportBenchmarkCandidateActionMatch[2], reportBenchmarkCandidateActionMatch[3], body)
        : await store.confirmReportBenchmarkCandidate(reportBenchmarkCandidateActionMatch[1], reportBenchmarkCandidateActionMatch[2], reportBenchmarkCandidateActionMatch[3], body);
    return sendJson(response, reportBenchmarkCandidateActionMatch[4] === "changeset" ? 201 : 200, { ok: true, data });
  }

  const diagnosisRepairsMatch = url.pathname.match(
    /^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/report-imports\/(report-import-[0-9a-f-]{36})\/repairs$/i
  );
  if (request.method === "GET" && diagnosisRepairsMatch?.[1] && diagnosisRepairsMatch[2]) {
    return sendJson(response, 200, { ok: true, data: await store.listDiagnosisRepairs(diagnosisRepairsMatch[1], diagnosisRepairsMatch[2]) });
  }
  if (request.method === "POST" && diagnosisRepairsMatch?.[1] && diagnosisRepairsMatch[2]) {
    const body = await readJson(request) as { diagnosisId?: unknown; candidateId?: unknown };
    if (typeof body.diagnosisId !== "string" || typeof body.candidateId !== "string") {
      throw new AppError(400, "invalid_repair_request", "缺少 diagnosisId 或 candidateId");
    }
    return sendJson(response, 201, { ok: true, data: await store.createDiagnosisRepair(diagnosisRepairsMatch[1], diagnosisRepairsMatch[2], body.diagnosisId, body.candidateId) });
  }

  const diagnosisRepairActionMatch = url.pathname.match(
    /^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/report-imports\/(report-import-[0-9a-f-]{36})\/repairs\/(repair-[0-9a-f-]{36})\/(confirm-and-apply|reject|verify|benchmark|verify-benchmark)$/i
  );
  if (request.method === "POST" && diagnosisRepairActionMatch?.[1] && diagnosisRepairActionMatch[2] && diagnosisRepairActionMatch[3]) {
    const action = diagnosisRepairActionMatch[4];
    if (action === "benchmark" || action === "verify-benchmark") {
      if (!benchmarkRunner) throw new AppError(501, "benchmark_runner_unavailable", "当前服务未配置真实 Benchmark Runner");
      const body = await readJson(request);
      const data = action === "benchmark"
        ? await benchmarkRunner.startPostRepair(diagnosisRepairActionMatch[1], diagnosisRepairActionMatch[2], diagnosisRepairActionMatch[3], body)
        : await benchmarkRunner.verifyPostRepair(diagnosisRepairActionMatch[1], diagnosisRepairActionMatch[2], diagnosisRepairActionMatch[3], typeof (body as { benchmarkRunId?: unknown }).benchmarkRunId === "string" ? (body as { benchmarkRunId: string }).benchmarkRunId : "");
      return sendJson(response, action === "benchmark" ? 202 : 200, { ok: true, data });
    }
    const body = await readJson(request);
    const data = action === "confirm-and-apply"
      ? await store.confirmDiagnosisRepair(diagnosisRepairActionMatch[1], diagnosisRepairActionMatch[2], diagnosisRepairActionMatch[3], body)
      : action === "reject"
        ? await store.rejectDiagnosisRepair(diagnosisRepairActionMatch[1], diagnosisRepairActionMatch[2], diagnosisRepairActionMatch[3], body)
        : await store.verifyDiagnosisRepair(diagnosisRepairActionMatch[1], diagnosisRepairActionMatch[2], diagnosisRepairActionMatch[3], body);
    return sendJson(response, 200, { ok: true, data });
  }

  const projectGraphMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/graph$/i);
  if (request.method === "GET" && projectGraphMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.getProjectGraph(projectGraphMatch[1]) });
  }

  const projectManifestMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/manifest$/i);
  if (request.method === "GET" && projectManifestMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.getSkillManifest(projectManifestMatch[1]) });
  }

  const projectAssistantSessionMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/assistant\/sessions$/i);
  if (request.method === "POST" && projectAssistantSessionMatch?.[1]) {
    if (!designAssistant) throw new AppError(501, "design_assistant_unavailable", "当前服务未配置设计助手");
    return sendJson(response, 201, { ok: true, data: await designAssistant.createSession(projectAssistantSessionMatch[1], await readJson(request)) });
  }

  const workspaceAssistantSessionsMatch = url.pathname.match(/^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/assistant\/sessions$/i);
  if (request.method === "GET" && workspaceAssistantSessionsMatch?.[1]) {
    if (!designAssistant) throw new AppError(501, "design_assistant_unavailable", "当前服务未配置设计助手");
    const projectId = url.searchParams.get("projectId") ?? undefined;
    return sendJson(response, 200, { ok: true, data: await designAssistant.listSessions(workspaceAssistantSessionsMatch[1], projectId) });
  }

  const assistantSessionMatch = url.pathname.match(/^\/api\/assistant\/sessions\/(assistant-session-[0-9a-f-]{36})(?:\/(messages|cancel))?$/i);
  if (assistantSessionMatch?.[1]) {
    if (!designAssistant) throw new AppError(501, "design_assistant_unavailable", "当前服务未配置设计助手");
    if (request.method === "GET" && !assistantSessionMatch[2]) {
      return sendJson(response, 200, { ok: true, data: await designAssistant.getSession(assistantSessionMatch[1]) });
    }
    if (request.method === "POST" && assistantSessionMatch[2] === "messages") {
      return sendJson(response, 201, { ok: true, data: await designAssistant.message(assistantSessionMatch[1], await readJson(request)) });
    }
    if (request.method === "POST" && assistantSessionMatch[2] === "cancel") {
      return sendJson(response, 200, { ok: true, data: await designAssistant.cancel(assistantSessionMatch[1]) });
    }
  }

  const projectGitRefsMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/git\/refs$/i);
  if (request.method === "GET" && projectGitRefsMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.getProjectGitReferences(projectGitRefsMatch[1]) });
  }

  const projectGitDiffMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/git\/diff$/i);
  if (request.method === "GET" && projectGitDiffMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.getProjectGitDiff(projectGitDiffMatch[1], url.searchParams.get("base") ?? "HEAD") });
  }

  const projectRevisionsMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/revisions$/i);
  if (request.method === "GET" && projectRevisionsMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.listRevisions(projectRevisionsMatch[1]) });
  }

  const projectTransactionsMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/transactions$/i);
  if (request.method === "GET" && projectTransactionsMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.listProjectTransactions(projectTransactionsMatch[1]) });
  }

  const projectRevisionStatusMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/revision-status$/i);
  if (request.method === "GET" && projectRevisionStatusMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.getRevisionStatus(projectRevisionStatusMatch[1]) });
  }

  const projectExportsMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/exports$/i);
  if (request.method === "GET" && projectExportsMatch?.[1]) {
    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) throw new AppError(400, "workspace_required", "导出历史需要 workspaceId");
    return sendJson(response, 200, { ok: true, data: await store.listGenericExports(projectExportsMatch[1], workspaceId) });
  }
  if (request.method === "POST" && projectExportsMatch?.[1]) {
    return sendJson(response, 201, { ok: true, data: await store.createGenericExport(projectExportsMatch[1], await readJson(request)) });
  }

  const exportMatch = url.pathname.match(/^\/api\/exports\/(export-[0-9a-f-]{36})$/i);
  if (request.method === "GET" && exportMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.getGenericExport(exportMatch[1]) });
  }
  if (request.method === "DELETE" && exportMatch?.[1]) {
    const body = await readJson(request) as { workspaceId?: unknown };
    if (typeof body.workspaceId !== "string") throw new AppError(400, "workspace_required", "删除导出记录需要 workspaceId");
    return sendJson(response, 200, { ok: true, data: await store.deleteGenericExport(exportMatch[1], body.workspaceId) });
  }
  const exportConfirmMatch = url.pathname.match(/^\/api\/exports\/(export-[0-9a-f-]{36})\/confirm$/i);
  if (request.method === "POST" && exportConfirmMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.confirmGenericExport(exportConfirmMatch[1], await readJson(request)) });
  }
  const exportDownloadMatch = url.pathname.match(/^\/api\/exports\/(export-[0-9a-f-]{36})\/download$/i);
  if (request.method === "GET" && exportDownloadMatch?.[1]) {
    const archive = await store.getGenericExportArchive(exportDownloadMatch[1]);
    return sendArchive(response, archive.path, archive.record.archiveName!, archive.record.archiveSize);
  }

  const projectBaselineMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/baseline$/i);
  if (request.method === "POST" && projectBaselineMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.acknowledgeBaseline(projectBaselineMatch[1], await readJson(request)) });
  }

  const projectBenchmarkCasesMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/benchmark-cases$/i);
  if (request.method === "GET" && projectBenchmarkCasesMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.listBenchmarkCases(projectBenchmarkCasesMatch[1]) });
  }

  const projectBenchmarkCaseMatch = url.pathname.match(
    /^\/api\/projects\/(project-[0-9a-f-]{36})\/benchmark-cases\/(case-[0-9a-f-]{36})$/i
  );
  if (request.method === "GET" && projectBenchmarkCaseMatch?.[1] && projectBenchmarkCaseMatch[2]) {
    return sendJson(response, 200, { ok: true, data: await store.readBenchmarkCase(projectBenchmarkCaseMatch[1], projectBenchmarkCaseMatch[2]) });
  }

  const projectBenchmarkRunsMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/benchmark-runs$/i);
  if (projectBenchmarkRunsMatch?.[1] && (request.method === "GET" || request.method === "POST")) {
    if (!benchmarkRunner) throw new AppError(501, "benchmark_runner_unavailable", "当前服务未配置真实 Benchmark Runner");
    const data = request.method === "GET"
      ? await benchmarkRunner.list(projectBenchmarkRunsMatch[1])
      : await benchmarkRunner.start(projectBenchmarkRunsMatch[1], await readJson(request));
    return sendJson(response, request.method === "GET" ? 200 : 202, { ok: true, data });
  }

  const projectBenchmarkBatchMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/benchmark-runs\/batch$/i);
  if (request.method === "POST" && projectBenchmarkBatchMatch?.[1]) {
    if (!benchmarkRunner) throw new AppError(501, "benchmark_runner_unavailable", "当前服务未配置真实 Benchmark Runner");
    return sendJson(response, 202, { ok: true, data: await benchmarkRunner.startBatch(projectBenchmarkBatchMatch[1], await readJson(request)) });
  }

  const projectBenchmarkRunMatch = url.pathname.match(
    /^\/api\/projects\/(project-[0-9a-f-]{36})\/benchmark-runs\/(benchmark-run-[0-9a-f-]{36})(?:\/(cancel|reviews|reports))?$/i
  );
  if (projectBenchmarkRunMatch?.[1] && projectBenchmarkRunMatch[2]) {
    if (!benchmarkRunner) throw new AppError(501, "benchmark_runner_unavailable", "当前服务未配置真实 Benchmark Runner");
    if (request.method === "GET" && !projectBenchmarkRunMatch[3]) {
      return sendJson(response, 200, { ok: true, data: await benchmarkRunner.get(projectBenchmarkRunMatch[1], projectBenchmarkRunMatch[2]) });
    }
    if (request.method === "POST" && projectBenchmarkRunMatch[3] === "cancel") {
      return sendJson(response, 200, { ok: true, data: await benchmarkRunner.cancel(projectBenchmarkRunMatch[1], projectBenchmarkRunMatch[2]) });
    }
    if (request.method === "POST" && projectBenchmarkRunMatch[3] === "reviews") {
      return sendJson(response, 201, { ok: true, data: await benchmarkRunner.review(projectBenchmarkRunMatch[1], projectBenchmarkRunMatch[2], await readJson(request)) });
    }
    if (request.method === "POST" && projectBenchmarkRunMatch[3] === "reports") {
      return sendJson(response, 201, { ok: true, data: await benchmarkRunner.createReport(projectBenchmarkRunMatch[1], projectBenchmarkRunMatch[2], await readJson(request)) });
    }
  }

  const projectRunsMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/runs$/i);
  const runtimeArtifactStorageMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/runtime-artifacts\/storage$/i);
  if (runtimeArtifactStorageMatch?.[1] && (request.method === "GET" || request.method === "POST")) {
    if (!benchmarkRunner) throw new AppError(501, "artifact_storage_unavailable", "当前服务未配置完整的 RuntimeArtifact 引用索引");
    const workspaceId = request.method === "GET"
      ? url.searchParams.get("workspaceId")
      : (await readJson(request) as { workspaceId?: unknown }).workspaceId;
    if (typeof workspaceId !== "string") throw new AppError(400, "workspace_required", "RuntimeArtifact 存储检查需要 workspaceId");
    const benchmarkRuns = await benchmarkRunner.list(runtimeArtifactStorageMatch[1]);
    const benchmarkArtifactIds = benchmarkRuns.flatMap((run) =>
      typeof run.fingerprint.runtimeArtifactId === "string" ? [run.fingerprint.runtimeArtifactId] : []
    );
    const data = request.method === "GET"
      ? await store.getRuntimeArtifactStorage(runtimeArtifactStorageMatch[1], workspaceId, benchmarkArtifactIds, benchmarkRuns.length)
      : await store.cleanupRuntimeArtifacts(runtimeArtifactStorageMatch[1], workspaceId, benchmarkArtifactIds, benchmarkRuns.length);
    return sendJson(response, 200, { ok: true, data });
  }
  if (request.method === "GET" && projectRunsMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.listRuns(projectRunsMatch[1]) });
  }
  if (request.method === "POST" && projectRunsMatch?.[1]) {
    return sendJson(response, 201, { ok: true, data: await store.createRun(projectRunsMatch[1], await readJson(request)) });
  }

  const projectRunMatch = url.pathname.match(
    /^\/api\/projects\/(project-[0-9a-f-]{36})\/runs\/(run-[0-9a-f-]{36})$/i
  );
  if (request.method === "GET" && projectRunMatch?.[1] && projectRunMatch[2]) {
    return sendJson(response, 200, { ok: true, data: await store.getRun(projectRunMatch[1], projectRunMatch[2]) });
  }

  const runtimeBenchmarkCandidateMatch = url.pathname.match(
    /^\/api\/projects\/(project-[0-9a-f-]{36})\/runs\/(run-[0-9a-f-]{36})\/benchmark-candidate$/i
  );
  if (request.method === "POST" && runtimeBenchmarkCandidateMatch?.[1] && runtimeBenchmarkCandidateMatch[2]) {
    return sendJson(response, 201, {
      ok: true,
      data: await store.createRuntimeBenchmarkCandidate(runtimeBenchmarkCandidateMatch[1], runtimeBenchmarkCandidateMatch[2], await readJson(request))
    });
  }

  const runtimeDialogMatch = url.pathname.match(
    /^\/api\/projects\/(project-[0-9a-f-]{36})\/runs\/(run-[0-9a-f-]{36})\/dialog$/i
  );
  if (runtimeDialogMatch?.[1] && runtimeDialogMatch[2]) {
    if (!runtimeDebug) throw new AppError(501, "runtime_dialog_unavailable", "当前服务未配置运行对话");
    if (request.method === "GET") {
      const workspaceId = url.searchParams.get("workspaceId");
      if (!workspaceId) throw new AppError(400, "workspace_required", "运行对话需要 workspaceId");
      return sendJson(response, 200, { ok: true, data: await runtimeDebug.history(runtimeDialogMatch[1], runtimeDialogMatch[2], workspaceId) });
    }
    if (request.method === "POST") {
      return sendJson(response, 200, { ok: true, data: await runtimeDebug.message(runtimeDialogMatch[1], runtimeDialogMatch[2], await readJson(request)) });
    }
  }

  const runtimeDialogCancelMatch = url.pathname.match(
    /^\/api\/projects\/(project-[0-9a-f-]{36})\/runs\/(run-[0-9a-f-]{36})\/dialog\/cancel$/i
  );
  if (request.method === "POST" && runtimeDialogCancelMatch?.[1] && runtimeDialogCancelMatch[2]) {
    if (!runtimeDebug) throw new AppError(501, "runtime_dialog_unavailable", "当前服务未配置运行对话");
    const body = await readJson(request) as { workspaceId?: unknown };
    if (typeof body.workspaceId !== "string") throw new AppError(400, "workspace_required", "运行对话需要 workspaceId");
    return sendJson(response, 200, { ok: true, data: await runtimeDebug.cancel(runtimeDialogCancelMatch[1], runtimeDialogCancelMatch[2], body.workspaceId) });
  }

  const projectTraceEventsMatch = url.pathname.match(
    /^\/api\/projects\/(project-[0-9a-f-]{36})\/traces\/(run-[0-9a-f-]{36})\/events$/i
  );
  if (request.method === "GET" && projectTraceEventsMatch?.[1] && projectTraceEventsMatch[2]) {
    const rawAfterSeq = url.searchParams.get("afterSeq") ?? "0";
    if (!/^\d+$/u.test(rawAfterSeq)) throw new AppError(400, "invalid_after_seq", "afterSeq 必须是非负整数");
    return sendJson(response, 200, {
      ok: true,
      data: await store.getTraceEvents(projectTraceEventsMatch[1], projectTraceEventsMatch[2], Number(rawAfterSeq))
    });
  }

  const projectRunReportsMatch = url.pathname.match(
    /^\/api\/projects\/(project-[0-9a-f-]{36})\/runs\/(run-[0-9a-f-]{36})\/reports$/i
  );
  if (request.method === "POST" && projectRunReportsMatch?.[1] && projectRunReportsMatch[2]) {
    return sendJson(response, 201, {
      ok: true,
      data: await store.createBugReport(projectRunReportsMatch[1], projectRunReportsMatch[2], await readJson(request))
    });
  }

  const projectReportsMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/reports$/i);
  if (request.method === "GET" && projectReportsMatch?.[1]) {
    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) throw new AppError(400, "workspace_required", "报告历史需要 workspaceId");
    return sendJson(response, 200, { ok: true, data: await store.listBugReports(projectReportsMatch[1], workspaceId) });
  }

  const reportMatch = url.pathname.match(/^\/api\/reports\/(report-[0-9a-f-]{36})$/i);
  if (request.method === "GET" && reportMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.getBugReport(reportMatch[1]) });
  }
  if (request.method === "DELETE" && reportMatch?.[1]) {
    const body = await readJson(request) as { workspaceId?: unknown };
    if (typeof body.workspaceId !== "string") throw new AppError(400, "workspace_required", "删除报告需要 workspaceId");
    return sendJson(response, 200, { ok: true, data: await store.deleteBugReport(reportMatch[1], body.workspaceId) });
  }
  const reportConfirmMatch = url.pathname.match(/^\/api\/reports\/(report-[0-9a-f-]{36})\/confirm$/i);
  if (request.method === "POST" && reportConfirmMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.confirmBugReport(reportConfirmMatch[1], await readJson(request)) });
  }
  const reportImportToWorkspaceMatch = url.pathname.match(/^\/api\/reports\/(report-[0-9a-f-]{36})\/import-to-workspace$/i);
  if (request.method === "POST" && reportImportToWorkspaceMatch?.[1]) {
    const body = await readJson(request) as { workspaceId?: unknown };
    if (typeof body.workspaceId !== "string") throw new AppError(400, "workspace_required", "加入诊断需要 workspaceId");
    return sendJson(response, 201, { ok: true, data: await store.importStoredBugReport(body.workspaceId, reportImportToWorkspaceMatch[1]) });
  }
  const reportDownloadMatch = url.pathname.match(/^\/api\/reports\/(report-[0-9a-f-]{36})\/download$/i);
  if (request.method === "GET" && reportDownloadMatch?.[1]) {
    const format = url.searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "markdown") throw new AppError(400, "report_format_invalid", "报告下载格式无效");
    const download = await store.getBugReportDownload(reportDownloadMatch[1], format);
    return sendDownloadFile(response, download.path, download.fileName, download.contentType, download.size);
  }

  const runCommandMatch = url.pathname.match(
    /^\/api\/projects\/(project-[0-9a-f-]{36})\/runs\/(run-[0-9a-f-]{36})\/(next|pause|resume|stop)$/i
  );
  if (request.method === "POST" && runCommandMatch?.[1] && runCommandMatch[2] && runCommandMatch[3]) {
    return sendJson(response, 200, {
      ok: true,
      data: await store.commandRun(
        runCommandMatch[1],
        runCommandMatch[2],
        runCommandMatch[3] as "next" | "pause" | "resume" | "stop",
        await readJson(request)
      )
    });
  }

  const projectDocsMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/docs$/i);
  if (request.method === "GET" && projectDocsMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.listDocuments(projectDocsMatch[1]) });
  }

  const projectDocumentMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/docs\/file$/i);
  if (request.method === "GET" && projectDocumentMatch?.[1]) {
    const documentPath = url.searchParams.get("path");
    if (!documentPath) throw new AppError(400, "document_path_required", "缺少文档路径");
    return sendJson(response, 200, { ok: true, data: await store.readDocument(projectDocumentMatch[1], documentPath) });
  }

  const projectDocumentSliceMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/docs\/slice$/i);
  if (request.method === "GET" && projectDocumentSliceMatch?.[1]) {
    const documentPath = url.searchParams.get("path");
    if (!documentPath) throw new AppError(400, "document_path_required", "缺少文档路径");
    return sendJson(response, 200, {
      ok: true,
      data: await store.getProjectDocumentSlice(projectDocumentSliceMatch[1], documentPath, url.searchParams.get("anchor") ?? "")
    });
  }

  const projectDocumentReferencesMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/docs\/references$/i);
  if (request.method === "GET" && projectDocumentReferencesMatch?.[1]) {
    return sendJson(response, 200, {
      ok: true,
      data: await store.listDocumentReferences(projectDocumentReferencesMatch[1], url.searchParams.get("path") ?? undefined)
    });
  }

  const projectAssetsMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/assets$/i);
  if (request.method === "GET" && projectAssetsMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.listAssets(projectAssetsMatch[1]) });
  }

  const projectAssetMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/asset$/i);
  if (request.method === "GET" && projectAssetMatch?.[1]) {
    const assetPath = url.searchParams.get("path");
    if (!assetPath) throw new AppError(400, "asset_path_required", "缺少资产路径");
    return sendJson(response, 200, { ok: true, data: await store.readAsset(projectAssetMatch[1], assetPath) });
  }

  const createChangeSetMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/changesets$/i);
  if (request.method === "POST" && createChangeSetMatch?.[1]) {
    return sendJson(response, 201, {
      ok: true,
      data: await store.createChangeSet(createChangeSetMatch[1], await readJson(request))
    });
  }

  const createUndoChangeSetMatch = url.pathname.match(/^\/api\/projects\/(project-[0-9a-f-]{36})\/undo-changesets$/i);
  if (request.method === "POST" && createUndoChangeSetMatch?.[1]) {
    return sendJson(response, 201, {
      ok: true,
      data: await store.createUndoChangeSet(createUndoChangeSetMatch[1], await readJson(request))
    });
  }

  const changeSetMatch = url.pathname.match(/^\/api\/changesets\/(change-[0-9a-f-]{36})$/i);
  if (request.method === "GET" && changeSetMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.getChangeSet(changeSetMatch[1]) });
  }

  const applyChangeSetMatch = url.pathname.match(/^\/api\/changesets\/(change-[0-9a-f-]{36})\/confirm-and-apply$/i);
  if (request.method === "POST" && applyChangeSetMatch?.[1]) {
    return sendJson(response, 200, {
      ok: true,
      data: await store.confirmAndApplyChangeSet(applyChangeSetMatch[1], await readJson(request))
    });
  }

  const rejectChangeSetMatch = url.pathname.match(/^\/api\/changesets\/(change-[0-9a-f-]{36})\/reject$/i);
  if (request.method === "POST" && rejectChangeSetMatch?.[1]) {
    return sendJson(response, 200, {
      ok: true,
      data: await store.rejectChangeSet(rejectChangeSetMatch[1], await readJson(request))
    });
  }

  const reproposeChangeSetMatch = url.pathname.match(/^\/api\/changesets\/(change-[0-9a-f-]{36})\/repropose$/i);
  if (request.method === "POST" && reproposeChangeSetMatch?.[1]) {
    return sendJson(response, 201, {
      ok: true,
      data: await store.reproposeChangeSet(reproposeChangeSetMatch[1], await readJson(request))
    });
  }

  const memberCreateMatch = url.pathname.match(/^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/members$/i);
  if (request.method === "POST" && memberCreateMatch?.[1]) {
    return sendJson(response, 201, {
      ok: true,
      data: await store.createManagedSkill(memberCreateMatch[1], await readJson(request))
    });
  }

  const inPlaceOpenMatch = url.pathname.match(/^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/in-place$/i);
  if (request.method === "POST" && inPlaceOpenMatch?.[1]) {
    return sendJson(response, 201, { ok: true, data: await store.openInPlaceProject(inPlaceOpenMatch[1], await readJson(request)) });
  }

  const importCreateMatch = url.pathname.match(/^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/imports$/i);
  if (request.method === "POST" && importCreateMatch?.[1]) {
    return sendJson(response, 201, {
      ok: true,
      data: await store.createSkillImport(importCreateMatch[1], await readJson(request, IMPORT_BODY_LIMIT))
    });
  }

  const importMatch = url.pathname.match(/^\/api\/imports\/(import-[0-9a-f-]{36})$/i);
  if (request.method === "GET" && importMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.getSkillImport(importMatch[1]) });
  }
  const importReviewMatch = url.pathname.match(/^\/api\/imports\/(import-[0-9a-f-]{36})\/review$/i);
  if (request.method === "PATCH" && importReviewMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.updateSkillImportReview(importReviewMatch[1], await readJson(request)) });
  }
  const importLLMParseMatch = url.pathname.match(/^\/api\/imports\/(import-[0-9a-f-]{36})\/llm-parse(?:\/(cancel))?$/i);
  if (importLLMParseMatch?.[1]) {
    if (!importLLMParser) throw new AppError(501, "import_llm_parser_unavailable", "当前服务未配置 LLM 导入解析器");
    if (request.method === "POST" && importLLMParseMatch[2] === "cancel") {
      const body = await readJson(request) as { workspaceId?: unknown };
      if (typeof body.workspaceId !== "string") throw new AppError(400, "workspace_required", "取消 LLM 解析需要 workspaceId");
      return sendJson(response, 200, { ok: true, data: await importLLMParser.cancel(importLLMParseMatch[1], body.workspaceId) });
    }
    if (request.method === "POST" && !importLLMParseMatch[2]) return sendJson(response, 200, { ok: true, data: await importLLMParser.start(importLLMParseMatch[1], await readJson(request)) });
    if (request.method === "GET" && !importLLMParseMatch[2]) {
      const workspaceId = url.searchParams.get("workspaceId");
      if (!workspaceId) throw new AppError(400, "workspace_required", "读取 LLM 解析记录需要 workspaceId");
      return sendJson(response, 200, { ok: true, data: await importLLMParser.latest(importLLMParseMatch[1], workspaceId) });
    }
  }
  const importReparseResolveMatch = url.pathname.match(/^\/api\/imports\/(import-[0-9a-f-]{36})\/reparse\/resolve$/i);
  if (request.method === "POST" && importReparseResolveMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.resolveSkillImportReparse(importReparseResolveMatch[1], await readJson(request)) });
  }
  const importReparseMatch = url.pathname.match(/^\/api\/imports\/(import-[0-9a-f-]{36})\/reparse$/i);
  if (request.method === "POST" && importReparseMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.reparseSkillImport(importReparseMatch[1], await readJson(request)) });
  }
  const importActionMatch = url.pathname.match(/^\/api\/imports\/(import-[0-9a-f-]{36})\/(confirm|cancel)$/i);
  if (request.method === "POST" && importActionMatch?.[1] && importActionMatch[2]) {
    const input = await readJson(request);
    const data = importActionMatch[2] === "confirm"
      ? await store.confirmSkillImport(importActionMatch[1], input)
      : await store.cancelSkillImport(importActionMatch[1], input);
    return sendJson(response, 200, { ok: true, data });
  }

  const selectionMatch = url.pathname.match(/^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/select$/i);
  if (request.method === "POST" && selectionMatch?.[1]) {
    const body = await readJson(request);
    const projectId = typeof body === "object" && body !== null ? (body as Record<string, unknown>).projectId : undefined;
    return sendJson(response, 200, { ok: true, data: await store.selectProject(selectionMatch[1], projectId) });
  }

  const memberOrderMatch = url.pathname.match(/^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/members\/order$/i);
  if (request.method === "PUT" && memberOrderMatch?.[1]) {
    return sendJson(response, 200, { ok: true, data: await store.reorderMembers(memberOrderMatch[1], await readJson(request)) });
  }

  const memberRepairMatch = url.pathname.match(
    /^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/members\/(project-[0-9a-f-]{36})\/repair$/i
  );
  if (request.method === "POST" && memberRepairMatch?.[1] && memberRepairMatch[2]) {
    return sendJson(response, 200, {
      ok: true,
      data: await store.repairMemberPath(memberRepairMatch[1], memberRepairMatch[2], await readJson(request))
    });
  }

  const memberDeleteMatch = url.pathname.match(
    /^\/api\/workspaces\/(workspace-[0-9a-f-]{36})\/members\/(project-[0-9a-f-]{36})$/i
  );
  if (request.method === "DELETE" && memberDeleteMatch?.[1] && memberDeleteMatch[2]) {
    return sendJson(response, 200, {
      ok: true,
      data: await store.removeMember(memberDeleteMatch[1], memberDeleteMatch[2])
    });
  }

  throw new AppError(404, "route_not_found", "接口不存在");
}

async function readJson(request: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new AppError(413, "body_too_large", "请求内容过大");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "invalid_json", "请求 JSON 无效");
  }
}

function validateHost(request: IncomingMessage): void {
  const host = request.headers.host?.split(":")[0]?.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
    throw new AppError(403, "invalid_host", "只允许本机访问");
  }
}

function validateOrigin(request: IncomingMessage, allowedOrigins: Set<string>): void {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) throw new AppError(403, "invalid_origin", "请求来源不受信任");
}

async function serveWeb(response: ServerResponse, root: string, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let target = path.resolve(root, requested);
  if (!target.startsWith(root + path.sep) && target !== path.join(root, "index.html")) {
    throw new AppError(403, "path_outside_web_root", "静态资源路径无效");
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    target = path.join(root, "index.html");
    try {
      await stat(target);
    } catch {
      throw new AppError(404, "web_not_built", "前端尚未构建");
    }
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", contentType(target));
  createReadStream(target).pipe(response);
}

function contentType(file: string): string {
  const extension = path.extname(file);
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function secureHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.end();
}

function sendArchive(response: ServerResponse, archivePath: string, archiveName: string, size?: number): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/zip");
  response.setHeader("Content-Disposition", `attachment; filename="${archiveName}"`);
  if (size !== undefined) response.setHeader("Content-Length", size);
  createReadStream(archivePath).pipe(response);
}

function sendDownloadFile(response: ServerResponse, filePath: string, fileName: string, contentType: string, size?: number): void {
  const fallback = fileName.replace(/[^0-9A-Za-z._-]/g, "-").replace(/-+/g, "-") || "skill-report.json";
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Disposition", `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  if (size !== undefined) response.setHeader("Content-Length", size);
  createReadStream(filePath).pipe(response);
}
