import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { PluginHookSessionEndReason } from "../../plugins/hook-types.js";
import { extractAssistantVisibleText } from "../../shared/chat-message-content.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

let piCodingAgentModulePromise: Promise<typeof import("@mariozechner/pi-coding-agent")> | null =
  null;

async function loadPiCodingAgentModule(): Promise<typeof import("@mariozechner/pi-coding-agent")> {
  piCodingAgentModulePromise ??= import("@mariozechner/pi-coding-agent");
  return await piCodingAgentModulePromise;
}

async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
}): Promise<void> {
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  const { CURRENT_SESSION_VERSION } = await loadPiCodingAgentModule();
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

type TranscriptTailMessage = {
  role: string;
  text: string;
};

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return normalizeOptionalString(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!part || typeof part !== "object") {
        return undefined;
      }
      const record = part as { type?: unknown; text?: unknown; content?: unknown };
      if (typeof record.text === "string") {
        return record.text;
      }
      if (typeof record.content === "string") {
        return record.content;
      }
      return undefined;
    })
    .filter((part): part is string => Boolean(normalizeOptionalString(part)));
  return normalizeOptionalString(parts.join("\n"));
}

function truncateForHandoff(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

async function readRecentTranscriptMessages(params: {
  transcriptPath?: string;
  maxMessages?: number;
}): Promise<TranscriptTailMessage[]> {
  const transcriptPath = normalizeOptionalString(params.transcriptPath);
  if (!transcriptPath) {
    return [];
  }
  let raw: string;
  try {
    raw = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch {
    return [];
  }

  const messages: TranscriptTailMessage[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { message?: { role?: unknown; content?: unknown } };
      const message = parsed.message;
      if (!message) {
        continue;
      }
      const role = typeof message.role === "string" ? message.role : undefined;
      if (!role || (role !== "user" && role !== "assistant")) {
        continue;
      }
      const text =
        role === "assistant"
          ? normalizeOptionalString(extractAssistantVisibleText(message))
          : extractTextContent(message.content);
      if (!text) {
        continue;
      }
      messages.push({ role, text: truncateForHandoff(text, 600) });
    } catch {
      continue;
    }
  }
  const maxMessages = params.maxMessages ?? 8;
  return messages.slice(Math.max(0, messages.length - maxMessages));
}

function formatRolloverReason(
  reason?: SessionEntry["lastRolloverReason"] | PluginHookSessionEndReason,
): string {
  switch (reason) {
    case "token-threshold":
      return "token threshold";
    case "message-threshold":
      return "message threshold";
    case "age-threshold":
      return "age threshold";
    case "rollover":
      return "rollover";
    case "idle":
      return "idle reset";
    case "daily":
      return "daily reset";
    case "reset":
      return "manual reset";
    case "new":
      return "new session";
    default:
      return "session replacement";
  }
}

function buildHandoffText(params: {
  reason?: SessionEntry["lastRolloverReason"] | PluginHookSessionEndReason;
  previousEntry: SessionEntry;
  previousTranscriptPath?: string;
  tailMessages: TranscriptTailMessage[];
}): string {
  const lines = [
    "System handoff: the previous chat session was automatically rolled over before this turn.",
    `Reason: ${formatRolloverReason(params.reason)}.`,
    `Previous session id: ${params.previousEntry.sessionId ?? "unknown"}.`,
  ];
  const transcriptPath = normalizeOptionalString(params.previousTranscriptPath);
  if (transcriptPath) {
    lines.push(`Archived transcript: ${transcriptPath}.`);
  }
  const tokens = params.previousEntry.totalTokens;
  if (typeof tokens === "number" && Number.isFinite(tokens)) {
    lines.push(`Previous recorded tokens: ${tokens}.`);
  }
  if (params.tailMessages.length > 0) {
    lines.push("Recent transcript tail:");
    for (const message of params.tailMessages) {
      lines.push(`- ${message.role}: ${message.text}`);
    }
  } else {
    lines.push(
      "No readable recent transcript tail was available; consult the archived transcript if continuity is needed.",
    );
  }
  lines.push(
    "Continue from this handoff and preserve any approvals, decisions, and active task context from the prior session.",
  );
  return lines.join("\n");
}

export async function appendSessionRolloverHandoff(params: {
  nextSessionId: string;
  nextSessionFile?: string;
  previousEntry?: SessionEntry;
  previousTranscriptPath?: string;
  reason?: SessionEntry["lastRolloverReason"] | PluginHookSessionEndReason;
  now?: number;
}): Promise<boolean> {
  if (!params.previousEntry?.sessionId) {
    return false;
  }
  const nextSessionFile = normalizeOptionalString(params.nextSessionFile);
  if (!nextSessionFile) {
    return false;
  }
  const tailMessages = await readRecentTranscriptMessages({
    transcriptPath: params.previousTranscriptPath ?? params.previousEntry.sessionFile,
  });
  const handoffText = buildHandoffText({
    reason: params.reason,
    previousEntry: params.previousEntry,
    previousTranscriptPath: params.previousTranscriptPath ?? params.previousEntry.sessionFile,
    tailMessages,
  });
  await ensureSessionHeader({ sessionFile: nextSessionFile, sessionId: params.nextSessionId });
  const message = {
    type: "message",
    id: crypto.randomUUID(),
    message: {
      role: "user",
      content: handoffText,
      timestamp: params.now ?? Date.now(),
    },
  };
  await fs.promises.appendFile(nextSessionFile, `${JSON.stringify(message)}\n`, "utf-8");
  return true;
}
