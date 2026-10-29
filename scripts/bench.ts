// Times each stage on the largest example (Jira: 444 operations, 1041 declarations). Median of five runs.
import { join } from "node:path";
import { emit } from "../src/emit/index.ts";
import { buildIntermediateFormat, prepareDocument } from "../src/intermediate-format/build.ts";
import { loadConfig } from "../src/intermediate-format/config.ts";

const input = join(import.meta.dir, "..", "examples", "open-api-jira.json");
const config = await loadConfig(undefined, { input, output: "unused" });

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const timings = { prepare: [] as number[], stage1: [] as number[], stage2: [] as number[] };
let fileCount = 0;
for (let run = 0; run < 5; run++) {
  let started = performance.now();
  const prepared = await prepareDocument(config);
  timings.prepare.push(performance.now() - started);
  started = performance.now();
  const intermediateFormat = await buildIntermediateFormat(config, prepared);
  timings.stage1.push(performance.now() - started);
  started = performance.now();
  fileCount = emit(intermediateFormat).size;
  timings.stage2.push(performance.now() - started);
}
const format = (values: number[]) => `${median(values).toFixed(0)} ms`;
console.log(`jira: load+overlay+validate+filter ${format(timings.prepare)}, normalize+plan ${format(timings.stage1)}, emit ${format(timings.stage2)} (${fileCount} files)`);
