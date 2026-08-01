import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { defaultDataDirectory, findChromeExecutable, nodeVersionSupported, readReleaseManifest, releasePlatformMatchesRuntime, releaseRoot, verifyReleaseFiles } from "./release-common.mjs";

const root = releaseRoot(import.meta.url);
const args = parseArguments(process.argv.slice(2));

if (!nodeVersionSupported()) fail(`需要 Node.js ${20} 或更高版本，当前为 ${process.versions.node}`);
const manifest = await readReleaseManifest(root).catch((error) => fail(error instanceof Error ? error.message : String(error)));
if (!releasePlatformMatchesRuntime(manifest.targetPlatform)) fail(`发布包目标平台 ${manifest.targetPlatform} 与当前运行平台 ${process.platform} 不匹配`);
const coreFiles = ["app/server/dist/index.js", "app/web/dist/index.html", "node_modules/@skill-designer/engine/dist/index.js"];
const integrity = await verifyReleaseFiles(root, manifest, coreFiles);
if (!integrity.valid) fail(`发布包核心文件校验失败：${integrity.mismatches.map((item) => `${item.path}:${item.code}`).join(", ")}`);

if (args.diagnose) {
  const doctor = spawn(process.execPath, [path.join(root, "bin", "doctor.mjs"), ...(args.dataDir ? ["--data-dir", args.dataDir] : [])], { stdio: "inherit" });
  process.exitCode = await new Promise((resolve) => doctor.once("exit", (code) => resolve(code ?? 1)));
} else {
  const dataDir = path.resolve(args.dataDir ?? defaultDataDirectory());
  const port = await selectPort(args.port);
  const url = `http://127.0.0.1:${port}/`;
  const serverEntry = path.join(root, "app", "server", "dist", "index.js");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: { ...process.env, SKILL_DESIGNER_DATA_DIR: dataDir, SKILL_DESIGNER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  child.stdout.on("data", (chunk) => { const line = String(chunk); output.push(line); process.stdout.write(line); });
  child.stderr.on("data", (chunk) => { const line = String(chunk); output.push(line); process.stderr.write(line); });

  const stop = () => { if (!child.killed) child.kill("SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await waitForServer(url, child, output);
    console.log(`Skill Designer 已启动：${url}`);
    console.log(`数据目录：${dataDir}`);
    if (!args.noOpen) await openChrome(url);
    process.exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  } catch (error) {
    stop();
    fail(error instanceof Error ? error.message : String(error));
  }
}

function parseArguments(values) {
  const result = { noOpen: false, diagnose: false };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === "--no-open") result.noOpen = true;
    else if (value === "--diagnose") result.diagnose = true;
    else if (value === "--port") {
      const port = Number(values[++index]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("--port 必须是 1024-65535 的整数");
      result.port = port;
    } else if (value === "--data-dir") {
      const directory = values[++index];
      if (!directory) fail("--data-dir 需要目录");
      result.dataDir = directory;
    } else fail(`未知参数：${value}`);
  }
  return result;
}

async function selectPort(requested) {
  if (requested) {
    if (!await portAvailable(requested)) fail(`端口 ${requested} 已被占用`);
    return requested;
  }
  const first = 4310;
  const last = 4399;
  for (let port = first; port <= last; port++) if (await portAvailable(port)) return port;
  fail(`端口 ${first}-${last} 均不可用`);
}

async function portAvailable(port) {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`本地服务提前退出 (${child.exitCode})：${output.join("").slice(-2000)}`);
    try {
      const response = await fetch(`${url}api/session`, { headers: { Origin: url.slice(0, -1) } });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("本地服务在 15 秒内未就绪");
}

async function openChrome(url) {
  const executable = await findChromeExecutable();
  if (!executable) throw new Error("未找到 Google Chrome；请安装后重新启动，或使用 --no-open 只启动本地服务");
  spawn(executable, [url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function fail(message) {
  console.error(`Skill Designer 启动失败：${message}`);
  process.exit(1);
}
