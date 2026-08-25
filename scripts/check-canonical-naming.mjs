import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const wholeFileAllowlist = new Set([
  "docs/adr/0001-node-runtime-migration.md",
  "docs/adr/0003-anomaloharis-canonical-naming.md",
  "docs/adr/0004-peer-agent-and-workflow-runtimes.md",
  "docs/design/pi-inspired-node-runtime.md",
  "scripts/check-canonical-naming.mjs",
]);

const forbidden = [
  /\bAnomalo\b/g,
  /\banomalo\b/g,
  /@anomalo\//g,
  /\banomalo\.dev\b/g,
  /\bANOMALO_[A-Z0-9_]*\b/g,
  /\bX-Anomalo-[A-Za-z0-9-]+\b/g,
  /\bx-anomalo-[a-z0-9-]+\b/g,
  /\banomalo@[1-9][0-9]*\b/g,
];

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root })
  .toString()
  .split("\0")
  .filter(Boolean);
const findings = [];

for (const relativePath of files) {
  if (
    relativePath.startsWith("node_modules/") ||
    relativePath.startsWith("data/") ||
    relativePath.startsWith("runtime-bundle/app/frontend/")
  ) continue;
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath)) continue;
  const bytes = readFileSync(absolutePath);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  if (wholeFileAllowlist.has(relativePath)) continue;
  for (const [lineNumber, line] of text.split(/\r?\n/).entries()) {
    if (line.includes("naming-compat")) continue;
    for (const pattern of forbidden) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) findings.push(`${relativePath}:${lineNumber + 1}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Canonical naming Gate failed. Legacy identifiers found outside the allowlist:");
  for (const path of [...new Set(findings)].sort()) console.error(`- ${path}`);
  process.exit(1);
}

console.log(`Canonical naming Gate passed (${files.length} files scanned).`);
