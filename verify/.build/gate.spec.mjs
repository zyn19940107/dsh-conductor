// src/tool.ts
import { ToolCallId as ToolCallId2 } from "@deepseek-ai/dsh-llm/brand";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/batch.ts
import { ToolCallId } from "@deepseek-ai/dsh-llm/brand";

// src/tool.ts
var PLAN_TOOL = "refine_plan";

// src/gate.ts
var PlanGate = class {
  before = /* @__PURE__ */ new Map();
  planned = /* @__PURE__ */ new Map();
  rounds = /* @__PURE__ */ new Map();
  /**
   * Count one pullback for a tool the agent called itself.
   *
   * @param sessionId - the session the call belongs to.
   * @returns how many times the conversation has been pulled back.
   */
  bumpBefore(sessionId) {
    const count = (this.before.get(sessionId) ?? 0) + 1;
    this.before.set(sessionId, count);
    return count;
  }
  /**
   * Record the plan the turn handed over.
   *
   * @param sessionId - the session the plan belongs to.
   * @param callId - the call the plan was handed over with.
   */
  markPlanned(sessionId, callId) {
    if (!this.planned.has(sessionId)) {
      this.planned.set(sessionId, callId);
    }
  }
  /**
   * Whether the turn has handed over a plan.
   *
   * @param sessionId - the session the turn belongs to.
   * @returns true when a plan has run in this turn.
   */
  hasPlanned(sessionId) {
    return this.planned.has(sessionId);
  }
  /**
   * Count one round the loop ran for the same request.
   *
   * @param sessionId - the session the round belongs to.
   * @returns how many rounds the request has used.
   */
  bumpRound(sessionId) {
    const count = (this.rounds.get(sessionId) ?? 0) + 1;
    this.rounds.set(sessionId, count);
    return count;
  }
  /**
   * How many rounds the current request has used.
   *
   * @param sessionId - the session the request belongs to.
   * @returns the round count.
   */
  roundsUsed(sessionId) {
    return this.rounds.get(sessionId) ?? 0;
  }
  /**
   * Forget one conversation's rounds.
   *
   * A person speaking starts a new request, and a new request gets its own
   * budget.
   *
   * @param sessionId - the session the request belongs to.
   */
  resetRounds(sessionId) {
    this.rounds.delete(sessionId);
  }
  /**
   * Forget one conversation's pullbacks and its plan.
   *
   * @param sessionId - the session the turn belongs to.
   */
  reset(sessionId) {
    this.before.delete(sessionId);
    this.planned.delete(sessionId);
  }
};
var PLAN_REQUIRED = `Do not call tools yourself \u2014 every call you make goes inside a plan. Either hand the work over as a plan with ${PLAN_TOOL} \u2014 the criteria that decide whether it succeeded, and the nodes: the calls that run together, the tasks that need a child with no context, the tasks that need a child that inherits this conversation, and what depends on what. The plan runs in one round trip and returns every result together \u2014 or write the conclusion, which ends the turn.`;
var NEXT_ROUND = `The plan has run \u2014 every result is above. This is the next round: hand over another plan with ${PLAN_TOOL} for what is left, or write the conclusion. Writing the conclusion answers the request and ends the loop.`;
function planRefusal(toolName, sessionId, gate, appliesTo, requirePlan, planPullbacks, delegationDepth = 0) {
  if (!appliesTo(sessionId)) return void 0;
  if (!requirePlan) return void 0;
  if (delegationDepth > 0) return void 0;
  if (toolName === PLAN_TOOL) return void 0;
  if (gate.bumpBefore(sessionId) > planPullbacks) return void 0;
  return PLAN_REQUIRED;
}

// verify/gate.spec.ts
var failures = 0;
function check(what, ok) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}
console.log("a tool the agent calls itself is pulled back");
{
  const gate = new PlanGate();
  check(
    "a direct call is refused",
    planRefusal("glob", "s1", gate, () => true, true, 2, 16) === PLAN_REQUIRED
  );
  check(
    "the refusal says the call goes inside a plan",
    (planRefusal("glob", "s1", gate, () => true, true, 2, 16) ?? "").includes("inside a plan")
  );
  const fresh = new PlanGate();
  check(
    "the refusal offers the conclusion as the other way out",
    (planRefusal("glob", "s1b", fresh, () => true, true, 2, 16) ?? "").includes("conclusion")
  );
}
console.log("the plan is how the work is handed over");
{
  const gate = new PlanGate();
  check(
    "the plan is never refused",
    planRefusal("refine_plan", "s1", gate, () => true, true, 2, 16) === void 0
  );
}
console.log("the rule is a pullback, not a cage");
{
  const gate = new PlanGate();
  check(
    "the first direct call is refused",
    planRefusal("glob", "s1", gate, () => true, true, 2, 16) === PLAN_REQUIRED
  );
  check(
    "the second direct call is refused",
    planRefusal("glob", "s1", gate, () => true, true, 2, 16) === PLAN_REQUIRED
  );
  check(
    "after the pullbacks run out the agent is left alone",
    planRefusal("glob", "s1", gate, () => true, true, 2, 16) === void 0
  );
}
console.log("a conversation that opted out is left alone");
{
  const gate = new PlanGate();
  check(
    "nothing is refused for a conversation that opted out",
    planRefusal("glob", "s7", gate, () => false, true, 2, 16) === void 0
  );
}
console.log("the rule can be turned off");
{
  const gate = new PlanGate();
  check(
    "nothing is refused when the rule is off",
    planRefusal("glob", "s2", gate, () => true, false, 2, 16) === void 0
  );
}
console.log("a new turn starts from scratch");
{
  const gate = new PlanGate();
  planRefusal("glob", "s3", gate, () => true, true, 2, 16);
  planRefusal("glob", "s3", gate, () => true, true, 2, 16);
  gate.reset("s3");
  check(
    "after a reset the first call of the new turn is refused again",
    planRefusal("glob", "s3", gate, () => true, true, 2, 16) === PLAN_REQUIRED
  );
}
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
