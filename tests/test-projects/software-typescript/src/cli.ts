import { readFileSync } from "node:fs";
import { parseTrace, summarize } from "./summary.ts";

const input = process.argv[2];
if (process.argv.length !== 3 || !input) {
  console.error("Usage: bun run src/cli.ts <trace.csv>");
  process.exit(2);
}

const csv = readFileSync(input, "utf8");
console.log(JSON.stringify(summarize(parseTrace(csv)), null, 2));
