# Tool Call Leak Detection Analysis

## Problem

The model outputs tool-call markup as **plain text** inside a `text` content block instead of emitting structured `toolCall` blocks. Pi's agent loop never fires a `tool_call` event in this case — the tool is never executed, and loop-police's `tool_call` handler has nothing to intercept.

Loop-police falls back to `detectTextToolCallLeak()` at `message_end` to catch the leak, strip the bad text, and re-prompt the model. However, the detection is **incomplete** and misses several common formats.

---

## Root Cause: Detection Gaps

### Current Patterns (`extensions/tool-call-text.ts`)

```typescript
const TOOL_CALL_TAG_RE = /<\/?tool_call\b/i;        // matches <tool_call>, </tool_call>
const FUNCTION_TAG_RE = /<function=[\w-]+/i;        // matches <function=edit>
const PARAMETER_TAG_RE = /<parameter=[\w-]+/i;      // matches <parameter=path>
```

Detection logic:
1. Check for `<tool_call>` / `</tool_call>` tags (alone)
2. Check for `<function=...>` AND `<parameter=...>` (both must be present)

**Result:** Only catches the Claude-style XML format. Misses everything else.

### Missed Formats

| # | Format | Example | Why It Misses |
|---|--------|---------|---------------|
| 1 | **Antropic 2023-style** | `<tool_code>ls -la</tool_code>` | No `tool_call`, `function=`, or `parameter=` tags |
| 2 | **JSON tool calls** | `{"name":"read","arguments":{"path":"/foo"}}` | No XML tags at all |
| 3 | **Markdown code blocks** | ````\nread(path="/foo")\n``` ```` | No recognized tags |
| 4 | **Natural language** | `I'll call read with path="/foo"` | No tags — impossible to detect reliably |
| 5 | **Custom tool tags** | `<invoke name="my_tool">...</invoke>` | Different tag vocabulary |
| 6 | **Function calling JSON** | `{"type":"function","function":{"name":"read","arguments":"{}"}}` | No XML tags |
| 7 | **Multi-line XML with newlines in tags** | `\n<tool_call>\n <function=read>\n <parameter=path>\n ...` | Regex matches, BUT if Pi's parser ALSO extracts it as a structural `toolCall`, the early bail in `detectTextToolCallLeak` returns `null` — the leak is never caught (see Gap #3 below) |

### Gap #2: Early Bail in `detectTextToolCallLeak`

```typescript
export function detectTextToolCallLeak(message: unknown): TextToolCallLeakInfo | null {
  if (extractToolCalls(message).length > 0) return null;  // ← bails if ANY toolCall block exists
  // ...
}
```

If the model emits **one** valid `toolCall` block AND **one** leaked text tool call, the detector returns `null`. The leaked text stays in context, polluting future turns.

### Gap #3: Pi Parser May Extract XML Tool Calls as Structured Blocks (Session Freeze)

When the model outputs tool-call markup in the standard Claude XML format:

```
<tool_call>
 <function=read>
  <parameter=limit>
  25
  </parameter>
  <parameter=offset>
  3275
  </parameter>
  <parameter=path>
  D:/proiecte/csharp/transportm/TransportEntities/Models/TransportContext.cs
  </parameter>
 </function>
</tool_call>
```

Pi's response parser may successfully extract this as a structured `toolCall` block (type=`"toolCall"`). This means `extractToolCalls(message).length > 0` is `true`, so `detectTextToolCallLeak` returns `null` immediately — **the text leak is never even checked**.

