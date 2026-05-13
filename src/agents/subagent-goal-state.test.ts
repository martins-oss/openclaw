import { describe, expect, it } from "vitest";
import { evaluateSubagentGoal, normalizeSubagentCompletionGoal } from "./subagent-goal-state.js";

const now = 1_234;

describe("subagent goal state", () => {
  it("normalizes blank and long goals", () => {
    expect(normalizeSubagentCompletionGoal("  ship   the thing  ")).toBe("ship the thing");
    expect(normalizeSubagentCompletionGoal("   ")).toBeUndefined();
    expect(normalizeSubagentCompletionGoal("x".repeat(3_000))).toHaveLength(2_000);
  });

  it("marks errors and timeouts as not met", () => {
    expect(
      evaluateSubagentGoal({
        goal: "produce report",
        outcome: { status: "error", error: "boom" },
        now,
      }),
    ).toEqual({ status: "not_met", reason: "Subagent ended with error: boom", evaluatedAt: now });

    expect(
      evaluateSubagentGoal({ goal: "produce report", outcome: { status: "timeout" }, now })?.status,
    ).toBe("not_met");
  });

  it("uses explicit goal status from final output", () => {
    expect(
      evaluateSubagentGoal({
        goal: "produce report",
        outcome: { status: "ok" },
        finalText: "Goal status: met — report written and tests passed",
        now,
      }),
    ).toEqual({ status: "met", reason: "report written and tests passed", evaluatedAt: now });

    expect(
      evaluateSubagentGoal({
        goal: "produce report",
        outcome: { status: "ok" },
        finalText: "Goal status: blocked: waiting for approval",
        now,
      }),
    ).toEqual({ status: "not_met", reason: "waiting for approval", evaluatedAt: now });
  });

  it("records unknown when the worker omits a goal status", () => {
    expect(
      evaluateSubagentGoal({
        goal: "produce report",
        outcome: { status: "ok" },
        finalText: "Done. Report is in reports/foo.md",
        now,
      }),
    ).toEqual({
      status: "unknown",
      reason: "Subagent completed, but its final response did not include a `Goal status:` line.",
      evaluatedAt: now,
    });
  });
});
