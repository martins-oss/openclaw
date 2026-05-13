import type { SubagentRunOutcome } from "./subagent-announce-output.js";

export type SubagentGoalEvaluationStatus = "met" | "not_met" | "unknown";

export type SubagentGoalEvaluation = {
  status: SubagentGoalEvaluationStatus;
  reason: string;
  evaluatedAt: number;
};

const GOAL_STATUS_LINE_RE =
  /^\s*(?:goal\s+status|goal)\s*:\s*(met|done|complete|completed|success|succeeded|not\s+met|failed|blocked|unknown)\b\s*[-—:]?\s*(.*)$/im;

export function normalizeSubagentCompletionGoal(goal: unknown): string | undefined {
  if (typeof goal !== "string") {
    return undefined;
  }
  const normalized = goal.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 2_000) : undefined;
}

export function evaluateSubagentGoal(params: {
  goal?: string;
  outcome: SubagentRunOutcome;
  finalText?: string | null;
  now?: number;
}): SubagentGoalEvaluation | undefined {
  const goal = normalizeSubagentCompletionGoal(params.goal);
  if (!goal) {
    return undefined;
  }
  const evaluatedAt = params.now ?? Date.now();
  if (params.outcome.status === "error") {
    return {
      status: "not_met",
      reason: params.outcome.error?.trim()
        ? `Subagent ended with error: ${params.outcome.error.trim()}`
        : "Subagent ended with an error before confirming the goal.",
      evaluatedAt,
    };
  }
  if (params.outcome.status === "timeout") {
    return {
      status: "not_met",
      reason: "Subagent timed out before confirming the goal.",
      evaluatedAt,
    };
  }
  const finalText = params.finalText?.trim() ?? "";
  if (!finalText) {
    return {
      status: "unknown",
      reason: "Subagent completed without a final response to evaluate against the goal.",
      evaluatedAt,
    };
  }
  const statusLine = finalText.match(GOAL_STATUS_LINE_RE);
  if (statusLine) {
    const rawStatus = statusLine[1].toLowerCase().replace(/\s+/g, "_");
    const detail = statusLine[2]?.trim();
    if (["met", "done", "complete", "completed", "success", "succeeded"].includes(rawStatus)) {
      return {
        status: "met",
        reason: detail || "Worker explicitly reported the completion goal as met.",
        evaluatedAt,
      };
    }
    if (["not_met", "failed", "blocked"].includes(rawStatus)) {
      return {
        status: "not_met",
        reason: detail || "Worker explicitly reported the completion goal as not met.",
        evaluatedAt,
      };
    }
    return {
      status: "unknown",
      reason: detail || "Worker explicitly reported the completion goal as unknown.",
      evaluatedAt,
    };
  }
  return {
    status: "unknown",
    reason: "Subagent completed, but its final response did not include a `Goal status:` line.",
    evaluatedAt,
  };
}
