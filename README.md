# pi-loop-police

A [pi](https://pi.dev) extension that detects and breaks infinite loops in real time — before they waste your context window.

Small reasoning models (Qwen, DeepSeek, etc.) are prone to two kinds of loops:

1. **Thinking block loop** — the model repeats the same phrases inside its `<think>` block over and over until the thinking quota is exhausted.
2. **Tool call loop** — the model calls the same sequence of tools identically across turns, cycling indefinitely until the global context runs out.

Loop Police catches both **mid-stream** (not after the fact), aborts the looping output, trims it from context, and injects a recovery message so the model can continue with a fresh perspective.

## Install

```bash
pi install git:github.com/sebaxzero/pi-loop-police.git
```

Or install project-locally (adds to `.pi/settings.json` only):

```bash
pi install git:github.com/sebaxzero/pi-loop-police.git -l
```

## How it works

### Thinking loop detection (two layers, mid-stream)

**Layer 1 — character-level:** Every 50 streamed characters, the extension checks whether the last ≥ 80 characters of the thinking block appear verbatim immediately before them (exact adjacent repetition). This catches the fastest, most common form of loop mid-stream.

**Layer 2 — semantic-level:** Simultaneously, the thinking text is split into paragraphs and each paragraph is fingerprinted by its first 60 characters. If the same fingerprint appears 3 or more times, the model is cycling through the same reasoning steps even if the wording varies slightly between passes.

On match (either layer):

- `ctx.abort()` stops the stream immediately.
- `message_end` trims the repeated portion and replaces it with `[THINKING LOOP — truncated by loop-police]` or `[SEMANTIC LOOP — truncated by loop-police]`.
- A recovery message is injected into context and triggers a new turn.

### Cross-turn reasoning stagnation

After each clean (non-aborted) turn, the thinking text is stored. When the last N turns (default: 4) all have Jaccard word-set similarity ≥ 85% with their neighbor, the model is spinning without progress even though no single turn tripped the within-turn detectors. A recovery message is injected and the stagnation window is cleared.

### File read repetition

Before each tool call, if the tool name looks like a file-read (`read`, `view`, `cat`, etc.) and the same **file + line range** has been read 4 or more times, the call is blocked and a recovery message is injected.

Reads are tracked by path **and** line range, not path alone. For example, these count separately:

- `CursaExtViewModel.cs:55-114`
- `CursaExtViewModel.cs:115-200`

Line ranges are taken from a path suffix (`:55-114`) or from tool input fields such as `offset` + `limit`, `start_line` + `end_line`, etc. Paths are normalized (case and slashes), so `C:\Foo\Bar.cs` and `c:/foo/bar.cs` share the same counter for the same range.

### Search expansion spiral

Before each search tool call (`grep`, `search`, `find`, `glob`, `rg`, etc.), the extension tracks how many distinct paths a given search pattern has been applied to. When the same pattern reaches 3 or more different paths, the call is blocked — the model is widening its search rather than acting on what it already found.

### Tool call sequence loop

Before each tool executes, the extension hashes `toolName + stableStringify(args)` and appends it to a flat history. It then checks whether the last *W* calls are identical to the *W* calls immediately before them. On match:

- The repeated call is blocked (`{ block: true }`).
- A recovery message is injected explaining that the sequence is repeating and asking the model to reconsider.

Detection is exact — only identical repetitions trigger it, not similar ones.

Tools listed in `COMMAND_EXCEPTION_LIST` are exempt from sequence-loop detection. This is useful for commands that legitimately repeat, such as `wiki-ingest` (called repeatedly while ingesting wiki sources) or `LLM-WIKI`. Excepted tools can still run even when a tool-loop latch is active from a prior non-excepted detection. They are **not** exempt from file-read or search-spiral limits.

## Command

```
/loop-police                   — show current detection state and all config values
/loop-police reset             — clear all state (useful if a false positive fires)
/loop-police set KEY=VAL       — tune a config value live, no restart needed
/loop-police set KEY=VAL KEY=VAL ...  — set multiple values at once
```

Example: `/loop-police set FILE_READ_LIMIT=6 STAGNATION_WINDOW=5`

To disable loop detection for the current session:

```
/loop-police set ENABLED=false
```

To customize which tools bypass sequence-loop detection:

```
/loop-police set COMMAND_EXCEPTION_LIST=wiki-ingest,LLM-WIKI
```

## Configuration

Persistent configuration lives in `extensions/loop-police.json` (auto-created on first load with defaults). You can ask the agent to edit it directly, or tune values live with `/loop-police set KEY=VAL`.

Defaults:

```typescript
ENABLED: true               // master switch — set false to disable all detection
MIN_THINKING_WINDOW: 80     // shortest repeating phrase to flag (chars)
MAX_THINKING_WINDOW: 2000   // longest phrase checked
CHECK_STRIDE: 50            // re-run detection every N new streamed chars
PARA_MIN_LEN: 40            // shortest paragraph to fingerprint
PARA_FINGERPRINT_LEN: 60    // chars used as paragraph identity key
PARA_LOOP_THRESHOLD: 3      // same paragraph fingerprint N times → semantic loop
STAGNATION_WINDOW: 4        // turns of similar thinking → stagnation
STAGNATION_THRESHOLD: 0.85  // Jaccard similarity threshold for stagnation
FILE_READ_LIMIT: 4          // reads of same file + line range before blocking
SEARCH_EXPAND_LIMIT: 3      // unique paths for same search pattern before blocking
CONSECUTIVE_LOOP_LIMIT: 2   // thinking loops in a row before hard abort
COMMAND_EXCEPTION_LIST: ["wiki-ingest", "LLM-WIKI"]  // tools exempt from sequence-loop detection
```

Set `ENABLED` to `false` in `loop-police.json` to disable the extension entirely without uninstalling it:

```json
{
  "ENABLED": false
}
```

Increase `MIN_THINKING_WINDOW` or `PARA_LOOP_THRESHOLD` if you get false positives on thinking loops. Increase `FILE_READ_LIMIT` for projects where legitimately re-reading the same line range is common. Add tool names to `COMMAND_EXCEPTION_LIST` when a command must be called repeatedly as part of normal workflow (e.g. iterative wiki ingestion).

## Compatibility

Designed for OpenAI-compatible reasoning models (Qwen3, DeepSeek-R1, etc.) used via pi. Pi normalizes all provider thinking formats to `{ type: "thinking", thinking: string }` content blocks, so this extension works regardless of the underlying provider.

Works alongside [pi-canary](https://github.com/sebaxzero/pi-canary), which silently verifies agent context awareness using hidden canary tokens. When loop-police aborts a turn, pi-canary yields gracefully and does not fire its own recovery.

## License

MIT

---

Built with [Claude](https://claude.ai).
