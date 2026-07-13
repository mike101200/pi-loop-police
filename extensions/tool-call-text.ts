// Detect and strip tool-call markup leaked as plain assistant text.

import { extractAssistantText, extractToolCalls } from "./response-quality.ts";

const LEAK_LABEL = "[TEXT TOOL CALL LEAKED — stripped by loop-police]";

const TOOL_CALL_TAG_RE = /<\/?tool_call\b/i;
const FUNCTION_TAG_RE = /<function=[\w-]+/i;
const PARAMETER_TAG_RE = /<parameter=[\w-]+/i;

// Additional patterns for missed formats (Gap #1)
const TOOL_CODE_TAG_RE = /<\/?tool_code\b/i;
const INVOKE_TAG_RE = /<invoke[\s>]/i;
const JSON_TOOL_CALL_RE = /"name"\s*:\s*["\w-]+"\s*,\s*"arguments"/i;
const FUNCTION_CALLING_RE = /"type"\s*:\s*"function"\s*,\s*"function"/i;

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

  // Additional pattern checks (Gap #1 fixes)
  const toolCodeMatch = text.match(TOOL_CODE_TAG_RE);
  if (toolCodeMatch?.index != null) markers.push(toolCodeMatch.index);

  const invokeMatch = text.match(INVOKE_TAG_RE);
  if (invokeMatch?.index != null) markers.push(invokeMatch.index);

  const jsonMatch = text.match(JSON_TOOL_CALL_RE);
  if (jsonMatch?.index != null) markers.push(jsonMatch.index);

  const funcCallingMatch = text.match(FUNCTION_CALLING_RE);
  if (funcCallingMatch?.index != null) markers.push(funcCallingMatch.index);

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
  // Gap #3: track whether structural toolCalls also exist alongside the leaked text
  hasStructuralToolCalls: boolean;
}

export function detectTextToolCallLeak(message: unknown): TextToolCallLeakInfo | null {
  const toolCalls = extractToolCalls(message);
  const hasStructural = toolCalls.length > 0;

  // Gap #3 fix: even if structural toolCalls exist, still check text blocks.
  // Previously we bailed early (if hasStructural return null) which meant a
  // message with BOTH valid toolCalls AND leaked text was never caught.
  // We now detect in both cases but signal the difference so the caller can
  // decide whether to strip (hasStructural=false) or warn (hasStructural=true).

  const text = extractAssistantText(message);
  if (!hasTextToolCallLeak(text)) return null;

  return { text, hasStructuralToolCalls: hasStructural };
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
