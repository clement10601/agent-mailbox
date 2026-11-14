import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Builds the Rust worker once (cargo + worker-build via wrangler's [build] command) for all test files.
// Set SKIP_WORKER_BUILD=1 to reuse an existing .wrangler/test-build.
export default function setup(): void {
  const root = join(__dirname, "..");
  const out = join(root, ".wrangler/test-build");
  if (process.env.SKIP_WORKER_BUILD === "1" && existsSync(join(out, "index.js"))) return;
  execSync("npx wrangler deploy --dry-run --outdir .wrangler/test-build", { cwd: root, stdio: "inherit" });
}
