// Detect and strip tool-call markup leaked as plain assistant text.

import { extractAssistantText, extractToolCalls } from "./response-quality.ts";

const LEAK_LABEL = "[TEXT TOOL CALL LEAKED — stripped by loop-police]";

const TOOL_CALL_TAG_RE = /<\/?tool_call\b/i;
const FUNCTION_TAG_RE = /<function=[\w-]+/i;
const PARAMETER_TAG_RE = /<parameter=[\w-]+/i;

function findLeakStart(text: string): number {
  const markers: number[] = [];

  const toolCallMatch = text.match(TOOL_CALL_TAG_RE);
  if (toolCallMatch?.index != null) markers.push(toolCallMatch.index);

  if (FUNCTION_TAG_RE.test(text) && PARAMETER_TAG_RE.test(text)) {
    const functionMatch = text.match(FUNCTION_TAG_RE);
    if (functionMatch?.index != null) markers.push(functionMatch.index);

    const parameterMatch = text.match(PARAMETER_TAG_RE);
    if (parameterMatch?.index != null) markers.push(parameterMatch.index);
  }

  return markers.length > 0 ? Math.min(...markers) : -1;
}

export function hasTextToolCallLeak(text: string): boolean {
  if (!text) return false;
  return findLeakStart(text) >= 0;
}

export function stripTextToolCallLeak(text: string): { cleaned: string; hadLeak: boolean } {
  const start = findLeakStart(text);
  if (start < 0) return { cleaned: text, hadLeak: false };

  const prefix = text.slice(0, start).trimEnd();
  const cleaned = prefix ? `${prefix}\n\n${LEAK_LABEL}` : LEAK_LABEL;
  return { cleaned, hadLeak: true };
}

export interface TextToolCallLeakInfo {
  text: string;
}

export function detectTextToolCallLeak(message: unknown): TextToolCallLeakInfo | null {
  if (extractToolCalls(message).length > 0) return null;

  const text = extractAssistantText(message);
  if (!hasTextToolCallLeak(text)) return null;

  return { text };
}

export function replaceLeakedText(message: unknown): unknown {
  if (typeof message !== "object" || !message) return message;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;

  let changed = false;
  const newContent = content.map((block) => {
    if (typeof block !== "object" || !block) return block;
    const b = block as Record<string, unknown>;
    if (b.type !== "text" || typeof b.text !== "string") return block;

    const { cleaned, hadLeak } = stripTextToolCallLeak(b.text);
    if (!hadLeak) return block;
    changed = true;
    return { ...block, text: cleaned };
  });

  return changed ? { ...(message as object), content: newContent } : message;
}
