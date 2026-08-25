import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";

const spawnSync = spawn.sync;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const client = join(root, "packages", "client");
const temporary = await mkdtemp(join(tmpdir(), "rivetplane-package-"));
const installDirectory = join(temporary, "clean-install");
const npxDirectory = join(temporary, "clean-npx");
const homeDirectory = join(temporary, "home");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout.trim();
}

async function runStartedClient(entrypoint, env) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entrypoint, "--no-opencode", "--no-relay", "--local-port", "0"], {
      cwd: installDirectory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error(`Rivetplane did not start in time\n${output}${errors}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (/Local API: http:\/\/127\.0\.0\.1:\d+\/v1/.test(output) && /Relay:/.test(output) && /Harnesses:/.test(output)) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if ((code === 0 || signal === "SIGTERM") && /Local API:/.test(output)) resolvePromise(output);
      else rejectPromise(new Error(`Rivetplane start failed (${code ?? signal})\n${output}${errors}`));
    });
  });
}

try {
  const dryRun = JSON.parse(run("npm", ["pack", "--dry-run", "--json"], { cwd: client }));
  const files = dryRun[0].files.map(({ path }) => path);
  for (const required of ["LICENSE", "README.md", "dist/cli.js", "dist/index.js", "package.json"]) assert(files.includes(required), `missing ${required}`);
  assert(!files.some((path) => path.includes(".test.") || path.startsWith("src/")), "test or source files are in the package");

  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temporary], { cwd: client }));
  const tarball = join(temporary, packed[0].filename);
  await mkdir(installDirectory);
  await mkdir(npxDirectory);
  await mkdir(homeDirectory);
  run("npm", ["init", "--yes"], { cwd: installDirectory });
  run("npm", ["install", "--ignore-scripts", tarball], { cwd: installDirectory });

  const binary = join(installDirectory, "node_modules", ".bin", "rivetplane");
  const packageJson = JSON.parse(await readFile(join(client, "package.json"), "utf8"));
  const installedPackageJson = JSON.parse(await readFile(join(installDirectory, "node_modules", "rivetplane", "package.json"), "utf8"));
  assert.deepEqual(installedPackageJson.bin, { rivetplane: "dist/cli.js" }, "installed package has an invalid bin entry");
  const installedCliPath = join(installDirectory, "node_modules", "rivetplane", "dist", "cli.js");
  const installedCli = await readFile(installedCliPath, "utf8");
  assert(installedCli.startsWith("#!/usr/bin/env node\n"), "installed CLI has no Node shebang");
  assert.match(run(binary, ["--help"], { cwd: installDirectory }), /Usage:\s+rivetplane/);
  assert.equal(run(binary, ["--version"], { cwd: installDirectory }), packageJson.version);
  assert.match(run("npx", ["--yes", "--package", tarball, "rivetplane", "--help"], { cwd: npxDirectory }), /Usage:\s+rivetplane/);

  const env = { ...process.env, HOME: homeDirectory, XDG_CONFIG_HOME: join(homeDirectory, ".config") };
  assert.match(run(binary, ["login", "--server", "https://example.invalid", "--machine", "package-test", "--token", "test-token"], { cwd: installDirectory, env }), /Paired machine/);
  const started = await runStartedClient(installedCliPath, env);
  assert.match(started, /Relay: disabled/);

  process.stdout.write(`Verified ${packed[0].name}@${packed[0].version} (${packed[0].size} bytes, ${files.length} files).\n`);
  process.stdout.write("Verified dry-run contents, clean tarball install, npx, help, version, login, and start.\n");
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
