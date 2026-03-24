import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const demoRoot = resolve(__dirname, "..");
const repoRoot = resolve(demoRoot, "..", "..");
const publicWasmDir = join(demoRoot, "public", "wasm");
const buildRoot = join(repoRoot, "wasm", "build");
const runtimeRoot = join(repoRoot, "wasm", "runtime");

mkdirSync(publicWasmDir, { recursive: true });
const wasmExecPath = join(buildRoot, "wasm_exec.js");
const wasmBinaryPath = join(buildRoot, "lndmobile.wasm");
const fsBridgePath = join(runtimeRoot, "fs_backends.js");

if (!existsSync(wasmBinaryPath)) {
  process.stderr.write(
    `missing lndmobile.wasm at ${wasmBinaryPath}; run 'make wasm' first\n`,
  );
  process.exit(1);
}

if (!existsSync(wasmExecPath)) {
  process.stderr.write(
    `missing wasm_exec.js at ${wasmExecPath}; run 'make wasm' first\n`,
  );
  process.exit(1);
}

if (!existsSync(fsBridgePath)) {
  process.stderr.write(`missing fs_backends.js at ${fsBridgePath}\n`);
  process.exit(1);
}

cpSync(wasmBinaryPath, join(publicWasmDir, "lndmobile.wasm"));
cpSync(wasmExecPath, join(publicWasmDir, "wasm_exec.js"));
cpSync(fsBridgePath, join(publicWasmDir, "fs_backends.js"));

process.stdout.write(`synced wasm assets to ${publicWasmDir}\n`);
