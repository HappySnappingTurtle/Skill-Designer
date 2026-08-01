// 发布包双击入口脚本的唯一事实源。
// 这些脚本只是薄包装：真正的逻辑在 bin/*.mjs 中，包装层必须原样保留 Node 的退出码，
// 并保证用户在图形界面双击时还能看到结果，因此不使用会提前终止的 `set -e`，
// 也不能在读取 errorlevel 之前执行 pause。

/**
 * 发布包提供的四个快捷入口。
 * `pauseAlways` 为 true 表示一次性命令（诊断/安装/卸载），无论成功失败都要等待用户确认后再关闭终端；
 * `start` 是常驻服务，正常退出时不应额外阻塞。
 */
export const RELEASE_ENTRYPOINTS = [
  { id: "start", script: "skill-designer.mjs", pauseAlways: false },
  { id: "diagnose", script: "doctor.mjs", pauseAlways: true },
  { id: "install", script: "install.mjs", pauseAlways: true },
  { id: "uninstall", script: "uninstall.mjs", pauseAlways: true }
];

export function macEntrypointFileName(id) {
  return `${id}.command`;
}

export function windowsEntrypointFileName(id) {
  return `${id}.cmd`;
}

export function macEntrypointScript(script, pauseAlways = false) {
  const pause = ['printf "按回车键关闭..."', "read -r _"];
  const tail = pauseAlways
    ? pause
    : ["if [ $status -ne 0 ]; then", ...pause.map((line) => `  ${line}`), "fi"];
  return `${[
    "#!/bin/sh",
    // 只启用 -u；启用 -e 会让 node 失败时立即退出，status 保存与暂停提示都不会执行。
    "set -u",
    'cd "$(dirname "$0")" || exit 1',
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "需要先安装 Node.js 20 或更高版本。"',
    ...pause.map((line) => `  ${line}`),
    "  exit 1",
    "fi",
    `node "bin/${script}" "$@"`,
    // node 之后立即保存退出码，之后的任何命令都不会覆盖它。
    "status=$?",
    ...tail,
    "exit $status"
  ].join("\n")}\n`;
}

export function windowsEntrypointScript(script, pauseAlways = false) {
  const tail = pauseAlways ? ["pause"] : ['if not "%status%"=="0" pause'];
  return `${[
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "  echo 需要先安装 Node.js 20 或更高版本。",
    "  pause",
    "  exit /b 1",
    ")",
    `node "bin\\${script}" %*`,
    // pause 会覆盖 errorlevel，因此必须在 pause 之前把 node 的退出码存进变量。
    'set "status=%errorlevel%"',
    ...tail,
    "exit /b %status%"
  ].join("\r\n")}\r\n`;
}
