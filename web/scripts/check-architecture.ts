import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = path.join(root, "tsconfig.json");
const input = ts.readConfigFile(configPath, ts.sys.readFile);
if (input.error) throw new Error(ts.flattenDiagnosticMessageText(input.error.messageText, "\n"));
const config = ts.parseJsonConfigFileContent(input.config, ts.sys, root);
const program = ts.createProgram(config.fileNames, config.options);
const sources = program
  .getSourceFiles()
  .filter(
    (file) => file.fileName.startsWith(root) && !file.fileName.includes("/node_modules/") && !file.isDeclarationFile,
  );
const known = new Set(sources.map((file) => file.fileName));
const graph = new Map<string, string[]>();

for (const source of sources) {
  const emitted = ts.transpileModule(source.text, {
    fileName: source.fileName,
    compilerOptions: { ...config.options, noEmit: false },
  }).outputText;
  const ast = ts.createSourceFile(source.fileName, emitted, ts.ScriptTarget.Latest, true);
  const targets = new Set<string>();
  const inspect = (node: ts.Node) => {
    let specifier: string | undefined;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifier = node.moduleSpecifier.text;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      specifier = node.arguments[0].text;
    if (specifier) {
      const target = ts.resolveModuleName(specifier, source.fileName, config.options, ts.sys).resolvedModule
        ?.resolvedFileName;
      if (target && known.has(target)) targets.add(target);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(ast);
  graph.set(source.fileName, [...targets]);
}

const frontend = path.join(root, "frontend");
const editor = path.join(root, "editor/src");
const pure = ["models", "api", "services", "state", "storage"].map(
  (directory) => path.join(frontend, directory) + path.sep,
);
const ui = ["runtime", "components"].map((directory) => path.join(frontend, directory) + path.sep);
const violations = new Set<string>();

function trace(entry: string, forbidden: (file: string) => boolean, checkCycles: boolean) {
  const visited = new Set<string>();
  const visit = (file: string, chain: string[]) => {
    if (forbidden(file)) {
      violations.add(chain.map((file) => path.relative(root, file)).join(" -> "));
      return;
    }
    if (chain.slice(0, -1).includes(file)) {
      if (checkCycles)
        violations.add(`Lower-layer cycle: ${chain.map((file) => path.relative(root, file)).join(" -> ")}`);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    for (const target of graph.get(file) ?? []) visit(target, [...chain, target]);
  };
  visit(entry, [entry]);
}

for (const source of sources) {
  if (pure.some((directory) => source.fileName.startsWith(directory))) {
    trace(source.fileName, (file) => ui.some((directory) => file.startsWith(directory)), true);
  }
  if (source.fileName.startsWith(editor + path.sep)) {
    trace(source.fileName, (file) => file.startsWith(frontend + path.sep), false);
  }
}
const runtime = path.join(frontend, "runtime") + path.sep;
const bootstrap = path.join(runtime, "core/bootstrap.ts");
const contextDependencies = new Set([
  bootstrap,
  path.join(runtime, "core/notice.ts"),
  path.join(runtime, "lifecycle.ts"),
]);
trace(bootstrap, (file) => file.startsWith(runtime) && !contextDependencies.has(file), true);
const events = path.join(runtime, "core/events.ts");
const projectGateway = path.join(runtime, "projects/gateway.ts");
for (const [source, targets] of graph) {
  if (source !== path.join(runtime, "application.ts") && targets.includes(events))
    violations.add(
      `Event wiring is composition-only: ${path.relative(root, source)} -> ${path.relative(root, events)}`,
    );
}
for (const source of sources) {
  if (!source.fileName.startsWith(runtime) || source.fileName === projectGateway) continue;
  const inspectProjectRequests = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "api" || node.expression.text === "requestApi") &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.split("?")[0] === "/api/projects"
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      violations.add(`Project requests must use the scoped gateway: ${path.relative(root, source.fileName)}:${line}`);
    }
    ts.forEachChild(node, inspectProjectRequests);
  };
  inspectProjectRequests(source);
}
if (violations.size) throw new Error(`Architecture boundaries must remain explicit:\n${[...violations].join("\n")}`);
console.log(
  "Architecture boundaries passed: pure application layers, independent editor ownership and controller-free bootstrap.",
);
