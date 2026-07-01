# pi-loop-police

A [pi](https://pi.dev) extension that detects and breaks infinite loops in real time — before they waste your context window.

Small reasoning models (Qwen, DeepSeek, etc.) are prone to several failure modes:

1. **Thinking block loop** — the model repeats the same phrases inside its thinking block until the quota is exhausted.
2. **Tool call loop** — the model calls the same sequence of tools identically across turns.
3. **Stuck local model** — the model keeps returning malformed or identical responses even after recovery prompts and changed user requests (common with llama.cpp).

Loop Police catches these **mid-stream** where possible, aborts or blocks the looping behavior, trims bad output from context, injects recovery messages, and — as a last resort — can **reload the active model** on a llama.cpp server to clear bad KV state.

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

**Layer 1 — character-level:** Every 50 streamed characters, the extension checks whether the last ≥ 80 characters of the thinking block appear verbatim immediately before them (exact adjacent repetition).

**Layer 2 — semantic-level:** The thinking text is split into paragraphs and each paragraph is fingerprinted by its first 60 characters. If the same fingerprint appears 3 or more times, the model is cycling through the same reasoning steps even if the wording varies slightly.

On match (either layer):

- `ctx.abort()` stops the stream immediately.
- `message_end` trims the repeated portion and replaces it with `[THINKING LOOP — truncated by loop-police]` or `[SEMANTIC LOOP — truncated by loop-police]`.
- A recovery message is injected and triggers a new turn.

After `CONSECUTIVE_LOOP_LIMIT` thinking loops in the same turn, the extension hard-aborts and sends an explicit recovery message.

### Cross-turn reasoning stagnation

After each clean (non-aborted) turn, thinking text is stored. When the last N turns (default: 4) all have Jaccard word-set similarity ≥ 85% with their neighbor, a stagnation recovery message is injected and the window is cleared.

### File read repetition

Before each tool call, if the tool name looks like a file-read (`read`, `view`, `cat`, etc.) and the same **file + line range** has been read 4 or more times, the call is blocked.

Reads are tracked by path **and** line range, not path alone. For example, these count separately:

- `CursaExtViewModel.cs:55-114`
- `CursaExtViewModel.cs:115-200`

Line ranges are taken from a path suffix (`:55-114`) or from tool input fields such as `offset` + `limit`, `start_line` + `end_line`, etc. Paths are normalized (case and slashes), so `C:\Foo\Bar.cs` and `c:/foo/bar.cs` share the same counter for the same range.

### Search expansion spiral

Before each search tool call (`grep`, `search`, `find`, `glob`, `rg`, etc.), the extension tracks how many distinct paths a given search pattern has been applied to. When the same pattern reaches 3 or more different paths, the call is blocked.

### Tool call sequence loop

Before each tool executes, the extension hashes `toolName + stableStringify(args)` and checks whether the last *W* calls are identical to the *W* calls immediately before them. On match, the repeated call is blocked and a recovery message is injected.

Detection is exact — only identical repetitions trigger it, not similar ones.

Tools listed in `COMMAND_EXCEPTION_LIST` are exempt from sequence-loop detection. The default list is empty; add tool names when a command must repeat legitimately (e.g. `wiki-ingest` for iterative wiki ingestion). Excepted tools can still run when a tool-loop latch is active. They are **not** exempt from file-read or search-spiral limits.

### Response quality (end of turn)

At `turn_end`, the extension checks assistant output quality:

- **Malformed response** — empty visible text with no tool calls, or tool calls with missing names / unparseable arguments.
- **Identical across prompts** — the same assistant output fingerprint as the previous turn, but the user prompt changed (model ignoring the new request).

Healthy turns reset the persistent failure counter.

### Model reload (llama.cpp)

When soft recovery (truncate, block, inject message) is not enough, loop-police escalates to a **hard model reload** on llama-server.

A session-scoped **persistent failure counter** increments on:

| Signal | Source |
|--------|--------|
| Thinking / semantic / consecutive loops | `message_update` |
| Reasoning stagnation | `message_end` |
| File read loop, search spiral, tool sequence loop | `tool_call` |
| Malformed response, identical across prompts | `turn_end` |

When the counter reaches `MODEL_RELOAD_THRESHOLD` (default: 3) and `MODEL_RELOAD_ENABLED` is true, loop-police:

1. Reads the active model from `ctx.model` (no separate server URL in loop-police config).
2. Derives the admin API from `model.baseUrl` — e.g. `http://localhost:8020/v1` → `http://localhost:8020`.
3. Authenticates via `ctx.modelRegistry.getApiKeyAndHeaders(model)` (covers `models.json`, `/login`, [pi-llama-cpp](https://github.com/gsanhueza/pi-llama-cpp) auth).
4. Reloads the model using mode-appropriate admin APIs.

**Settings preservation:** reload does **not** restart Docker or the `llama-server` process. Your startup flags (`--ctx-size`, `--n-gpu-layers`, `--spec-type draft-mtp`, sampling params, `GGML_CUDA_GRAPHS`, etc.) remain in effect. Only runtime KV / generation state is reset.

| Server mode | Reload strategy |
|-------------|-----------------|
| **Router** (`--models-preset`, `--models-dir`) | `POST /models/unload` → `POST /models/load` → poll until ready. Per-model preset args are re-applied. |
| **Single-model** (`-m` in Docker) | Skip unload (not supported). `POST /models/load` on the same model id, or slot cache erase as fallback. |

If admin reload is not supported, loop-police notifies you and suggests manual `docker restart` or router-mode llama-server. A cooldown (`MODEL_RELOAD_COOLDOWN_MS`, default 2 min) prevents reload storms.

#### Pi setup for local llama.cpp

Point Pi at your server via `~/.pi/agent/models.json` (or project `.pi/settings.json` if using pi-llama-cpp's `llamaServerUrl`):

```json
{
  "providers": {
    "llama-cpp": {
      "baseUrl": "http://localhost:8020/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [
        { "id": "Qwen3.6-27B-MTP-UD-Q4_K_XL.gguf" }
      ]
    }
  }
}
```

Use the model `id` that matches `GET http://localhost:8020/v1/models`. Loop-police uses that `baseUrl` and `id` automatically when reload is needed — you never configure a separate reload URL.

## Command

```
/loop-police                   — show current detection state and all config values
/loop-police reset             — clear all state (useful if a false positive fires)
/loop-police set KEY=VAL       — tune a config value live, no restart needed
/loop-police set KEY=VAL KEY=VAL ...  — set multiple values at once
```

Examples:

```
/loop-police set FILE_READ_LIMIT=6 STAGNATION_WINDOW=5
/loop-police set ENABLED=false
/loop-police set COMMAND_EXCEPTION_LIST=wiki-ingest
/loop-police set MODEL_RELOAD_ENABLED=false
/loop-police set MODEL_RELOAD_THRESHOLD=5 MODEL_RELOAD_COOLDOWN_MS=300000
```

Status output includes persist-failure count, reload cooldown, last reload time, and resolved admin URL when a model is active.

## Configuration

Persistent configuration lives in `extensions/loop-police.json` (auto-created on first load with defaults). Edit the file directly or tune live with `/loop-police set KEY=VAL`.

Defaults:

```typescript
ENABLED: true                    // master switch — set false to disable all detection
MIN_THINKING_WINDOW: 80          // shortest repeating phrase to flag (chars)
MAX_THINKING_WINDOW: 2000        // longest phrase checked
CHECK_STRIDE: 50                 // re-run detection every N new streamed chars
PARA_MIN_LEN: 40                  // shortest paragraph to fingerprint
PARA_FINGERPRINT_LEN: 60          // chars used as paragraph identity key
PARA_LOOP_THRESHOLD: 3            // same paragraph fingerprint N times → semantic loop
STAGNATION_WINDOW: 4              // turns of similar thinking → stagnation
STAGNATION_THRESHOLD: 0.85       // Jaccard similarity threshold for stagnation
FILE_READ_LIMIT: 4                // reads of same file + line range before blocking
SEARCH_EXPAND_LIMIT: 3            // unique paths for same search pattern before blocking
CONSECUTIVE_LOOP_LIMIT: 2          // thinking loops in a row before hard abort
COMMAND_EXCEPTION_LIST: []         // tools exempt from sequence-loop detection (empty by default)
MODEL_RELOAD_ENABLED: true        // reload llama.cpp model after persistent failures
MODEL_RELOAD_THRESHOLD: 3         // persistent failures before model reload
MODEL_RELOAD_COOLDOWN_MS: 120000  // min ms between reload attempts (2 min)
```

Disable the extension entirely:

```json
{
  "ENABLED": false
}
```

Disable only model reload (keep loop detection):

```json
{
  "MODEL_RELOAD_ENABLED": false
}
```

Exempt `wiki-ingest` from tool-sequence loop detection (iterative wiki ingestion):

```json
{
  "COMMAND_EXCEPTION_LIST": ["wiki-ingest"]
}
```

**Tuning tips:**

- Increase `MIN_THINKING_WINDOW` or `PARA_LOOP_THRESHOLD` if you get false positives on thinking loops.
- Increase `FILE_READ_LIMIT` when legitimately re-reading the same line range is common.
- Add tool names to `COMMAND_EXCEPTION_LIST` for commands that must repeat (e.g. wiki ingestion).
- Raise `MODEL_RELOAD_THRESHOLD` or `MODEL_RELOAD_COOLDOWN_MS` if reloads fire too aggressively on local models.

## Compatibility

Designed for OpenAI-compatible reasoning models (Qwen3, DeepSeek-R1, etc.) used via pi. Pi normalizes provider thinking formats to `{ type: "thinking", thinking: string }` content blocks.

Works with local [llama.cpp](https://github.com/ggml-org/llama.cpp) servers (Docker or bare install) and optionally alongside [pi-llama-cpp](https://github.com/gsanhueza/pi-llama-cpp) for model browsing — loop-police only connects to the server when a reload is actually needed.

Works alongside [pi-canary](https://github.com/sebaxzero/pi-canary), which silently verifies agent context awareness using hidden canary tokens. When loop-police aborts a turn, pi-canary yields gracefully and does not fire its own recovery.

## License

MIT

---

Built with [Claude](https://claude.ai).
