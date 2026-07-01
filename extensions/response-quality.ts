// Pure helpers for detecting malformed or repeated assistant responses.

export interface ToolCallInfo {
  name: string;
  args: unknown;
}

export interface PromptFingerprints {
  assistant: string;
  user: string;
}

function stableStringify(val: unknown): string {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(stableStringify).join(",")}]`;
  const keys = Object.keys(val as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((val as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function extractAssistantText(message: unknown): string {
  if (typeof message !== "object" || !message) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    if (typeof content === "string") return content;
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || !block) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

export function extractToolCalls(message: unknown): ToolCallInfo[] {
  if (typeof message !== "object" || !message) return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  const calls: ToolCallInfo[] = [];
  for (const block of content) {
    if (typeof block !== "object" || !block) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "toolCall" || b.type === "tool_use") {
      const name = typeof b.name === "string" ? b.name : typeof b.toolName === "string" ? b.toolName : "";
      const args = b.arguments ?? b.input ?? b.args ?? {};
      calls.push({ name, args });
    }
  }
  return calls;
}

function isValidToolCall(call: ToolCallInfo): boolean {
  if (!call.name.trim()) return false;
  if (call.args === null || call.args === undefined) return false;
  if (typeof call.args === "string") {
    const trimmed = call.args.trim();
    if (!trimmed) return false;
    try {
      JSON.parse(trimmed);
    } catch {
      return false;
    }
  }
  return true;
}

export function isMalformedResponse(message: unknown): boolean {
  const text = extractAssistantText(message);
  const tools = extractToolCalls(message);

  if (!text && tools.length === 0) return true;
  if (tools.length > 0 && tools.every((t) => !isValidToolCall(t))) return true;
  return false;
}

export function fingerprintAssistantOutput(message: unknown): string {
  const text = extractAssistantText(message);
  const tools = extractToolCalls(message);
  const toolPart = tools
    .map((t) => `${t.name}:${stableStringify(t.args)}`)
    .sort()
    .join("|");
  return `${text}::${toolPart}`;
}

export function extractUserTextFromMessage(message: unknown): string {
  if (typeof message !== "object" || !message) return "";
  const role = (message as { role?: string }).role;
  if (role !== "user") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (typeof block === "object" && block && (block as { type?: string }).type === "text") {
      const text = (block as { text?: string }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

/** Fingerprint the user message immediately before the latest assistant message in the branch. */
export function fingerprintUserPromptFromBranch(branch: unknown[]): string | null {
  let lastUser: string | null = null;
  let sawAssistant = false;

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (typeof entry !== "object" || !entry) continue;
    const msg = (entry as { message?: unknown }).message ?? entry;
    const role = (msg as { role?: string }).role;
    if (role === "assistant") {
      sawAssistant = true;
      continue;
    }
    if (role === "user" && sawAssistant) {
      const text = extractUserTextFromMessage(msg);
      lastUser = text || "(empty user message)";
      break;
    }
  }

  if (lastUser === null) return null;
  return stableStringify(lastUser);
}

export function isIdenticalAcrossPrompts(prev: PromptFingerprints, curr: PromptFingerprints): boolean {
  return (
    prev.assistant.length > 0 &&
    prev.assistant === curr.assistant &&
    prev.user !== curr.user
  );
}

export function shouldCountPersistFailure(
  message: unknown,
  branch: unknown[],
  prev: PromptFingerprints | null
): { count: boolean; reason?: string; curr: PromptFingerprints | null } {
  if (isMalformedResponse(message)) {
    const assistant = fingerprintAssistantOutput(message);
    const user = fingerprintUserPromptFromBranch(branch);
    return {
      count: true,
      reason: "malformed response",
      curr: user ? { assistant, user } : { assistant, user: "" },
    };
  }

  const assistant = fingerprintAssistantOutput(message);
  const user = fingerprintUserPromptFromBranch(branch);
  if (!user) {
    return { count: false, curr: null };
  }

  const curr = { assistant, user };
  if (prev && isIdenticalAcrossPrompts(prev, curr)) {
    return { count: true, reason: "identical response across prompts", curr };
  }

  return { count: false, curr };
}
