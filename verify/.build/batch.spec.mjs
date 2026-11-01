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
async function runOne(runner, call, agent, signal2, scheduled, rootCallId, repair) {
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
        signal: signal2
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
    const fixed = await repair({ name, arguments: args }, error, signal2);
    if (fixed === void 0) {
      return { name: call.name, ok: false, scheduled, output, error };
    }
    name = fixed.name;
    args = fixed.arguments;
  }
  return { name: call.name, ok: false, scheduled, output: "", error: "the call failed" };
}
async function runBatch(runner, args, agent, signal2, respectConcurrencySafety, rootCallId, overrides = {}, repair) {
  const calls = args.calls;
  const results = new Array(calls.length);
  const waves = [];
  for (const [index, call] of calls.entries()) {
    const mode = runner.executionMode({
      callId: nextCallId(),
      name: call.name,
      arguments: call.arguments,
      ...agent === void 0 ? {} : { agent },
      signal: signal2
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
        results[index] = await runOne(runner, call, agent, signal2, "concurrent", rootCallId, repair);
      }));
      continue;
    }
    for (const index of wave.indexes) {
      const call = calls[index];
      if (call === void 0) continue;
      results[index] = await runOne(runner, call, agent, signal2, "serial", rootCallId, repair);
    }
  }
  const concurrentCount = waves.filter((wave) => wave.concurrent).length;
  const schedule = concurrentCount === waves.length ? "concurrent" : concurrentCount === 0 ? "serial" : "mixed";
  return { criteria: args.criteria, schedule, results: results.filter((item) => item !== void 0) };
}

// verify/batch.spec.ts
var failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === "" ? "" : ` \u2014 ${detail}`}`);
}
function createRunner(exclusive, delayMs) {
  const recorded = [];
  const runner = {
    executionMode(exec) {
      return { kind: exclusive.includes(exec.name) ? "exclusive" : "parallel" };
    },
    async execute(exec) {
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const end = Date.now();
      recorded.push({ name: exec.name, start, end });
      return {
        isError: false,
        value: exec.name,
        content: [{ type: "text", text: `${exec.name} done` }]
      };
    }
  };
  return { runner, recorded };
}
function overlapped(a, b) {
  return a.start < b.end && b.start < a.end;
}
function plan(names) {
  return {
    criteria: ["every call ran"],
    calls: names.map((name) => ({ name, arguments: {} }))
  };
}
var signal = new AbortController().signal;
console.log("a batch of parallel-safe calls runs together");
{
  const { runner, recorded } = createRunner([], 120);
  const started = Date.now();
  const output = await runBatch(runner, plan(["a", "b", "c"]), void 0, signal, true);
  const elapsed = Date.now() - started;
  check("every call ran", output.results.length === 3);
  check("every call succeeded", output.results.every((item) => item.ok));
  check("the schedule is concurrent", output.schedule === "concurrent");
  check("every call is marked concurrent", output.results.every((item) => item.scheduled === "concurrent"));
  check("the windows overlap", recorded.length === 3 && overlapped(recorded[0], recorded[1]) && overlapped(recorded[1], recorded[2]));
  check("the batch took less than three calls", elapsed < 300, `took ${elapsed}ms`);
  check(
    "the results keep the plan order",
    output.results[0]?.name === "a" && output.results[2]?.name === "c"
  );
}
console.log("a batch honours a tool that declares itself exclusive");
{
  const { runner, recorded } = createRunner(["b"], 120);
  const output = await runBatch(runner, plan(["a", "b", "c"]), void 0, signal, true);
  check("every call ran", output.results.length === 3);
  check("the schedule is mixed", output.schedule === "mixed");
  check("the exclusive call is marked serial", output.results[1]?.scheduled === "serial");
  check(
    "the other calls are marked concurrent",
    output.results[0]?.scheduled === "concurrent" && output.results[2]?.scheduled === "concurrent"
  );
  const first = recorded.find((entry) => entry.name === "a");
  const exclusive = recorded.find((entry) => entry.name === "b");
  const last = recorded.find((entry) => entry.name === "c");
  check(
    "the exclusive call did not overlap the concurrent ones",
    first !== void 0 && exclusive !== void 0 && last !== void 0 && !overlapped(first, exclusive) && !overlapped(exclusive, last)
  );
}
console.log("a deployment that trusts its tools can run them together anyway");
{
  const { runner, recorded } = createRunner(["a", "b"], 120);
  const output = await runBatch(runner, plan(["a", "b"]), void 0, signal, false);
  check("the schedule is concurrent", output.schedule === "concurrent");
  check("the windows overlap", recorded.length === 2 && overlapped(recorded[0], recorded[1]));
}
console.log("a call that fails is reported, not thrown");
{
  const runner = {
    executionMode: () => ({ kind: "parallel" }),
    async execute(exec) {
      if (exec.name === "bad") {
        return {
          isError: true,
          value: null,
          content: [{ type: "text", text: "it failed" }],
          error: { message: "the call failed" }
        };
      }
      return { isError: false, value: "ok", content: [{ type: "text", text: "ok" }] };
    }
  };
  const output = await runBatch(runner, plan(["good", "bad"]), void 0, signal, true);
  check("the batch finished", output.results.length === 2);
  check("the good call succeeded", output.results[0]?.ok === true);
  check("the bad call failed", output.results[1]?.ok === false);
  check("the failure carries its message", output.results[1]?.error === "the call failed");
  check("the failure carries its output", output.results[1]?.output === "it failed");
}
if (failures > 0) {
  console.error(`
${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
