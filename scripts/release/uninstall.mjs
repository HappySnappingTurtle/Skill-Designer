import { createInterface } from "node:readline/promises";
import path from "node:path";
import process from "node:process";
import { defaultDataDirectory, readReleaseManifest, releaseRoot, removeExactDirectory } from "./release-common.mjs";

const root = releaseRoot(import.meta.url);
const manifest = await readReleaseManifest(root);
const deleteData = process.argv.includes("--delete-data");
const confirmed = process.argv.includes("--yes") || await prompt(deleteData);
if (!confirmed) {
  console.log("已取消卸载，程序和数据均未修改。");
  process.exit(0);
}

const dataDir = path.resolve(argumentValue("--data-dir") ?? defaultDataDirectory());
process.chdir(path.dirname(root));
await removeExactDirectory(root);
if (deleteData) await removeExactDirectory(dataDir);
console.log(JSON.stringify({ uninstalled: true, product: manifest.product, version: manifest.version, programRemoved: root, dataDirectory: dataDir, dataRemoved: deleteData }, null, 2));

async function prompt(includeData) {
  if (!process.stdin.isTTY) return false;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(`确认卸载 Skill Designer${includeData ? "并删除全部本地数据" : "（保留全部本地数据）"}？输入 UNINSTALL 继续：`);
  terminal.close();
  return answer.trim() === "UNINSTALL";
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
