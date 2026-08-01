import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chromeExecutableCandidates,
  collectReleaseFiles,
  DEVELOPMENT_PREVIEW_RELEASE_CHANNEL,
  defaultDataDirectory,
  defaultInstallDirectory,
  developmentPreviewSigning,
  findChromeExecutable,
  nodeVersionSupported,
  probeWritableDirectory,
  readReleaseManifest,
  releasePlatformMatchesRuntime,
  releaseTrustFromManifest,
  verifyReleaseFiles
} from "../../../scripts/release/release-common.mjs";
import {
  RELEASE_ENTRYPOINTS,
  macEntrypointFileName,
  macEntrypointScript,
  windowsEntrypointFileName,
  windowsEntrypointScript
} from "../../../scripts/release/entrypoints.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("release package runtime contract", () => {
  it("uses platform-specific program and data locations without putting data inside the installation", () => {
    const home = path.resolve("/users/release-test");
    expect(defaultInstallDirectory("darwin", {}, home)).toBe(path.join(home, "Applications", "Skill Designer"));
    expect(defaultDataDirectory("darwin", {}, home)).toBe(path.join(home, "Library", "Application Support", "Skill Designer"));
    expect(defaultInstallDirectory("win32", { LOCALAPPDATA: "C:\\Users\\release\\AppData\\Local" }, home)).toBe(path.join("C:\\Users\\release\\AppData\\Local", "Programs", "Skill Designer"));
    expect(defaultDataDirectory("win32", { LOCALAPPDATA: "C:\\Users\\release\\AppData\\Local" }, home)).toBe(path.join("C:\\Users\\release\\AppData\\Local", "Skill Designer"));
  });

  it("enforces the documented Node 20 minimum", () => {
    expect(nodeVersionSupported("19.9.0")).toBe(false);
    expect(nodeVersionSupported("20.0.0")).toBe(true);
    expect(nodeVersionSupported("24.1.0")).toBe(true);
    expect(nodeVersionSupported("invalid")).toBe(false);
  });

  it("maps each release target to exactly one supported runtime platform", () => {
    expect(releasePlatformMatchesRuntime("macos", "darwin")).toBe(true);
    expect(releasePlatformMatchesRuntime("macos", "win32")).toBe(false);
    expect(releasePlatformMatchesRuntime("macos", "linux")).toBe(false);
    expect(releasePlatformMatchesRuntime("windows", "win32")).toBe(true);
    expect(releasePlatformMatchesRuntime("windows", "darwin")).toBe(false);
    expect(releasePlatformMatchesRuntime("windows", "linux")).toBe(false);
  });

  it("enumerates only the supported Google Chrome locations for each runtime platform", () => {
    const home = path.resolve("/users/release-test");
    expect(chromeExecutableCandidates("darwin", {}, home)).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")
    ]);

    const windowsEnvironment = {
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\release\\AppData\\Local"
    };
    expect(chromeExecutableCandidates("win32", windowsEnvironment, home)).toEqual([
      path.join(windowsEnvironment.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(windowsEnvironment["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      path.join(windowsEnvironment.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    ]);
    expect(chromeExecutableCandidates("linux", {}, home)).toEqual([]);
  });

  it("returns the first existing Chrome executable in candidate order", async () => {
    const home = path.resolve("/users/release-test");
    const candidates = chromeExecutableCandidates("darwin", {}, home);
    const visited: string[] = [];
    const found = await findChromeExecutable({
      platform: "darwin",
      environment: {},
      home,
      exists: async (candidate: string) => {
        visited.push(candidate);
        return candidate === candidates[1];
      }
    });
    expect(found).toBe(candidates[1]);
    expect(visited).toEqual(candidates);
  });

  it("returns null when no supported Chrome executable exists", async () => {
    expect(await findChromeExecutable({
      platform: "win32",
      environment: {
        PROGRAMFILES: "C:\\Program Files",
        "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
        LOCALAPPDATA: "C:\\Users\\release\\AppData\\Local"
      },
      exists: async () => false
    })).toBeNull();
  });

  it("builds a stable file inventory and detects content changes, missing files, and unsafe paths", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "app.js"), "console.log('release');\n", "utf8");
    await writeFile(path.join(root, "README.md"), "# Release\n", "utf8");
    const files = await collectReleaseFiles(root);
    expect(files.map((file) => file.path)).toEqual(["app.js", "README.md"]);
    expect(files[0]?.sha256).toBe(`sha256:${createHash("sha256").update(await readFile(path.join(root, "app.js"))).digest("hex")}`);

    const manifest = { files };
    expect(await verifyReleaseFiles(root, manifest)).toMatchObject({ valid: true, checkedFiles: 2, mismatches: [] });

    await writeFile(path.join(root, "app.js"), "tampered\n", "utf8");
    expect(await verifyReleaseFiles(root, manifest)).toMatchObject({
      valid: false,
      mismatches: [expect.objectContaining({ path: "app.js", code: "content_mismatch" })]
    });

    const unsafe = { files: [{ path: "../outside", size: 0, sha256: `sha256:${"0".repeat(64)}` }] };
    const unsafeResult = await verifyReleaseFiles(root, unsafe);
    expect(unsafeResult.valid).toBe(false);
    expect(unsafeResult.mismatches).toContainEqual({ path: "../outside", code: "unsafe_path" });
  });

  it("rejects undeclared files and symbolic links during full verification", async () => {
    const root = await temporaryRoot();
    const app = path.join(root, "app.js");
    await writeFile(app, "console.log('release');\n", "utf8");
    const files = await collectReleaseFiles(root);
    await writeFile(path.join(root, "extra.txt"), "not declared\n", "utf8");
    expect(await verifyReleaseFiles(root, { files })).toMatchObject({
      valid: false,
      mismatches: [expect.objectContaining({ path: "extra.txt", code: "undeclared_file" })]
    });

    if (process.platform === "win32") return;
    await rm(path.join(root, "extra.txt"));
    await symlink(app, path.join(root, "linked.js"));
    const appBytes = await readFile(app);
    const linkedManifest = {
      files: [...files, { path: "linked.js", size: appBytes.length, sha256: `sha256:${createHash("sha256").update(appBytes).digest("hex")}` }]
    };
    const linked = await verifyReleaseFiles(root, linkedManifest);
    expect(linked.valid).toBe(false);
    expect(linked.mismatches).toContainEqual({ path: "linked.js", code: "unsupported_file_type", actualType: "symbolic_link" });
  });

  it("probes the configured external data directory without leaving a probe file", async () => {
    const root = await temporaryRoot();
    const data = path.join(root, "nested", "data");
    expect(await probeWritableDirectory(data)).toEqual({ writable: true, path: data });
    expect(await collectReleaseFiles(data)).toEqual([]);
  });

  it("reports an unwritable data directory as a structured result instead of throwing", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const readOnlyParent = path.join(root, "read-only");
    await mkdir(readOnlyParent, { recursive: true });
    await chmod(readOnlyParent, 0o500);
    try {
      const blocked = path.join(readOnlyParent, "data");
      const probe = await probeWritableDirectory(blocked);
      expect(probe.writable).toBe(false);
      expect(probe.path).toBe(blocked);
      expect(typeof probe.message).toBe("string");
    } finally {
      await chmod(readOnlyParent, 0o700);
    }
  });

  it("accepts only the explicit unsigned development-preview trust contract", async () => {
    const root = await temporaryRoot();
    const manifest = await writeValidReleaseManifest(root);
    const loaded = await readReleaseManifest(root);
    expect(loaded).toEqual(manifest);
    expect(releaseTrustFromManifest(loaded)).toMatchObject({
      releaseChannel: DEVELOPMENT_PREVIEW_RELEASE_CHANNEL,
      signingStatus: "unsigned",
      trustLevel: "integrity-only",
      distribution: "local-development",
      publisherTrustEstablished: false,
      integrityOnly: true,
      platforms: {
        macos: { appleCodeSigned: false, notarized: false },
        windows: { authenticodeSigned: false }
      }
    });
  });

  it("rejects a release manifest that omits the signing contract", async () => {
    const root = await temporaryRoot();
    const manifest = await writeValidReleaseManifest(root);
    delete (manifest as { signing?: unknown }).signing;
    await writeManifest(root, manifest);
    await expect(readReleaseManifest(root)).rejects.toThrow(/signing 缺失/u);
  });

  it("rejects signed claims without a supported publisher proof", async () => {
    const root = await temporaryRoot();
    const manifest = await writeValidReleaseManifest(root);
    manifest.signing = { ...manifest.signing, status: "signed", claim: "signed by release team" } as typeof manifest.signing;
    await writeManifest(root, manifest);
    await expect(readReleaseManifest(root)).rejects.toThrow(/只接受明确的 unsigned 开发预览/u);
  });

  it("rejects unknown release channels and trust levels", async () => {
    const root = await temporaryRoot();
    const manifest = await writeValidReleaseManifest(root);
    await writeManifest(root, { ...manifest, releaseChannel: "stable" });
    await expect(readReleaseManifest(root)).rejects.toThrow(/releaseChannel/u);

    await writeManifest(root, { ...manifest, signing: { ...manifest.signing, trustLevel: "publisher-verified" } });
    await expect(readReleaseManifest(root)).rejects.toThrow(/trustLevel/u);
  });

  it("rejects minimum Node, entry, and data policies that contradict the 0.1.0 contract", async () => {
    const root = await temporaryRoot();
    const manifest = await writeValidReleaseManifest(root);
    await writeManifest(root, { ...manifest, minimumNode: "21.0.0" });
    await expect(readReleaseManifest(root)).rejects.toThrow(/minimumNode/u);

    await writeManifest(root, { ...manifest, entry: "bin/other.mjs" });
    await expect(readReleaseManifest(root)).rejects.toThrow(/entry/u);

    await writeManifest(root, { ...manifest, dataDirectoryPolicy: "%LOCALAPPDATA%\\Skill Designer" });
    await expect(readReleaseManifest(root)).rejects.toThrow(/dataDirectoryPolicy/u);
  });

  it("reports both the unsigned development-preview and runtime platform boundaries", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "bin"), { recursive: true });
    await copyFile(path.resolve("scripts/release/doctor.mjs"), path.join(root, "bin", "doctor.mjs"));
    await copyFile(path.resolve("scripts/release/release-common.mjs"), path.join(root, "bin", "release-common.mjs"));
    await writeFile(path.join(root, "bin", "skill-designer.mjs"), "// test launcher\n", "utf8");
    const targetPlatform = process.platform === "win32" ? "windows" : "macos";
    await writeValidReleaseManifest(root, { targetPlatform });

    const execution = await runProcess(process.execPath, [path.join(root, "bin", "doctor.mjs"), "--data-dir", path.join(root, "doctor-data")], root);
    const expectedPlatformMatch = process.platform === "darwin" || process.platform === "win32";
    const report = JSON.parse(execution.stdout);
    const expectedSuccess = expectedPlatformMatch && report.chrome.found;
    expect(execution.code).toBe(expectedSuccess ? 0 : 1);
    expect(report.package).toMatchObject({ releaseChannel: "development-preview", targetPlatform, platformMatchesRuntime: expectedPlatformMatch });
    expect(report.releaseTrust).toMatchObject({
      releaseChannel: "development-preview",
      signingStatus: "unsigned",
      trustLevel: "integrity-only",
      publisherTrustEstablished: false,
      integrityOnly: true
    });
    expect(report.releaseTrust.warnings).toEqual([
      expect.stringContaining("只验证完整性"),
      expect.stringContaining("Authenticode")
    ]);
    expect(report.integrity.valid).toBe(true);
  });

  it("refuses to install a package built for another platform", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "bin"), { recursive: true });
    await copyFile(path.resolve("scripts/release/install.mjs"), path.join(root, "bin", "install.mjs"));
    await copyFile(path.resolve("scripts/release/release-common.mjs"), path.join(root, "bin", "release-common.mjs"));
    await writeFile(path.join(root, "bin", "skill-designer.mjs"), "// test launcher\n", "utf8");
    const wrongTarget = process.platform === "win32" ? "macos" : "windows";
    await writeValidReleaseManifest(root, { targetPlatform: wrongTarget });

    const execution = await runProcess(process.execPath, [path.join(root, "bin", "install.mjs"), "--target", path.join(root, "installed-copy")], root);
    expect(execution.code).not.toBe(0);
    expect(execution.stderr).toContain("与当前运行平台");
  });
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-designer-release-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeValidReleaseManifest(root: string, overrides: { targetPlatform?: "macos" | "windows" } = {}) {
  await mkdir(path.join(root, "bin"), { recursive: true });
  const entry = path.join(root, "bin", "skill-designer.mjs");
  try {
    await readFile(entry);
  } catch {
    await writeFile(entry, "// release entry\n", "utf8");
  }
  const targetPlatform = overrides.targetPlatform ?? "macos";
  const manifest = {
    schemaVersion: "1.0",
    product: "Skill Designer",
    version: "0.1.0",
    targetPlatform,
    releaseChannel: DEVELOPMENT_PREVIEW_RELEASE_CHANNEL,
    signing: developmentPreviewSigning(),
    minimumNode: "20.0.0",
    entry: "bin/skill-designer.mjs",
    dataDirectoryPolicy: targetPlatform === "macos" ? "~/Library/Application Support/Skill Designer" : "%LOCALAPPDATA%\\Skill Designer",
    files: await collectReleaseFiles(root)
  };
  await writeManifest(root, manifest);
  return manifest;
}

