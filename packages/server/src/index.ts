import os from "node:os";
import path from "node:path";
import { BenchmarkRunnerService } from "./benchmark-runner.js";
import { createApp } from "./http.js";
import { DesignAssistantService } from "./design-assistant.js";
import { ModelSettingsService } from "./model-settings.js";
import { ImportLLMParserService } from "./import-llm-parser.js";
import { RuntimeDebugService } from "./runtime-debug.js";
import { SandboxControlService } from "./sandbox-control.js";
import { WorkspaceStore } from "./store.js";

const port = Number(process.env.SKILL_DESIGNER_PORT ?? 4310);
const dataDir = process.env.SKILL_DESIGNER_DATA_DIR
  ? path.resolve(process.env.SKILL_DESIGNER_DATA_DIR)
  : path.join(os.homedir(), ".skill-designer");

const store = new WorkspaceStore({ dataDir });
await store.initialize();
const sandboxControl = new SandboxControlService({
  dataRoot: path.join(dataDir, "sandbox"),
  ...(process.env.SKILL_DESIGNER_SANDBOX_IMAGE ? { runnerImage: process.env.SKILL_DESIGNER_SANDBOX_IMAGE } : {})
});
const provider = new ModelSettingsService({ dataDir });
await provider.initialize();
const benchmarkRunner = new BenchmarkRunnerService({
  dataRoot: path.join(dataDir, "benchmark"),
  store,
  sandboxCapabilities: sandboxControl,
  provider,
  ...(process.env.SKILL_DESIGNER_SANDBOX_IMAGE ? { runnerImage: process.env.SKILL_DESIGNER_SANDBOX_IMAGE } : {})
});
await benchmarkRunner.initialize();
const designAssistant = new DesignAssistantService({
  dataRoot: path.join(dataDir, "assistant"),
  store,
  provider
});
await designAssistant.initialize();
const importLLMParser = new ImportLLMParserService({
  dataRoot: path.join(dataDir, "import-llm-parser"),
  store,
  provider
});
await importLLMParser.initialize();
const runtimeDebug = new RuntimeDebugService({
  dataRoot: path.join(dataDir, "runtime-dialog"),
  store,
  provider
});
await runtimeDebug.initialize();

const server = createApp({
  store,
  sandboxControl,
  benchmarkRunner,
  designAssistant,
  importLLMParser,
  runtimeDebug,
  modelSettings: provider,
  allowedOrigins: [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173"
  ]
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Skill Designer server: http://127.0.0.1:${port}`);
  console.log(`Data directory: ${dataDir}`);
});
