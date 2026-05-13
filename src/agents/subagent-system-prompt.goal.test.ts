import { describe, expect, it } from "vitest";
import { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";

describe("buildSubagentSystemPrompt completion goal", () => {
  it("includes completion goal status instructions when supplied", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:child",
      task: "Write the report",
      completionGoal: "Report exists and tests pass",
    });

    expect(prompt).toContain("## Completion Goal");
    expect(prompt).toContain("Report exists and tests pass");
    expect(prompt).toContain("Goal status:");
  });

  it("omits completion goal section by default", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:child",
      task: "Write the report",
    });

    expect(prompt).not.toContain("## Completion Goal");
  });
});