async function writeManifest(root: string, manifest: unknown) {
  await writeFile(path.join(root, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const onPosixShell = process.platform === "win32" ? it.skip : it;
const onWindowsShell = process.platform === "win32" ? it : it.skip;

describe("release package double-click entrypoints", () => {
  it("separates the long-running service from the one-shot commands", () => {
    expect(RELEASE_ENTRYPOINTS.map((entrypoint) => entrypoint.id)).toEqual(["start", "diagnose", "install", "uninstall"]);
    expect(RELEASE_ENTRYPOINTS.find((entrypoint) => entrypoint.id === "start")).toMatchObject({ script: "skill-designer.mjs", pauseAlways: false });
    for (const id of ["diagnose", "install", "uninstall"]) {
      expect(RELEASE_ENTRYPOINTS.find((entrypoint) => entrypoint.id === id)).toMatchObject({ pauseAlways: true });
    }
    expect(macEntrypointFileName("diagnose")).toBe("diagnose.command");
    expect(windowsEntrypointFileName("diagnose")).toBe("diagnose.cmd");
  });

  it("never enables shell errexit so the exit code is captured after node returns", () => {
    for (const entrypoint of RELEASE_ENTRYPOINTS) {
      const script = macEntrypointScript(entrypoint.script, entrypoint.pauseAlways);
      expect(script).toMatch(/^set -u$/m);
      expect(script).not.toMatch(/^\s*set\s+-[a-uw-z]*e/m);
      expect(script.indexOf("status=$?")).toBeGreaterThan(script.indexOf(`node "bin/${entrypoint.script}"`));
      expect(script.indexOf("read -r _", script.indexOf("status=$?"))).toBeGreaterThan(script.indexOf("status=$?"));
      expect(script.trimEnd().endsWith("exit $status")).toBe(true);
    }
  });

  it("saves the windows errorlevel before pause can overwrite it", () => {
    for (const entrypoint of RELEASE_ENTRYPOINTS) {
      const script = windowsEntrypointScript(entrypoint.script, entrypoint.pauseAlways);
      const nodeIndex = script.indexOf(`node "bin\\${entrypoint.script}"`);
      const saveIndex = script.indexOf('set "status=%errorlevel%"');
      expect(nodeIndex).toBeGreaterThanOrEqual(0);
      expect(saveIndex).toBeGreaterThan(nodeIndex);
      expect(script.indexOf("pause", saveIndex)).toBeGreaterThan(saveIndex);
      expect(script.slice(nodeIndex)).not.toContain("%errorlevel%\r\npause");
      expect(script.slice(saveIndex)).not.toContain("exit /b %errorlevel%");
      expect(script.trimEnd().endsWith("exit /b %status%")).toBe(true);
    }
  });

  it("only pauses the service entrypoint on failure while one-shot entrypoints always wait", () => {
    const service = macEntrypointScript("skill-designer.mjs", false);
    const oneShot = macEntrypointScript("doctor.mjs", true);
    expect(service).toContain("if [ $status -ne 0 ]; then");
    expect(oneShot).not.toContain("if [ $status -ne 0 ]; then");

    const serviceWindows = windowsEntrypointScript("skill-designer.mjs", false);
    const oneShotWindows = windowsEntrypointScript("doctor.mjs", true);
    expect(serviceWindows).toContain('if not "%status%"=="0" pause');
    expect(oneShotWindows.slice(oneShotWindows.indexOf('set "status=%errorlevel%"'))).not.toContain('if not "%status%"');
  });

  onPosixShell("propagates the real node exit code and still shows the prompt when the service fails", async () => {
    const root = await stagedEntrypoints();
    const failure = await runEntrypoint(root, "sh", path.join(root, "fail-service.command"));
    expect(failure).toMatchObject({ code: 7 });
    expect(failure.stdout).toContain("按回车键关闭");

    const success = await runEntrypoint(root, "sh", path.join(root, "ok-service.command"));
    expect(success).toMatchObject({ code: 0 });
    expect(success.stdout).toContain("service-ok");
    expect(success.stdout).not.toContain("按回车键关闭");
  });

  onPosixShell("always waits after a one-shot entrypoint and forwards its arguments", async () => {
    const root = await stagedEntrypoints();
    const success = await runEntrypoint(root, "sh", path.join(root, "ok-oneshot.command"), ["--data-dir", "/tmp/example"]);
    expect(success).toMatchObject({ code: 0 });
    expect(success.stdout).toContain("按回车键关闭");
    expect(success.stdout).toContain('args=["--data-dir","/tmp/example"]');

    const failure = await runEntrypoint(root, "sh", path.join(root, "fail-oneshot.command"));
    expect(failure).toMatchObject({ code: 7 });
    expect(failure.stdout).toContain("按回车键关闭");
  });

  onWindowsShell("propagates the real node exit code through the windows pause", async () => {
    const root = await stagedEntrypoints();
    expect(await runEntrypoint(root, "cmd", path.join(root, "fail-service.cmd"))).toMatchObject({ code: 7 });
    expect(await runEntrypoint(root, "cmd", path.join(root, "fail-oneshot.cmd"))).toMatchObject({ code: 7 });
    const success = await runEntrypoint(root, "cmd", path.join(root, "ok-oneshot.cmd"), ["--data-dir", "C:\\example"]);
    expect(success).toMatchObject({ code: 0 });
    expect(success.stdout).toContain('args=["--data-dir","C:\\\\example"]');
  });
});

async function stagedEntrypoints(): Promise<string> {
  const root = await temporaryRoot();
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(path.join(root, "bin", "ok.mjs"), 'console.log("service-ok");\nconsole.log(`args=${JSON.stringify(process.argv.slice(2))}`);\n', "utf8");
  await writeFile(path.join(root, "bin", "fail.mjs"), 'console.error("boom");\nprocess.exit(7);\n', "utf8");
  const cases = [
    ["ok-service", "ok.mjs", false],
    ["fail-service", "fail.mjs", false],
    ["ok-oneshot", "ok.mjs", true],
    ["fail-oneshot", "fail.mjs", true]
  ] as const;
  for (const [name, script, pauseAlways] of cases) {
    const posix = path.join(root, `${name}.command`);
    await writeFile(posix, macEntrypointScript(script, pauseAlways), "utf8");
    await chmod(posix, 0o755);
    await writeFile(path.join(root, `${name}.cmd`), windowsEntrypointScript(script, pauseAlways), "utf8");
  }
  return root;
}

async function runEntrypoint(
  cwd: string,
  shell: "sh" | "cmd",
  script: string,
  args: string[] = []
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const command = shell === "sh" ? "/bin/sh" : process.env.COMSPEC || "cmd.exe";
  const commandArgs = shell === "sh" ? [script, ...args] : ["/d", "/c", script, ...args];
  return await runProcess(command, commandArgs, cwd);
}

async function runProcess(
  command: string,
  commandArgs: string[],
  cwd: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      // stdin 指向空输入，`read` / `pause` 立即返回 EOF，暂停提示仍会写入 stdout。
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
