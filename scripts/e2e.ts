// End to end, like a user: build and pack the package, install the tarball into a clean consumer, run the CLI with
// Node.js on every example spec, type-check each client with TypeScript 7, then compile and run input/smoke.ts.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const consumerDirectory = join(repositoryRoot, "tmp", "e2e", "consumer");
const outputDirectory = join(repositoryRoot, "output");
const clientsDirectory = join(outputDirectory, "clients");
const TYPESCRIPT_VERSION = "7.0.2";

function log(level: "INFO" | "ERROR", message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${level} ${message}\n`);
}

/** Runs a command, streams nothing, and fails with its output when it exits non-zero. */
function run(command: string, commandArguments: string[], workingDirectory: string): string {
  const result = spawnSync(command, commandArguments, { cwd: workingDirectory, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArguments.join(" ")} exited ${result.status}:\n${output}`);
  }
  return output;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const STRICT_OPTIONS = {
  strict: true,
  noUncheckedIndexedAccess: true,
  target: "es2022",
  module: "nodenext",
  moduleResolution: "nodenext",
  lib: ["es2022", "dom"],
  types: ["node"],
  skipLibCheck: true,
};

// 1. Build and pack the package exactly as it would be published.
rmSync(join(repositoryRoot, "tmp", "e2e"), { recursive: true, force: true });
mkdirSync(consumerDirectory, { recursive: true });
run("bun", ["run", "build"], repositoryRoot);
run("bun", ["pm", "pack", "--destination", join(repositoryRoot, "tmp", "e2e")], repositoryRoot);
const tarball = readdirSync(join(repositoryRoot, "tmp", "e2e")).find((name) => name.endsWith(".tgz"));
if (tarball === undefined) {
  throw new Error("bun pm pack produced no tarball");
}
log("INFO", `packed ${tarball}`);

// 2. A clean consumer project that installs only the tarball, TypeScript 7 and Node types.
writeJson(join(consumerDirectory, "package.json"), { name: "e2e-consumer", private: true, type: "module" });
run("bun", ["add", join(repositoryRoot, "tmp", "e2e", tarball), `typescript@${TYPESCRIPT_VERSION}`, "@types/node@24"], consumerDirectory);
const cli = join(consumerDirectory, "node_modules", ".bin", "open-api-gen");
const tsc = join(consumerDirectory, "node_modules", ".bin", "tsc");

// 3. Every example spec through the installed CLI, on Node.js, and each client through tsc --strict.
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(clientsDirectory, { recursive: true });
writeJson(join(outputDirectory, "package.json"), { type: "module" });
// Every spec file under examples/, including the well-known public APIs in examples/well-known/.
const examples = readdirSync(join(repositoryRoot, "examples"), { recursive: true, encoding: "utf8" })
  .filter((path) => /\.(json|yaml)$/.test(path))
  .sort();
for (const example of examples) {
  const name = example.replace(/\.(json|yaml)$/, "").replaceAll("/", "-");
  const clientDirectory = join(clientsDirectory, name);
  // The well-known specs use snake_case and unusual names (GitHub's "+1"/"-1"), so they also exercise camelCase naming.
  const namingArguments = example.startsWith("well-known/") ? ["--naming", "camelCase"] : [];
  const started = performance.now();
  const cliOutput = run("node", [cli, join(repositoryRoot, "examples", example), "-o", clientDirectory, ...namingArguments], repositoryRoot);
  const generateMilliseconds = Math.round(performance.now() - started);
  const warnings = cliOutput.split("\n").filter((line) => line.includes(" WARN ")).length;

  const tsconfigPath = join(outputDirectory, `tsconfig.${name}.json`);
  writeJson(tsconfigPath, { compilerOptions: { ...STRICT_OPTIONS, noEmit: true, typeRoots: [join(consumerDirectory, "node_modules", "@types")] }, include: [`clients/${name}/**/*.ts`] });
  const checkStarted = performance.now();
  run("node", [tsc, "-p", tsconfigPath], consumerDirectory);
  const checkMilliseconds = Math.round(performance.now() - checkStarted);
  // A second run into the same directory must succeed: users regenerate after every spec change.
  run("node", [cli, join(repositoryRoot, "examples", example), "-o", clientDirectory, ...namingArguments], repositoryRoot);
  const fileCount = readdirSync(clientDirectory, { recursive: true }).length;
  log("INFO", `${name}: generated in ${generateMilliseconds} ms (${warnings} warnings, ${fileCount} entries), tsc --strict ok in ${checkMilliseconds} ms`);
}

