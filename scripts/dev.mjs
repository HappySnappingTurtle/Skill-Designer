import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
  spawn(npmCommand, ["run", "dev", "-w", "@skill-designer/server"], { stdio: "inherit" }),
  spawn(npmCommand, ["run", "dev", "-w", "@skill-designer/web"], { stdio: "inherit" })
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`Development process exited (${code ?? signal}).`);
      stop(code ?? 1);
    }
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
