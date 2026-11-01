// src/batch.ts
import { ToolCallId } from "@deepseek-ai/dsh-llm/brand";

// src/concurrency.ts
var READ_ONLY_COMMANDS = /* @__PURE__ */ new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "ag",
  "find",
  "fd",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "pwd",
  "which",
  "type",
  "date",
  "uname",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "sort",
  "uniq",
  "cut",
  "diff",
  "cmp",
  "tr",
  "nl",
  "fold",
  "expand",
  "env",
  "printenv",
  "sleep",
  "true",
  "false"
]);
var UNSAFE_FLAGS = {
  find: ["-exec", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"],
  grep: ["--pre", "--pre-glob"],
  rg: ["--pre", "--pre-glob"],
  sort: ["-o", "--output"],
  tail: ["-f", "--follow"],
  head: ["-f"],
  cat: ["-"]
};
var UNSAFE_OUTSIDE_QUOTES = [">", "<", "&", ";", "|", "`", "$", "(", ")", "{", "}", "#", "\\"];
var SEPARATORS = [" ", "	"];
function lexCommand(text) {
  const words = [];
  let current = "";
  let started = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (SEPARATORS.includes(character)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      index += 1;
      continue;
    }
    if (character === "\n" || character === "\r") return void 0;
    if (character === "'") {
      const end = text.indexOf("'", index + 1);
      if (end === -1) return void 0;
      current += text.slice(index + 1, end);
      started = true;
      index = end + 1;
      continue;
    }
    if (character === '"') {
      let scan = index + 1;
      while (scan < text.length && text[scan] !== '"') {
        const inner = text[scan];
        if (inner === "$" || inner === "`") return void 0;
        scan += 1;
      }
      if (scan >= text.length) return void 0;
      current += text.slice(index + 1, scan);
      started = true;
      index = scan + 1;
      continue;
    }
    if (UNSAFE_OUTSIDE_QUOTES.includes(character)) return void 0;
    current += character;
    started = true;
    index += 1;
  }
  if (started) words.push(current);
  return words;
}
function isReadOnlyCommand(command) {
  if (typeof command !== "string") return false;
  const text = command.trim();
  if (text === "") return false;
  const words = lexCommand(text);
  if (words === void 0 || words.length === 0) return false;
  const executable = words[0];
  if (executable === void 0) return false;
  const name = executable.split(/[/\\]/u).pop() ?? executable;
  if (!READ_ONLY_COMMANDS.has(name)) return false;
  const unsafe = UNSAFE_FLAGS[name];
  if (unsafe === void 0) return true;
  for (const token of words.slice(1)) {
    for (const flag of unsafe) {
      if (token === flag || token.startsWith(`${flag}=`)) return false;
    }
  }
  return true;
}
function buildOverrides(concurrentTools, concurrentShell, shellTool) {
  const overrides = {};
  for (const tool of concurrentTools) {
    if (tool === shellTool) continue;
    overrides[tool] = { kind: "always" };
  }
  if (concurrentShell) overrides[shellTool] = { kind: "read-only" };
  return overrides;
}
function mayRunTogether(toolName, args, ownAnswer, overrides) {
  if (ownAnswer) return true;
  const override = overrides[toolName];
  if (override === void 0) return false;
  if (override.kind === "always") return true;
  const command = args?.command;
  return isReadOnlyCommand(command);
}

// src/batch.ts
function contentToText(content, value) {
  const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (text.trim() !== "") return text;
  if (value === void 0) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
var callSequence = 0;
function nextCallId() {
  callSequence += 1;
  return ToolCallId(`refine-loop:${process.pid}:${callSequence}`);
}
var MAX_REPAIRS = 2;
async function runOne(runner, call, agent, signal, scheduled, rootCallId, repair) {
  let name = call.name;
  let args = call.arguments;
  const tries = repair === void 0 ? 1 : MAX_REPAIRS + 1;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    let output = "";
    let error = "the call failed";
    try {
      const result = await runner.execute({
        callId: nextCallId(),
        rootCallId,
        name,
        arguments: args,
        ...agent === void 0 ? {} : { agent },
        signal
      });
      output = contentToText(result.content, result.value);
      if (!result.isError) {
        return { name: call.name, ok: true, scheduled, output, error: "" };
      }
      error = result.error?.message ?? "the call failed";
    } catch (caught) {
      error = errorMessage(caught);
    }
    if (repair === void 0 || attempt === tries - 1) {
      return { name: call.name, ok: false, scheduled, output, error };
    }
    const fixed = await repair({ name, arguments: args }, error, signal);
    if (fixed === void 0) {
      return { name: call.name, ok: false, scheduled, output, error };
    }
    name = fixed.name;
    args = fixed.arguments;
  }
  return { name: call.name, ok: false, scheduled, output: "", error: "the call failed" };
}
async function runBatch(runner, args, agent, signal, respectConcurrencySafety, rootCallId, overrides = {}, repair) {
  const calls = args.calls;
  const results = new Array(calls.length);
  const waves = [];
  for (const [index, call] of calls.entries()) {
    const mode = runner.executionMode({
      callId: nextCallId(),
      name: call.name,
      arguments: call.arguments,
      ...agent === void 0 ? {} : { agent },
      signal
    });
    const safe = !respectConcurrencySafety || mayRunTogether(call.name, call.arguments, mode.kind === "parallel", overrides);
    const last = waves[waves.length - 1];
    if (safe && last !== void 0 && last.concurrent) {
      last.indexes.push(index);
      continue;
    }
    waves.push({ indexes: [index], concurrent: safe });
  }
  for (const wave of waves) {
    if (wave.concurrent) {
      await Promise.all(wave.indexes.map(async (index) => {
        const call = calls[index];
        if (call === void 0) return;
        results[index] = await runOne(runner, call, agent, signal, "concurrent", rootCallId, repair);
      }));
      continue;
    }
    for (const index of wave.indexes) {
      const call = calls[index];
      if (call === void 0) continue;
      results[index] = await runOne(runner, call, agent, signal, "serial", rootCallId, repair);
    }
  }
  const concurrentCount = waves.filter((wave) => wave.concurrent).length;
  const schedule = concurrentCount === waves.length ? "concurrent" : concurrentCount === 0 ? "serial" : "mixed";
  return { criteria: args.criteria, schedule, results: results.filter((item) => item !== void 0) };
}

