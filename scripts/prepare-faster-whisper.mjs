import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(root, "runtime/faster-whisper");
if (!existsSync(resolve(runtime, "python/python.exe")) || !existsSync(resolve(runtime, "packages/faster_whisper"))) {
  throw new Error("Run scripts/setup-faster-whisper.ps1 -SkipModel before building the desktop application.");
}
mkdirSync(runtime, { recursive: true });
for (const name of ["worker.py", "models.py", "requirements.lock", "requirements-gpu.lock"]) {
  copyFileSync(resolve(root, "python/faster_whisper", name), resolve(runtime, name));
}
cpSync(resolve(root, "python/faster_whisper/licenses"), resolve(runtime, "licenses"), { recursive: true });
copyFileSync(resolve(root, "python/faster_whisper/THIRD-PARTY-NOTICES.md"), resolve(runtime, "THIRD-PARTY-NOTICES.md"));
