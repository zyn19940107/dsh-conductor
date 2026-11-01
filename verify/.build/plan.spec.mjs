// src/tool.ts
import { ToolCallId as ToolCallId2 } from "@deepseek-ai/dsh-llm/brand";
import { defineTool } from "@deepseek-ai/dsh-tools";

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
function renderBatch(output) {
  const lines = [];
  lines.push(`Batch finished \u2014 ${output.results.length} call(s), scheduled ${output.schedule}.`);
  lines.push(`Criteria: ${output.criteria.join("; ")}`);
  lines.push("");
  for (const [index, item] of output.results.entries()) {
    lines.push(`${index + 1}. ${item.name} \u2014 ${item.ok ? "ok" : "failed"} (${item.scheduled})`);
    if (item.error !== "") lines.push(`   error: ${item.error}`);
    if (item.output !== "") {
      lines.push("   output:");
      for (const line of item.output.split("\n")) lines.push(`   | ${line}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// src/plan.ts
var PLACEHOLDER = /^@@([^@]+)@@$/u;
function parsePlanArgs(value) {
  const record = value ?? {};
  const criteria = record.criteria;
  const nodes = record.nodes;
  if (!Array.isArray(criteria) || !Array.isArray(nodes)) return void 0;
  const parsedCriteria = criteria.filter((entry) => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
  if (parsedCriteria.length === 0) return void 0;
  const parsedNodes = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of nodes) {
    if (entry === null || typeof entry !== "object") return void 0;
    const item = entry;
    const id = item.id;
    const kind = item.kind;
    if (typeof id !== "string" || id.trim() === "") return void 0;
    if (typeof kind !== "string") return void 0;
    if (kind !== "tools" && kind !== "subagent" && kind !== "subagent_fork") return void 0;
    const nodeId = id.trim();
    if (seen.has(nodeId)) return void 0;
    seen.add(nodeId);
    const after = Array.isArray(item.after) ? item.after.filter((dep) => typeof dep === "string" && dep.trim() !== "").map((dep) => dep.trim()) : [];
    if (kind === "tools") {
      const calls = item.calls;
      if (!Array.isArray(calls) || calls.length === 0) return void 0;
      const parsedCalls = [];
      for (const call of calls) {
        if (call === null || typeof call !== "object") return void 0;
        const callItem = call;
        const name = callItem.name;
        if (typeof name !== "string" || name.trim() === "") return void 0;
        const args = callItem.arguments;
        parsedCalls.push({ name: name.trim(), arguments: args === void 0 ? {} : args });
      }
      parsedNodes.push({ id: nodeId, kind, calls: parsedCalls, task: "", after });
      continue;
    }
    const task = item.task;
    if (typeof task !== "string" || task.trim() === "") return void 0;
    parsedNodes.push({ id: nodeId, kind, calls: [], task: task.trim(), after });
  }
  if (parsedNodes.length === 0) return void 0;
  for (const node2 of parsedNodes) {
    for (const call of node2.calls) {
      for (const referenced of collectPlaceholders(call.arguments)) {
        if (!node2.after.includes(referenced)) node2.after.push(referenced);
      }
    }
  }
  return { criteria: parsedCriteria, nodes: parsedNodes };
}
function collectPlaceholders(value) {
  const found = [];
  const walk = (entry) => {
    if (typeof entry === "string") {
      const match = PLACEHOLDER.exec(entry);
      if (match !== null && !found.includes(match[1])) found.push(match[1]);
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) walk(item);
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const item of Object.values(entry)) walk(item);
    }
  };
  walk(value);
  return found;
}
function buildWaves(nodes) {
  const byId = /* @__PURE__ */ new Map();
  for (const node2 of nodes) {
    if (byId.has(node2.id)) return { error: `two nodes are called "${node2.id}"` };
    byId.set(node2.id, node2);
  }
  for (const node2 of nodes) {
    for (const dependency of node2.after) {
      if (dependency === node2.id) return { error: `the node "${node2.id}" depends on itself` };
      if (!byId.has(dependency)) {
        return { error: `the node "${node2.id}" depends on "${dependency}", which is not a node of this plan` };
      }
    }
  }
  const depth = /* @__PURE__ */ new Map();
  const visiting = /* @__PURE__ */ new Set();
  const depthOf = (node2) => {
    const known = depth.get(node2.id);
    if (known !== void 0) return known;
    if (visiting.has(node2.id)) return void 0;
    visiting.add(node2.id);
    let layer = 0;
    for (const dependency of node2.after) {
      const dependencyNode = byId.get(dependency);
      if (dependencyNode === void 0) return void 0;
      const dependencyDepth = depthOf(dependencyNode);
      if (dependencyDepth === void 0) return void 0;
      layer = Math.max(layer, dependencyDepth + 1);
    }
    visiting.delete(node2.id);
    depth.set(node2.id, layer);
    return layer;
  };
  for (const node2 of nodes) {
    if (depthOf(node2) === void 0) {
      return { error: "the dependencies of the plan form a cycle, so no node can run first" };
    }
  }
  const layers = Math.max(...nodes.map((node2) => depth.get(node2.id) ?? 0)) + 1;
  const waves = Array.from({ length: layers }, () => []);
  for (const node2 of nodes) {
    waves[depth.get(node2.id) ?? 0].push(node2);
  }
  return { waves };
}
function dependenciesOf(node2, byId) {
  const dependencies = [];
  for (const id of node2.after) {
    const dependency = byId.get(id);
    if (dependency !== void 0) dependencies.push(dependency);
  }
  return dependencies;
}
function substitutePlaceholders(value, outputs) {
  if (typeof value === "string") {
    const match = PLACEHOLDER.exec(value);
    if (match === null) return value;
    const id = match[1];
    const output = outputs.get(id);
    if (output === void 0) {
      throw new Error(`the argument refers to the output of "${id}", and that node has not produced one`);
    }
    return output;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substitutePlaceholders(entry, outputs));
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = substitutePlaceholders(entry, outputs);
    }
    return result;
  }
  return value;
}

// src/tool.ts
var planSequence = 0;
function nextPlanCallId() {
  planSequence += 1;
  return ToolCallId2(`refine-loop:plan:${process.pid}:${planSequence}`);
}
function resultText(content, value) {
  const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (text.trim() !== "") return text;
  if (value === void 0) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
async function runWithDeadline(run, timeoutMs, id, controller) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`the node "${id}" ran out of its ${timeoutMs}ms budget`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([run(), expired]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
function buildAgentPrompt(node2, dependencies, outputs) {
  if (dependencies.length === 0) return node2.task;
  const sections = dependencies.map((dependency) => {
    const output = outputs.get(dependency.id) ?? "";
    return `Output of ${dependency.id}:
${output}`;
  });
  return `${node2.task}

---
What the nodes this task depends on produced:

${sections.join("\n\n")}`;
}
async function runNode(runner, node2, dependencies, outputs, criteria, agent, signal, respectConcurrencySafety, rootCallId, overrides, maxAgentDepth, agentNodeTimeoutMs, repair) {
  if (node2.kind === "tools") {
    const calls = node2.calls.map((call) => ({
      name: call.name,
      arguments: substitutePlaceholders(call.arguments, outputs)
    }));
    const batch = await runBatch(
      runner,
      { criteria: [...criteria], calls },
      agent,
      signal,
      respectConcurrencySafety,
      rootCallId,
      overrides,
      repair
    );
    const failed = batch.results.filter((item) => !item.ok);
    return {
      id: node2.id,
      kind: node2.kind,
      ok: failed.length === 0,
      output: renderBatch(batch),
      error: failed.length === 0 ? "" : failed.map((item) => `${item.name}: ${item.error}`).join("; ")
    };
  }
  const depth = agent?.session.header.delegationDepth ?? 0;
  if (depth >= maxAgentDepth) {
    return {
      id: node2.id,
      kind: node2.kind,
      ok: false,
      output: "",
      error: `this conversation is already a delegated child (depth ${depth}), so a plan here may not start another agent. Keep the work in the nodes that call tools.`
    };
  }
  try {
    const deadline = new AbortController();
    const onPlanAbort = () => deadline.abort();
    signal.addEventListener("abort", onPlanAbort, { once: true });
    let result;
    try {
      result = await runWithDeadline(
        () => runner.execute({
          callId: nextPlanCallId(),
          rootCallId,
          name: node2.kind,
          arguments: {
            description: node2.id,
            prompt: buildAgentPrompt(node2, dependencies, outputs),
            run_in_background: false
          },
          ...agent === void 0 ? {} : { agent },
          signal: deadline.signal
        }),
        agentNodeTimeoutMs,
        node2.id,
        deadline
      );
    } finally {
      signal.removeEventListener("abort", onPlanAbort);
    }
    const output = resultText(result.content, result.value);
    if (result.isError) {
      return {
        id: node2.id,
        kind: node2.kind,
        ok: false,
        output,
        error: result.error?.message ?? "the delegation failed"
      };
    }
    return { id: node2.id, kind: node2.kind, ok: true, output, error: "" };
  } catch (error) {
    return {
      id: node2.id,
      kind: node2.kind,
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function runPlan(runner, plan, agent, signal, respectConcurrencySafety, rootCallId, overrides, maxAgentDepth, agentNodeTimeoutMs, repair) {
  const built = buildWaves(plan.nodes);
  if ("error" in built) {
    throw new Error(`the plan does not hold together: ${built.error}`);
  }
  const waves = built.waves;
  const byId = new Map(plan.nodes.map((node2) => [node2.id, node2]));
  const outputs = /* @__PURE__ */ new Map();
  const results = /* @__PURE__ */ new Map();
  for (const wave of waves) {
    const settled = await Promise.all(wave.map(async (node2) => await runNode(
      runner,
      node2,
      dependenciesOf(node2, byId),
      outputs,
      plan.criteria,
      agent,
      signal,
      respectConcurrencySafety,
      rootCallId,
      overrides,
      maxAgentDepth,
      agentNodeTimeoutMs,
      repair
    )));
    for (const result of settled) {
      results.set(result.id, result);
      outputs.set(result.id, result.output);
    }
  }
  const parallelLayers = waves.filter((wave) => wave.length > 1).length;
  const schedule = parallelLayers === waves.length ? "concurrent" : parallelLayers === 0 ? "serial" : "mixed";
  return {
    criteria: plan.criteria,
    waves: waves.length,
    schedule,
    nodes: plan.nodes.map((node2) => results.get(node2.id)).filter((result) => result !== void 0)
  };
}
function renderPlan(output) {
  const lines = [];
  lines.push(`Plan finished \u2014 ${output.nodes.length} node(s) in ${output.waves} layer(s), shaped ${output.schedule}.`);
  lines.push(`Criteria: ${output.criteria.join("; ")}`);
  lines.push("");
  for (const node2 of output.nodes) {
    lines.push(`${node2.id} (${node2.kind}) \u2014 ${node2.ok ? "ok" : "failed"}`);
    if (node2.error !== "") lines.push(`   error: ${node2.error}`);
    if (node2.output !== "") {
      lines.push("   output:");
      for (const line of node2.output.split("\n")) lines.push(`   | ${line}`);
    }
  }
  lines.push("");
  lines.push("Every result is above. The turn is over.");
  return lines.join("\n");
}

// verify/plan.spec.ts
import { ToolCallId as ToolCallId3 } from "@deepseek-ai/dsh-llm/brand";
var failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === "" ? "" : ` \u2014 ${detail}`}`);
}
function wavesOf(nodes) {
  const built = buildWaves(nodes);
  return "error" in built ? void 0 : built.waves;
}
function problemOf(nodes) {
  const built = buildWaves(nodes);
  return "error" in built ? built.error : void 0;
}
function node(id, after = []) {
  return { id, kind: "tools", calls: [{ name: "echo", arguments: {} }], task: "", after };
}
console.log("parsePlanArgs");
{
  const parsed = parsePlanArgs({
    criteria: ["everything ran"],
    nodes: [
      { id: "read", kind: "tools", calls: [{ name: "glob", arguments: { pattern: "*" } }] },
      { id: "judge", kind: "subagent_fork", task: "judge it", after: ["read"] }
    ]
  });
  check("accepts a plan", parsed !== void 0);
  check("keeps the criteria", parsed?.criteria.length === 1);
  check("keeps the nodes in order", parsed?.nodes[1]?.id === "judge");
  check("keeps the dependency", parsed?.nodes[1]?.after[0] === "read");
  check("keeps the agent task", parsed?.nodes[1]?.task === "judge it");
  check("refuses a plan without criteria", parsePlanArgs({ nodes: [] }) === void 0);
  check("refuses a plan without nodes", parsePlanArgs({ criteria: ["x"], nodes: [] }) === void 0);
  check("refuses a duplicate id", parsePlanArgs({
    criteria: ["x"],
    nodes: [
      { id: "a", kind: "tools", calls: [{ name: "x", arguments: {} }] },
      { id: "a", kind: "tools", calls: [{ name: "x", arguments: {} }] }
    ]
  }) === void 0);
  check("refuses an unknown kind", parsePlanArgs({
    criteria: ["x"],
    nodes: [{ id: "a", kind: "telepathy", calls: [] }]
  }) === void 0);
  check("refuses a tools node without calls", parsePlanArgs({
    criteria: ["x"],
    nodes: [{ id: "a", kind: "tools" }]
  }) === void 0);
  check("refuses an agent node without a task", parsePlanArgs({
    criteria: ["x"],
    nodes: [{ id: "a", kind: "subagent" }]
  }) === void 0);
}
console.log("a placeholder in an argument is a dependency");
{
  const parsed = parsePlanArgs({
    criteria: ["x"],
    nodes: [
      { id: "scan", kind: "tools", calls: [{ name: "glob", arguments: { pattern: "*" } }] },
      { id: "use", kind: "tools", calls: [{ name: "grep", arguments: { pattern: "@@scan@@" } }] }
    ]
  });
  check(
    "the referencing node depends on the referenced one",
    parsed?.nodes[1]?.after.includes("scan") === true
  );
  const layers = wavesOf(parsed?.nodes ?? []);
  check(
    "the referenced node is in an earlier layer",
    layers?.[0]?.[0]?.id === "scan" && layers?.[1]?.[0]?.id === "use"
  );
}
console.log("buildWaves");
{
  const flat = wavesOf([node("a"), node("b")]);
  check("a flat plan is one layer", flat?.length === 1);
  check("the layer holds every node", flat?.[0].length === 2);
  const layered = wavesOf([node("a"), node("b", ["a"])]);
  check("a dependency makes a second layer", layered?.length === 2);
  check("the dependency comes first", layered?.[0][0]?.id === "a");
  const deep = wavesOf([node("a"), node("b", ["a"]), node("c", ["b"])]);
  check("a chain makes one layer each", deep?.length === 3);
  check("refuses a cycle", wavesOf([node("a", ["b"]), node("b", ["a"])]) === void 0);
  check("the cycle says so", (problemOf([node("a", ["b"]), node("b", ["a"])]) ?? "").includes("cycle"));
  check("refuses a dependency that does not exist", wavesOf([node("a", ["nope"])]) === void 0);
  check(
    "the missing dependency says so",
    (problemOf([node("a", ["nope"])]) ?? "").includes("not a node of this plan")
  );
  check("refuses a node that depends on itself", wavesOf([node("a", ["a"])]) === void 0);
  check("the self dependency says so", (problemOf([node("a", ["a"])]) ?? "").includes("itself"));
}
console.log("substitutePlaceholders");
{
  const outputs = /* @__PURE__ */ new Map([["read", "the file list"]]);
  check("replaces an exact placeholder", substitutePlaceholders("@@read@@", outputs) === "the file list");
  check("leaves an inline placeholder alone", substitutePlaceholders("x @@read@@ y", outputs) === "x @@read@@ y");
  check(
    "replaces inside an object",
    JSON.stringify(substitutePlaceholders({ pattern: "@@read@@" }, outputs)) === '{"pattern":"the file list"}'
  );
  check(
    "replaces inside an array",
    JSON.stringify(substitutePlaceholders(["@@read@@"], outputs)) === '["the file list"]'
  );
  let refused = false;
  try {
    substitutePlaceholders("@@nope@@", outputs);
  } catch (error) {
    refused = error instanceof Error && error.message.includes("nope");
  }
  check("refuses a placeholder it cannot resolve", refused);
}
console.log("runPlan");
{
  const calls = [];
  const prompts = [];
  const runner = {
    executionMode: () => ({ kind: "parallel" }),
    async execute(exec) {
      calls.push(exec.name);
      if (exec.name === "subagent_fork") {
        prompts.push(String(exec.arguments.prompt ?? ""));
      }
      return {
        isError: false,
        value: exec.name,
        content: [{ type: "text", text: `ran ${exec.name}` }]
      };
    }
  };
  const output = await runPlan(
    runner,
    {
      criteria: ["every node ran"],
      nodes: [
        { id: "read", kind: "tools", calls: [{ name: "glob", arguments: { pattern: "*" } }], task: "", after: [] },
        { id: "judge", kind: "subagent_fork", calls: [], task: "judge the listing", after: ["read"] },
        { id: "fresh", kind: "subagent", calls: [], task: "look it up", after: [] }
      ]
    },
    void 0,
    new AbortController().signal,
    true,
    ToolCallId3("refine-loop:test:root"),
    {},
    1,
    3e5
  );
  check("every node ran", output.nodes.length === 3);
  check("the results keep the plan order", output.nodes[0]?.id === "read");
  check("the plan had two layers", output.waves === 2);
  check("the shape is mixed", output.schedule === "mixed");
  check("the tool node ran its call", calls.includes("glob"));
  check("the fork node ran", calls.includes("subagent_fork"));
  check("the fresh node ran", calls.includes("subagent"));
  check(
    "the fork child was given the dependency output",
    prompts.some((prompt) => prompt.includes("judge the listing") && prompt.includes("ran glob"))
  );
  check("every node succeeded", output.nodes.every((result) => result.ok));
  const text = renderPlan(output);
  check("the render names every node", text.includes("read") && text.includes("judge") && text.includes("fresh"));
  check("the render says the turn is over", text.includes("Every result is above. The turn is over."));
}
console.log("a plan may not start an agent from inside a child");
{
  const runner = {
    executionMode: () => ({ kind: "parallel" }),
    async execute() {
      return { isError: false, value: "", content: [] };
    }
  };
  const agent = {
    session: { id: "child", header: { delegationDepth: 1 } }
  };
  const output = await runPlan(
    runner,
    {
      criteria: ["x"],
      nodes: [{ id: "child-agent", kind: "subagent", calls: [], task: "go", after: [] }]
    },
    agent,
    new AbortController().signal,
    true,
    ToolCallId3("refine-loop:test:root"),
    {},
    1,
    3e5
  );
  check("the agent node was refused", output.nodes[0]?.ok === false);
  check("the refusal says why", (output.nodes[0]?.error ?? "").includes("delegated child"));
}
console.log("a node that runs out of time is reported, and the plan carries on");
{
  const runner = {
    executionMode: () => ({ kind: "parallel" }),
    async execute(exec) {
      if (exec.name === "subagent") {
        await new Promise((resolve) => setTimeout(resolve, 5e3));
      }
      return { isError: false, value: exec.name, content: [{ type: "text", text: "ok" }] };
    }
  };
  const output = await runPlan(
    runner,
    {
      criteria: ["x"],
      nodes: [
        { id: "slow", kind: "subagent", calls: [], task: "go", after: [] },
        { id: "quick", kind: "tools", calls: [{ name: "glob", arguments: {} }], task: "", after: [] }
      ]
    },
    void 0,
    new AbortController().signal,
    true,
    ToolCallId3("refine-loop:test:root"),
    {},
    1,
    120
  );
  check("the slow node failed", output.nodes[0]?.ok === false);
  check(
    "the failure says it ran out of time",
    (output.nodes[0]?.error ?? "").includes("ran out of its")
  );
  check("the other node still ran", output.nodes[1]?.ok === true);
}
if (failures > 0) {
  console.error(`
${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