// verify/concurrency.spec.ts
var failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === "" ? "" : ` \u2014 ${detail}`}`);
}
console.log("isReadOnlyCommand");
{
  check("reads ls", isReadOnlyCommand("ls -la"));
  check("reads cat", isReadOnlyCommand("cat package.json"));
  check("reads grep", isReadOnlyCommand('grep -r "name" src'));
  check("reads an absolute path", isReadOnlyCommand("/usr/bin/ls"));
  check("reads a command with a glob", isReadOnlyCommand('find . -name "*.ts"'));
  check("refuses rm", !isReadOnlyCommand("rm file.txt"));
  check("refuses npm install", !isReadOnlyCommand("npm install"));
  check("refuses node -e", !isReadOnlyCommand('node -e "process.exit(1)"'));
  check("refuses a redirection", !isReadOnlyCommand("echo hello > file.txt"));
  check("refuses an append", !isReadOnlyCommand("echo hello >> file.txt"));
  check("refuses a chain", !isReadOnlyCommand("ls && rm file.txt"));
  check("refuses a pipe", !isReadOnlyCommand("cat file.txt | grep x"));
  check("refuses a separator", !isReadOnlyCommand("ls; rm file.txt"));
  check("refuses a substitution", !isReadOnlyCommand("ls $(pwd)"));
  check("refuses a backtick", !isReadOnlyCommand("ls `pwd`"));
  check("refuses a background job", !isReadOnlyCommand("ls &"));
  check("reads a quoted pattern", isReadOnlyCommand('grep "a|b" file.txt'));
  check("reads a single-quoted dollar", isReadOnlyCommand("cat '$(rm x)'"));
  check("refuses echo", !isReadOnlyCommand("echo hello"));
  check("refuses an expansion inside double quotes", !isReadOnlyCommand('echo "$(rm x)"'));
  check("refuses find -exec", !isReadOnlyCommand("find . -exec rm {} +"));
  check("refuses find -delete", !isReadOnlyCommand("find . -delete"));
  check("refuses sort -o", !isReadOnlyCommand("sort -o out.txt file.txt"));
  check("refuses tail -f", !isReadOnlyCommand("tail -f log.txt"));
  check("refuses an empty command", !isReadOnlyCommand("   "));
  check("refuses a non-string", !isReadOnlyCommand(void 0));
}
console.log("mayRunTogether");
{
  const overrides = { glob: { kind: "always" }, ops_bash: { kind: "read-only" } };
  check("a tool that says it is safe is safe", mayRunTogether("read", {}, true, overrides));
  check("a tool that says nothing is not safe", !mayRunTogether("read", {}, false, overrides));
  check("an always override is safe", mayRunTogether("glob", {}, false, overrides));
  check(
    "a read-only override judges the command",
    mayRunTogether("ops_bash", { command: "ls -la" }, false, overrides)
  );
  check(
    "a read-only override refuses a writer",
    !mayRunTogether("ops_bash", { command: "rm file.txt" }, false, overrides)
  );
  check(
    "a read-only override refuses a missing command",
    !mayRunTogether("ops_bash", {}, false, overrides)
  );
}
console.log("buildOverrides");
{
  const overrides = buildOverrides(["glob", "grep", "ops_bash"], true, "ops_bash");
  check("lists the flat tools", overrides.glob !== void 0 && overrides.grep !== void 0);
  check(
    "the shell tool is judged by the read-only rule",
    overrides.ops_bash?.kind === "read-only"
  );
  const withoutShell = buildOverrides(["glob"], false, "ops_bash");
  check("the shell tool is absent when the rule is off", withoutShell.ops_bash === void 0);
}
console.log("the order of a batch is the order of the plan");
{
  const order = [];
  const runner = {
    executionMode: (exec) => ({ kind: exec.name === "exclusive" ? "exclusive" : "parallel" }),
    async execute(exec) {
      order.push(`start:${exec.name}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`end:${exec.name}`);
      return { isError: false, value: exec.name, content: [{ type: "text", text: exec.name }] };
    }
  };
  await runBatch(
    runner,
    {
      criteria: ["every call ran"],
      calls: [
        { name: "a", arguments: {} },
        { name: "exclusive", arguments: {} },
        { name: "b", arguments: {} }
      ]
    },
    void 0,
    new AbortController().signal,
    true
  );
  check(
    "the exclusive call starts after the first one finished",
    order.indexOf("start:exclusive") > order.indexOf("end:a")
  );
  check(
    "the last call starts after the exclusive one finished",
    order.indexOf("start:b") > order.indexOf("end:exclusive")
  );
}
if (failures > 0) {
  console.error(`
${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