**However**, even though the tool call was extracted structurally, if the tool execution fails silently (e.g., path doesn't exist, parameters are malformed, or the tool runner drops the call), the model receives no result. The model's internal state believes it issued a tool call and is waiting for a result that never arrives. **All subsequent generation stops** — no more tool calls, no more text. The session is frozen.

**This is the exact pattern reported by the user:** After the model emits the XML tool call, all activity stops. No more tool calls. No more thinking. Nothing.

This is the most dangerous leak pattern because:
1. Detection is bypassed (early bail thinks everything is fine)
2. The model appears "stuck" — it produced output, but nothing happened
3. There is no recovery mechanism for this case
4. The user sees silence and has no indication what went wrong

### Gap #4: Recovery Message Doesn't Restore Model Momentum

Even when the leak IS detected (no structural `toolCall` extracted), the current recovery message is:

```
⚠️ TEXT TOOL CALL LEAKED: You printed a tool invocation as plain text instead of calling the tool.
The leaked text was removed from context. Continue the task — invoke the tool properly so it actually runs.
```

**Problems with this recovery:**
1. **The model may not understand what "the task" is** — if the leaked tool call was the model's only action, removing it leaves the model with no context for what to do next
2. **No task restatement** — the model needs to be reminded of its current objective, not just told "continue"
3. **No tool call suggestion** — the model doesn't know which tool to invoke or what parameters to use
4. **Some models go silent after recovery** — they receive the warning but produce an empty or near-empty response because they're confused about state

---

## Why It Matters

1. **Context pollution:** Leaked tool-call text accumulates in the conversation history. Each turn adds more garbage, shrinking the effective context window.
2. **Silent failure:** The tool never runs. The model thinks it did something, but nothing happened. It may loop forever trying the same "action."
3. **No recovery:** Since the leak isn't detected, no recovery message is injected. The model has no signal to correct its behavior.
4. **Complete session freeze (Gap #3):** When Pi extracts the leaked XML as a structural tool call but execution fails silently, the model waits for a result that never comes. All generation stops. The session is dead — no more tool calls, no more thinking, no more text. This is indistinguishable from a hung process to the user.
5. **Recovery-induced silence (Gap #4):** Even when detection works, the recovery message may not be enough to restart the model. The model receives a warning but produces nothing because it lost its action context.

---

## Recommendations

### Immediate Fix A: Expand Detection Patterns

Add patterns for the most common leaked formats:

```typescript
// Additional patterns to catch:
const TOOL_CODE_TAG_RE = /<\/?tool_code\b/i;           // Antropic 2023
const INVOKE_TAG_RE = /<invoke[\s>]/i;                 // Custom invoke tags
const JSON_TOOL_CALL_RE = /{"name":"[\w-]+","arguments":/i;  // JSON function calls
const FUNCTION_CALLING_RE = /{"type":"function","function":/i;  // OpenAI function calling JSON
```

### Immediate Fix B: Improve Recovery Message

Replace the generic recovery message with one that includes task context and specific guidance:

```typescript
MSG_TEXT_TOOL_CALL:
  "⚠️ TEXT TOOL CALL LEAKED: You printed a tool invocation as plain text instead of making a proper tool call. The leaked text has been removed. Your current task is still active — please invoke the tool you intended to use using the correct tool calling mechanism. Do not print tool calls as text. Make the actual tool call now."
```

Key improvements:
- **Stronger imperative:** "Make the actual tool call now" instead of vague "continue the task"
- **Mechanism reminder:** "using the correct tool calling mechanism" reinforces the right behavior
- **Negative instruction:** "Do not print tool calls as text" explicitly blocks the bad pattern

### Immediate Fix C: Detect Post-Leak Silence

Add a `turn_end` handler that checks if the assistant message after a leak recovery was empty or near-empty:

```typescript
// In turn_end handler:
if (wasLeakRecovery && assistantText.length < 20 && toolCalls.length === 0) {
  // Model went silent after leak recovery — inject task restatement
  pi.sendMessage({
    customType: "loop-police",
    content: "Your previous tool call was malformed and could not execute. Please retry the tool call you were attempting. Use the proper tool calling interface, not plain text."
  }, { triggerTurn: true });
}
```

### Medium-Term: Heuristic Detection

For the JSON and natural language formats, consider:

1. **JSON heuristic:** If the text contains a JSON object with `name` + `arguments`/`input`/`parameters` keys, and `name` matches an active tool name → likely a leaked tool call.
2. **Active tools cross-reference:** Pass the list of active tool names (`pi.getActiveTools()`) to the detector. Any text block containing a tool name followed by argument-like syntax (JSON, key=value, parentheses) is a candidate leak.

### Medium-Term: Handle Gap #3 (Parser Extracts XML as Structured Call)

When Pi's parser extracts the XML tool call as a structural `toolCall` block:

1. **Monitor tool execution results:** If a tool call is extracted but produces no result (timeout, silent failure), inject a recovery message that tells the model to retry.
2. **Cross-check text + structural calls:** Even when `extractToolCalls(message).length > 0`, scan text blocks for XML tool-call markup. If found alongside structural calls, log a warning (the structural call may have been extracted from leaked text, not from proper tool-use format).
3. **Add tool execution timeout:** If a tool call is issued but no result arrives within X seconds, treat it as a silent failure and re-prompt the model.

### Long-Term: Remove Early Bail

Remove the `extractToolCalls(message).length > 0` guard. A message can have both valid tool calls AND leaked text. Process text blocks independently of tool call blocks.

---

## Files Involved

| File | Role |
|------|------|
| `extensions/tool-call-text.ts` | Leak detection and stripping logic |
| `extensions/response-quality.ts` | `extractAssistantText()` and `extractToolCalls()` helpers |
| `extensions/loop-police.ts` | `message_end` handler that calls `detectTextToolCallLeak()` |

## Event Flow

```
Model outputs response
  ↓
Pi agent loop parses response
  ├── Has structured toolCall blocks? → fires tool_call events → tools execute
  └── Tool calls are ONLY text → NO tool_call events fired
         ↓
      message_end fires
         ↓
      detectTextToolCallLeak() checks text blocks
         ↓
      Pattern match? → strip + re-prompt
      Pattern miss? → leaked text stays in context ← CURRENT BUG
```

## New Event Flow: Session Freeze Path (Gap #3)

```
Model outputs XML tool call (<tool_call> <function=...> </tool_call>)
  ↓
Pi parser extracts as structural toolCall block
  ↓
detectTextToolCallLeak() early-bails (extractToolCalls > 0)
  ↓
tool_call event fires → tool executes (or fails silently)
  ↓
IF tool fails silently / produces no result:
  ↓
  Model waits for result that never arrives
  ↓
  All generation stops — session frozen
  ↓
  NO detection, NO recovery, NO user notification ← CRITICAL BUG
```
