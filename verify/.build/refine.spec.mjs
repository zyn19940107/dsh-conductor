// src/batch.ts
import { ToolCallId } from "@deepseek-ai/dsh-llm/brand";
function parseBatchArgs(value) {
  const record = value ?? {};
  const criteria = record.criteria;
  const calls = record.calls;
  if (!Array.isArray(criteria) || !Array.isArray(calls)) return void 0;
  const parsedCriteria = criteria.filter((entry) => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
  if (parsedCriteria.length === 0) return void 0;
  const parsedCalls = [];
  for (const entry of calls) {
    if (entry === null || typeof entry !== "object") return void 0;
    const item = entry;
    const name = item.name;
    if (typeof name !== "string" || name.trim() === "") return void 0;
    const args = item.arguments;
    parsedCalls.push({ name: name.trim(), arguments: args === void 0 ? {} : args });
  }
  if (parsedCalls.length === 0) return void 0;
  return { criteria: parsedCriteria, calls: parsedCalls };
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

// src/policy.ts
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// src/tool.ts
import { ToolCallId as ToolCallId2 } from "@deepseek-ai/dsh-llm/brand";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/policy.ts
var POLICY_COMMAND = "dsh-refine-loop";
function parsePolicyCommand(text) {
  const firstLine = text.trim().split("\n", 1)[0]?.trim() ?? "";
  if (!firstLine.startsWith(`/${POLICY_COMMAND}`)) return void 0;
  const rest = firstLine.slice(POLICY_COMMAND.length + 1).trim().toLowerCase();
  if (rest !== "on" && rest !== "off") return void 0;
  return rest;
}

// verify/refine.spec.ts
var failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === "" ? "" : ` \u2014 ${detail}`}`);
}
console.log("parseBatchArgs");
{
  const parsed = parseBatchArgs({
    criteria: ["the file exists", "it parses"],
    calls: [
      { name: "read", arguments: { path: "a.txt" } },
      { name: "glob", arguments: { pattern: "*.ts" } }
    ]
  });
  check("accepts a plan", parsed !== void 0);
  check("keeps the criteria", parsed?.criteria.length === 2);
  check("keeps the calls in order", parsed?.calls[1]?.name === "glob");
  check("keeps the arguments", (parsed?.calls[0]?.arguments).path === "a.txt");
  check("refuses a plan without criteria", parseBatchArgs({ calls: [{ name: "read" }] }) === void 0);
  check("refuses a plan with empty criteria", parseBatchArgs({ criteria: [], calls: [{ name: "read" }] }) === void 0);
  check("refuses a plan without calls", parseBatchArgs({ criteria: ["x"], calls: [] }) === void 0);
  check("refuses a call without a name", parseBatchArgs({ criteria: ["x"], calls: [{ arguments: {} }] }) === void 0);
  check("refuses a plan that is not an object", parseBatchArgs("nonsense") === void 0);
  check("trims the criteria", parseBatchArgs({ criteria: ["  x  "], calls: [{ name: "read" }] })?.criteria[0] === "x");
}
console.log("parsePolicyCommand");
{
  check("reads the off command", parsePolicyCommand("/dsh-refine-loop off") === "off");
  check("reads the on command", parsePolicyCommand("/dsh-refine-loop on") === "on");
  check("ignores another command", parsePolicyCommand("/dsh-some-other-policy off") === void 0);
  check("ignores the command without a mode", parsePolicyCommand("/dsh-refine-loop") === void 0);
  check("ignores a command that is not the first line", parsePolicyCommand("hello\n/dsh-refine-loop off") === void 0);
  check("ignores an ordinary message", parsePolicyCommand("please batch these") === void 0);
}
console.log("renderBatch");
{
  const output = {
    criteria: ["the file exists"],
    schedule: "concurrent",
    results: [
      { name: "read", ok: true, scheduled: "concurrent", output: "contents", error: "" },
      { name: "glob", ok: false, scheduled: "serial", output: "", error: "it failed" }
    ]
  };
  const text = renderBatch(output);
  check("names the criteria", text.includes("the file exists"));
  check("names every item", text.includes("read") && text.includes("glob"));
  check("carries the failure", text.includes("it failed"));
  check("does not ask for a conclusion", !text.includes("conclusion"));
}
if (failures > 0) {
  console.error(`
${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
