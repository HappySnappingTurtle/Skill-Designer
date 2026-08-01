import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";

const [title, script, ...scriptArguments] = process.argv.slice(2);

if (!title || !script) {
  console.error("Usage: node scripts/ci/run-reported-npm.mjs <title> <npm-script> [arguments...]");
  process.exit(2);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npmCommand, ["run", script, ...scriptArguments], {
  cwd: process.cwd(),
  env: process.env,
  shell: process.platform === "win32",
  stdio: ["inherit", "pipe", "pipe"]
});
let captured = "";

child.stdout.setEncoding("utf8").on("data", (chunk) => {
  captured += chunk;
  process.stdout.write(chunk);
});
child.stderr.setEncoding("utf8").on("data", (chunk) => {
  captured += chunk;
  process.stderr.write(chunk);
});

try {
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    await reportFailure(captured);
    process.exitCode = code ?? 1;
  }
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await reportFailure(message);
  process.exitCode = 1;
}

async function reportFailure(output) {
  const diagnostic = stripAnsi(output).trim().split(/\r?\n/u).slice(-40).join("\n").slice(-12_000) || "命令没有输出诊断信息";
  process.stdout.write(`::error title=${escapeWorkflowCommand(title)}::${escapeWorkflowCommand(diagnostic)}\n`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(summaryPath, `## ${title}\n\n\`\`\`text\n${diagnostic}\n\`\`\`\n`, "utf8");
  }
}

function stripAnsi(value) {
  return String(value).replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function escapeWorkflowCommand(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
