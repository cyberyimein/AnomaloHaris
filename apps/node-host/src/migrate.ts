import { migrateLegacyDatabase } from "./sqlite.js";

const args = new Set(process.argv.slice(2));
const dbFlag = process.argv.find((value) => value === "--db" || value.startsWith("--db="));
const dbPath = dbFlag?.startsWith("--db=")
  ? dbFlag.slice("--db=".length)
  : process.argv[process.argv.indexOf("--db") + 1];

if (!dbPath) {
  console.error("Usage: npm run migrate -- --db <path> [--dry-run]");
  process.exitCode = 2;
} else {
  const report = migrateLegacyDatabase(dbPath, { dryRun: args.has("--dry-run") });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.errors.length > 0) process.exitCode = 1;
}
