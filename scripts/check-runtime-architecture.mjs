import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function source(path) {
  return readFileSync(resolve(root, path), "utf8");
}

const violations = [];
const agentCore = source("apps/node-host/src/core.ts");
for (const forbidden of ["@anomaloharis/workflow-runtime", "./workflow-runtime", "./workflow-api", "./run-control"]) {
  if (agentCore.includes(forbidden)) violations.push(`AgentCore imports forbidden Workflow/Run Control dependency: ${forbidden}`);
}

for (const path of ["apps/node-host/src/host.ts", "apps/node-host/src/compute-api.ts"]) {
  const value = source(path);
  if (/\bcontroller\.start\s*\(/u.test(value) || /options\.controller\.start\s*\(/u.test(value)) {
    violations.push(`${path} starts AgentCore outside the Agent Runtime Adapter`);
  }
  if (/if\s*\(\s*!?options\.runControl\s*\)/u.test(value)) {
    violations.push(`${path} contains an optional Run Control execution fallback`);
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`[runtime-architecture] ${violation}`);
  process.exitCode = 1;
} else {
  console.log("[runtime-architecture] AgentCore dependency direction and unified Run Control entry points are valid.");
}