// 3b. A multi-file document: external $refs bundled by the installed CLI, the reference root widened by --ref-root.
const multiFileRoot = join(repositoryRoot, "test", "fixtures", "multi-file");
const multiFileDirectory = join(clientsDirectory, "multi-file");
const multiFileOutput = run("node", [cli, join(multiFileRoot, "openapi.yaml"), "-o", multiFileDirectory, "--ref-root", join(repositoryRoot, "test", "fixtures")], repositoryRoot);
const multiFileConfigPath = join(outputDirectory, "tsconfig.multi-file.json");
writeJson(multiFileConfigPath, { compilerOptions: { ...STRICT_OPTIONS, noEmit: true, typeRoots: [join(consumerDirectory, "node_modules", "@types")] }, include: ["clients/multi-file/**/*.ts"] });
run("node", [tsc, "-p", multiFileConfigPath], consumerDirectory);
if (!readdirSync(join(multiFileDirectory, "interface", "components")).includes("Owner.ts")) {
  throw new Error("multi-file: the schema from schemas/owner.yaml was not bundled into interface/components/Owner.ts");
}
const multiFileSummary = multiFileOutput.split("\n").find((line) => line.includes(" INFO generated ")) ?? multiFileOutput.trim();
log("INFO", `multi-file (external $refs, --ref-root): ${multiFileSummary.replace(/^\S+ INFO /, "")}, tsc --strict ok`);

// 3c. Webhooks and callbacks: the smoke consumer parses payloads through this client's parseWebhook.
run("node", [cli, join(repositoryRoot, "test", "fixtures", "webhooks-3.1.yaml"), "-o", join(clientsDirectory, "webhooks"), "--naming", "camelCase"], repositoryRoot);

// 4. The configured client (overlay + filter + camelCase + Date + Decimal hook), compiled with the consumer program.
// VERIFIED: input/smoke.ts checks the Decimal hook, which comes from --transformer, so flag and config file merge in one run.
const decimalTransformer = "format:int64=Decimal,../../../input/hooks/decimal.ts,toDecimal,fromDecimal";
const configOutput = run("node", [cli, "--config", join(repositoryRoot, "input", "open-api-gen.config.json"), "--transformer", decimalTransformer], repositoryRoot);
const configSummary = configOutput.split("\n").find((line) => line.includes(" INFO generated ")) ?? configOutput.trim();
log("INFO", `petstore-app (overlay, filter, camelCase, Date, Decimal hook): ${configSummary.replace(/^\S+ INFO /, "")}`);
const smokeDirectory = join(outputDirectory, "smoke");
mkdirSync(smokeDirectory, { recursive: true });
copyFileSync(join(repositoryRoot, "input", "smoke.ts"), join(smokeDirectory, "smoke.ts"));
const smokeConfigPath = join(outputDirectory, "tsconfig.smoke.json");
writeJson(smokeConfigPath, {
  compilerOptions: { ...STRICT_OPTIONS, outDir: "build", rootDir: "..", typeRoots: [join(consumerDirectory, "node_modules", "@types")] },
  include: ["clients/petstore-app/**/*.ts", "clients/webhooks/**/*.ts", "smoke/smoke.ts", "../input/hooks/*.ts"],
});
run("node", [tsc, "-p", smokeConfigPath], consumerDirectory);
writeJson(join(outputDirectory, "build", "package.json"), { type: "module" });
const smokeOutput = run("node", [join(outputDirectory, "build", "output", "smoke", "smoke.js")], repositoryRoot);
process.stdout.write(smokeOutput);
log("INFO", `e2e passed: ${examples.length} example clients and the smoke consumer; results in ${relative(repositoryRoot, outputDirectory)}/`);
