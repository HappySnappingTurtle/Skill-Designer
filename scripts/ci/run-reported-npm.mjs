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

child.once("error", (error) => {
  reportFailure(`${error.name}: ${error.message}`).finally(() => process.exit(1));
});

child.once("close", (code) => {
  if (code === 0) return;
  reportFailure(captured).finally(() => process.exit(code ?? 1));
});

async function reportFailure(output) {
  const diagnostic = output.trim().split(/\r?\n/u).slice(-100).join("\n").slice(-60_000) || "命令没有输出诊断信息";
  process.stdout.write(`::error title=${escapeWorkflowCommand(title)}::${escapeWorkflowCommand(diagnostic)}\n`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(summaryPath, `## ${title}\n\n\`\`\`text\n${diagnostic}\n\`\`\`\n`, "utf8");
  }
}

function escapeWorkflowCommand(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
