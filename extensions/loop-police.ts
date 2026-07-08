import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attemptModelReload, deriveAdminBaseUrl } from "./llama-reload.ts";
import {
  fingerprintUserPromptFromBranch,
  shouldCountPersistFailure,
  type PromptFingerprints,
} from "./response-quality.ts";

// Config lives next to the extension file: ./extensions/loop-police.json
// Auto-created on first load with defaults; travels with the extension.
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXT_DIR, "loop-police.json");

const NUMERIC_DEFAULTS = {
  ENABLED: 1, // 1 = true, stored as number for /loop-police set compatibility
  MIN_THINKING_WINDOW: 80,
  MAX_THINKING_WINDOW: 2000,
  CHECK_STRIDE: 50,
  PARA_MIN_LEN: 40,
  PARA_FINGERPRINT_LEN: 60,
  PARA_LOOP_THRESHOLD: 3,
  STAGNATION_WINDOW: 4,
  STAGNATION_THRESHOLD: 0.85,
  FILE_READ_LIMIT: 4,
  SEARCH_EXPAND_LIMIT: 3,
  CONSECUTIVE_LOOP_LIMIT: 2,
  COMMAND_EXCEPTION_LIST: [] as string[],
  MODEL_RELOAD_ENABLED: 1, // 1 = true
  MODEL_RELOAD_THRESHOLD: 3,
  MODEL_RELOAD_COOLDOWN_MS: 120000,
  TOOL_LOOP_BAN: 0, // 0 = block identical call only while repeated back-to-back;
  //                   1 = ban that exact call for the rest of the session
};

// Recovery messages injected into the agent when a loop is detected. Edit these
// in loop-police.json to tune the wording per model — some models respond
// better to different phrasing. Placeholders in {braces} are filled at runtime:
//   MSG_CONSECUTIVE_LOOP → {count}
//   MSG_STAGNATION       → {window} {threshold}
//   MSG_FILE_READ_LOOP   → {path} {count}
//   MSG_SEARCH_SPIRAL    → {pattern} {paths}
//   MSG_TOOL_LOOP        → {windowSize}
const MESSAGE_DEFAULTS = {
  MSG_THINKING_LOOP:
    "⚠️ THINKING LOOP DETECTED: Your thinking block was repeating the same phrases verbatim and has been truncated. Re-examine your approach and continue with the task.",
  MSG_SEMANTIC_LOOP:
    "⚠️ SEMANTIC LOOP DETECTED: Your thinking block was cycling through the same reasoning steps repeatedly. The repeated section has been truncated. Step back and try a completely different approach.",
  MSG_CONSECUTIVE_LOOP:
    "⚠️ CONSECUTIVE LOOP ({count}x): You have entered a thinking loop {count} times in a row and loop-police has aborted your thinking each time. Stop thinking now — provide a direct answer or ask for clarification.",
  MSG_STAGNATION:
    "⚠️ REASONING STAGNATION: Your thinking across the last {window} turns has been {threshold}%+ similar — you are not making progress. Stop and try a fundamentally different approach.",
  MSG_FILE_READ_LOOP:
    '⚠️ FILE READ LOOP: "{path}" has been read {count} times. Reading it again will not yield new information — use what you already know and move forward.',
  MSG_SEARCH_SPIRAL:
    '⚠️ SEARCH EXPANSION SPIRAL: Pattern "{pattern}" has been searched in {paths} different locations. Broadening the scope further will not help — reconsider what you are looking for.',
  MSG_TOOL_LOOP:
    "⚠️ TOOL CALL LOOP: The same sequence of {windowSize} tool call(s) is repeating identically and has been blocked — this exact call did NOT run and will keep being blocked if you repeat it. It produced no new result last time and won't now. Change your approach: try a different command, or use what you already learned to move forward.",
};

const DEFAULTS = { ...NUMERIC_DEFAULTS, ...MESSAGE_DEFAULTS };

const cfg: typeof DEFAULTS & Record<string, number | string | boolean | string[]> = (() => {
  // Read the existing config (null = missing or unreadable/corrupt).
  let fromFile: Record<string, unknown> | null = null;
  try {
    if (existsSync(CONFIG_PATH)) fromFile = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    fromFile = null; // corrupt JSON — leave the file untouched, use defaults
  }
  const merged = { ...DEFAULTS, ...(fromFile ?? {}) } as typeof DEFAULTS &
    Record<string, number | string | boolean | string[]>;

  // Write the file when it is absent, or backfill it when an upgrade added new
  // keys the on-disk file is missing — so users can discover and edit them.
  // Never overwrite a file that failed to parse (fromFile === null && exists).
  const fileExists = existsSync(CONFIG_PATH);
  const backfillNeeded =
    fromFile !== null && Object.keys(DEFAULTS).some((k) => !(k in fromFile));
  if (!fileExists || backfillNeeded) {
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    } catch {
      // If we can't write (e.g. permissions), just use defaults in memory
    }
  }
  return merged;
})();

function isEnabled(): boolean {
  const val = cfg.ENABLED;
  return val === true || val === 1;
}

export default function (pi: ExtensionAPI) {
  let thinkingAborted = false;
  let cleanThinkingPrefix: string | null = null;
  let lastCheckedLen = 0;
  let loopType: "character" | "semantic" = "character";
  let toolHistory: string[] = [];
  let bannedCalls = new Set<string>();
  let thinkingHistory: string[] = [];
  let fileReadCounts = new Map<string, number>();
  let searchPatternPaths = new Map<string, Set<string>>();
  let consecutiveLoopCount = 0;
  let persistFailureCount = 0;
  let lastReloadAt = 0;
  let reloadInProgress = false;
  let lastResolvedAdminUrl: string | null = null;
  let lastPromptFingerprints: PromptFingerprints | null = null;

  async function recordPersistFailure(reason: string, ctx: ExtensionContext) {
    persistFailureCount++;
    if (!cfg.MODEL_RELOAD_ENABLED || persistFailureCount < cfg.MODEL_RELOAD_THRESHOLD) return;
    await maybeReloadModel(ctx, reason);
  }

  async function maybeReloadModel(ctx: ExtensionContext, reason: string) {
    if (reloadInProgress) return;
    const now = Date.now();
    if (now - lastReloadAt < cfg.MODEL_RELOAD_COOLDOWN_MS) return;

    const model = ctx.model;
    if (!model?.baseUrl) {
      ctx.ui.notify("Loop Police: model reload skipped — no baseUrl on active model", "warning");
      lastReloadAt = now;
      return;
    }

    reloadInProgress = true;
    lastResolvedAdminUrl = deriveAdminBaseUrl(model.baseUrl);

    try {
      const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      const auth = authResult.ok
        ? { apiKey: authResult.apiKey, headers: authResult.headers }
        : undefined;

      ctx.ui.notify(`Loop Police: reloading model (${reason})…`, "warning");
      const result = await attemptModelReload(model.baseUrl, model.id, auth);

      lastReloadAt = Date.now();
      persistFailureCount = 0;
      lastPromptFingerprints = null;

      if (result.ok) {
        reset();
        ctx.ui.notify(`Loop Police: ${result.message}`, "info");
        pi.sendMessage(
          {
            customType: "loop-police",
            content: `🔄 MODEL RELOADED: Persistent loops detected (${reason}). The llama-server model was reloaded to clear bad KV/state. Server CLI settings are unchanged — only runtime cache was reset. Continue with a fresh approach.`,
            display: true,
          },
          { triggerTurn: true }
        );
      } else {
        ctx.ui.notify(`Loop Police: model reload skipped — ${result.message}`, "warning");
        pi.sendMessage(
          {
            customType: "loop-police",
            content: `⚠️ MODEL RELOAD SKIPPED: Persistent loops detected (${reason}) but automatic reload failed (${result.message}). Try manual docker restart or router-mode llama-server if this keeps happening.`,
            display: true,
          },
          { triggerTurn: true }
        );
      }
    } catch (err) {
      lastReloadAt = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Loop Police: model reload error — ${msg}`, "error");
    } finally {
      reloadInProgress = false;
    }
  }

  function reset() {
    thinkingAborted = false;
    cleanThinkingPrefix = null;
    lastCheckedLen = 0;
    loopType = "character";
    toolHistory = [];
    bannedCalls = new Set();
    thinkingHistory = [];
    fileReadCounts = new Map();
    searchPatternPaths = new Map();
    consecutiveLoopCount = 0;
    persistFailureCount = 0;
    lastPromptFingerprints = null;
  }

  pi.on("agent_start", reset);

  pi.on("turn_start", () => {
    lastCheckedLen = 0;
    thinkingAborted = false;
    cleanThinkingPrefix = null;
    loopType = "character";
    // NOTE: consecutiveLoopCount is intentionally NOT reset here. Recovery
    // turns fire turn_start, so resetting would defeat cross-turn escalation.
    // It is cleared on a clean (non-aborted) turn in message_end instead.
    // toolHistory / bannedCalls also persist across turns (reset on agent_start).
  });

  pi.on("message_update", async (event, ctx) => {
    if (!isEnabled() || thinkingAborted || event.message.role !== "assistant") return;
    const thinking = extractThinking(event.message);
    if (!thinking || thinking.length < lastCheckedLen + cfg.CHECK_STRIDE) return;
    lastCheckedLen = thinking.length;
    if (thinking.length < cfg.MIN_THINKING_WINDOW * 2) return;

    let repeat = detectRepeatingSuffix(thinking);
    if (repeat) {
      loopType = "character";
    } else {
      repeat = detectSemanticLoop(thinking);
      if (repeat) loopType = "semantic";
    }
    if (!repeat) return;

    thinkingAborted = true;
    cleanThinkingPrefix = repeat.cleanPrefix;
    consecutiveLoopCount++;
    // Only abort here; message_end decides which recovery message to send
    // (escalated vs. normal) so a single turn is triggered, not two.
    ctx.abort();
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isEnabled() || event.message.role !== "assistant") return;

    if (thinkingAborted) {
      const prefix = cleanThinkingPrefix ?? "";
      thinkingAborted = false;
      cleanThinkingPrefix = null;
      lastCheckedLen = 0;

      const isSemantic = loopType === "semantic";
      const label = isSemantic
        ? "[SEMANTIC LOOP — truncated by loop-police]"
        : "[THINKING LOOP — truncated by loop-police]";
      const advice =
        consecutiveLoopCount >= cfg.CONSECUTIVE_LOOP_LIMIT
          ? fmt(cfg.MSG_CONSECUTIVE_LOOP, { count: consecutiveLoopCount })
          : isSemantic
            ? String(cfg.MSG_SEMANTIC_LOOP)
            : String(cfg.MSG_THINKING_LOOP);

      const cleaned = replaceThinking(event.message, `${prefix}\n\n${label}`);
      pi.sendMessage(
        { customType: "loop-police", content: advice, display: true },
        { triggerTurn: true }
      );
      return { message: cleaned };
    }

    // Clean turn — the model produced a non-looping thinking block, so it is
    // making progress. Clear the consecutive-loop escalation counter.
    consecutiveLoopCount = 0;

    // Cross-turn stagnation: only run on clean (non-aborted) turns
    const thinking = extractThinking(event.message);
    if (thinking) {
      thinkingHistory.push(thinking);
      if (thinkingHistory.length > cfg.STAGNATION_WINDOW) thinkingHistory.shift();

      if (thinkingHistory.length >= cfg.STAGNATION_WINDOW) {
        const stagnant = thinkingHistory.every(
          (t, i) => i === 0 || jaccard(thinkingHistory[i - 1], t) >= cfg.STAGNATION_THRESHOLD
        );
        if (stagnant) {
          thinkingHistory = [];
          void recordPersistFailure("reasoning stagnation", ctx);
          pi.sendMessage(
            {
              customType: "loop-police",
              content: fmt(cfg.MSG_STAGNATION, {
                window: cfg.STAGNATION_WINDOW,
                threshold: Math.round(cfg.STAGNATION_THRESHOLD * 100),
              }),
              display: true,
            },
            { triggerTurn: true }
          );
        }
      }
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isEnabled()) return;

    const excepted = isExceptedTool(event.toolName);

    // File read repetition
    if (isReadTool(event.toolName)) {
      const path = getInputPath(event.input);
      if (path) {
        const readKey = getFileReadKey(path, event.input);
        const count = (fileReadCounts.get(readKey) ?? 0) + 1;
        fileReadCounts.set(readKey, count);
        if (count >= cfg.FILE_READ_LIMIT) {
          void recordPersistFailure("file read loop", ctx);
          ctx.ui.notify(`⚠️ FILE READ LOOP: "${readKey}" read ${count}x — blocked`, "warning");
          pi.sendMessage(
            {
              customType: "loop-police",
              content: fmt(cfg.MSG_FILE_READ_LOOP, { path, count }),
              display: true,
            },
            { triggerTurn: true }
          );
          return { block: true, reason: `loop-police: file read ${count}x — ${readKey}` };
        }
      }
    }

    // Search expansion spiral
    if (isSearchTool(event.toolName)) {
      const pattern = getSearchPattern(event.input);
      if (pattern) {
        const searchPath = getInputPath(event.input) ?? "*";
        const paths = searchPatternPaths.get(pattern) ?? new Set<string>();
        paths.add(searchPath);
        searchPatternPaths.set(pattern, paths);
        if (paths.size >= cfg.SEARCH_EXPAND_LIMIT) {
          void recordPersistFailure("search spiral", ctx);
          ctx.ui.notify(`⚠️ SEARCH SPIRAL: "${pattern}" across ${paths.size} paths — blocked`, "warning");
          pi.sendMessage(
            {
              customType: "loop-police",
              content: fmt(cfg.MSG_SEARCH_SPIRAL, { pattern, paths: paths.size }),
              display: true,
            },
            { triggerTurn: true }
          );
          return { block: true, reason: `loop-police: search spiral "${pattern}" ×${paths.size} paths` };
        }
      }
    }

    // Tool call sequence loop (excepted tools may repeat, e.g. wiki-ingest)
    if (!excepted) {
      // Permanent-ban mode (TOOL_LOOP_BAN=1): once a call has looped, that exact
      // call stays blocked for the rest of the session, no matter what.
      const hash = hashToolCall(event.toolName, event.input);
      if (cfg.TOOL_LOOP_BAN && bannedCalls.has(hash)) {
        ctx.ui.notify(`⚠️ TOOL LOOP: identical call blocked (banned)`, "warning");
        return { block: true, reason: fmt(cfg.MSG_TOOL_LOOP, { windowSize: 1 }) };
      }

      const windowSize = detectSequenceRepeat([...toolHistory, hash]);
      if (windowSize > 0) {
        if (cfg.TOOL_LOOP_BAN) bannedCalls.add(hash);
        void recordPersistFailure("tool call loop", ctx);
        ctx.ui.notify(`⚠️ TOOL LOOP: ${windowSize}-call sequence repeating — blocked`, "warning");
        // Do NOT record the blocked call: toolHistory stays at the looping state
        // so a renewed identical attempt trips the detector again in place. The
        // moment the model does something different, adjacency breaks and the
        // call is allowed again (safe for build/test/lint re-runs).
        return { block: true, reason: fmt(cfg.MSG_TOOL_LOOP, { windowSize }) };
      }

      toolHistory.push(hash);
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!isEnabled() || event.message.role !== "assistant") return;

    const branch = ctx.sessionManager.getBranch() as unknown[];
    const quality = shouldCountPersistFailure(event.message, branch, lastPromptFingerprints);

    if (quality.curr) {
      lastPromptFingerprints = quality.curr;
    }
    }

    if (quality.count && quality.reason) {
      await recordPersistFailure(quality.reason, ctx);
    } else if (!quality.count) {
      persistFailureCount = 0;
    }
  });

  pi.registerCommand("loop-police", {
    description: "Show status; /loop-police reset; /loop-police set KEY=VAL [KEY=VAL ...]",
    handler: (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      if (trimmed === "reset") {
        reset();
        ctx.ui.notify("Loop Police: state reset", "info");
        return;
      }

      if (trimmed.startsWith("set ")) {
        const results = trimmed
          .slice(4)
          .trim()
          .split(/\s+/)
          .map((pair) => setConfigValue(cfg, pair));
        ctx.ui.notify(`Loop Police: ${results.join(", ")}`, "info");
        return;
      }

      ctx.ui.notify(
        [
          "Loop Police status",
          `  enabled:             ${isEnabled()}`,
          `  thinking aborted:    ${thinkingAborted}`,
          `  tool history:        ${toolHistory.length} calls`,
          `  banned calls:        ${bannedCalls.size}`,
          `  stagnation history:  ${thinkingHistory.length}/${cfg.STAGNATION_WINDOW} turns`,
          `  file reads tracked:  ${fileReadCounts.size} keys`,
          `  search patterns:     ${searchPatternPaths.size} patterns`,
          `  consecutive loops:   ${consecutiveLoopCount}/${cfg.CONSECUTIVE_LOOP_LIMIT}`,
          `  persist failures:    ${persistFailureCount}/${cfg.MODEL_RELOAD_THRESHOLD}`,
          `  model reload:        ${cfg.MODEL_RELOAD_ENABLED ? "enabled" : "disabled"}`,
          `  reload in progress:  ${reloadInProgress}`,
          `  last reload:         ${lastReloadAt ? new Date(lastReloadAt).toISOString() : "never"}`,
          `  admin URL:           ${lastResolvedAdminUrl ?? (ctx.model?.baseUrl ? deriveAdminBaseUrl(ctx.model.baseUrl) : "n/a")}`,
          "",
          "  config (set KEY=VAL to change):",
          ...Object.keys(NUMERIC_DEFAULTS).map((k) => `    ${k}=${cfg[k]}`),
          "",
          "  messages (edit loop-police.json to customize):",
          ...Object.keys(MESSAGE_DEFAULTS).map((k) => `    ${k}`),
        ].join("\n"),
        "info"
      );
    },
  });

  pi.registerMessageRenderer("loop-police", (message, _opts, theme) =>
    new Text(theme.fg("warning", String(message.content)), 0, 0)
  );
}

// helpers

// Fill {placeholder} tokens in a message template. Unknown tokens are left as-is
// so a typo in a user-edited template is visible rather than silently dropped.
function fmt(template: string | number, vars: Record<string, string | number>): string {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    key in vars ? String(vars[key]) : whole
  );
}

// Parse and apply a single "KEY=VAL" assignment against `target`, mutating it
// on success. Returns a human-readable status string for the notification.
// Rejects unknown keys and non-finite values (e.g. "3px", "", "abc") so a bad
// input never silently writes NaN into a threshold and disables a detector.
// Message templates (MSG_*) are string-valued and thus rejected here by design —
// they are edited in loop-police.json, not via /loop-police set.
function setConfigValue(target: Record<string, number | string>, pair: string): string {
  const eq = pair.indexOf("=");
  if (eq <= 0) return `unknown: ${pair}`;
  const key = pair.slice(0, eq);
  const val = pair.slice(eq + 1);
  if (!(key in target)) return `unknown: ${key}`;
  // Only numeric config is settable here; string templates are JSON-only.
  if (typeof target[key] === "string") return `not settable: ${key} (edit loop-police.json)`;
  const num = Number(val);
  if (val === "" || !Number.isFinite(num)) return `invalid: ${key}=${val}`;
  target[key] = num;
  return `${key}=${num}`;
}

function jaccard(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

function isReadTool(name: string): boolean {
  return /\bread|view|cat\b/i.test(name);
}

function isSearchTool(name: string): boolean {
  return /grep|search|find|glob|\brg\b/i.test(name);
}

function getInputPath(input: unknown): string | null {
  if (typeof input !== "object" || !input) return null;
  const inp = input as any;
  return inp.path ?? inp.file_path ?? inp.filename ?? inp.file ?? inp.directory ?? inp.dir ?? null;
}

function isExceptedTool(toolName: string): boolean {
  return cfg.COMMAND_EXCEPTION_LIST.some(
    (name) => toolName === name || toolName.toLowerCase() === name.toLowerCase()
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function parsePathLineSuffix(path: string): { filePath: string; lineRange: string | null } {
  const rangeMatch = path.match(/:(\d+)(?:-(\d+))?$/);
  if (!rangeMatch) return { filePath: path, lineRange: null };
  const start = rangeMatch[1];
  const end = rangeMatch[2] ?? start;
  return {
    filePath: path.slice(0, rangeMatch.index),
    lineRange: `${start}-${end}`,
  };
}

function getLineRangeFromInput(input: unknown): string | null {
  if (typeof input !== "object" || !input) return null;
  const inp = input as Record<string, unknown>;

  const start = inp.start_line ?? inp.line_start ?? inp.start ?? inp.offset;
  const end = inp.end_line ?? inp.line_end ?? inp.end;
  const limit = inp.limit;

  if (start != null && end != null) return `${start}-${end}`;
  if (start != null && limit != null) {
    const startNum = Number(start);
    const limitNum = Number(limit);
    if (!Number.isNaN(startNum) && !Number.isNaN(limitNum) && limitNum > 0) {
      return `${startNum}-${startNum + limitNum - 1}`;
    }
  }
  if (start != null) return `${start}-${start}`;
  return null;
}

function getFileReadKey(path: string, input: unknown): string {
  const { filePath, lineRange: pathLineRange } = parsePathLineSuffix(path);
  const inputLineRange = getLineRangeFromInput(input);
  const lineRange = inputLineRange ?? pathLineRange;
  const normalized = normalizePath(filePath);
  return lineRange ? `${normalized}:${lineRange}` : normalized;
}

function getSearchPattern(input: unknown): string | null {
  if (typeof input !== "object" || !input) return null;
  const inp = input as any;
  return inp.pattern ?? inp.query ?? inp.regex ?? inp.search ?? inp.term ?? null;
}

function extractThinking(message: any): string | null {
  if (!Array.isArray(message?.content)) return null;
  for (const block of message.content) {
    if (block.type === "thinking" && typeof block.thinking === "string")
      return block.thinking;
  }
  return null;
}

function replaceThinking(message: any, newText: string): any {
  if (!Array.isArray(message?.content)) return message;
  let done = false;
  const content = message.content.map((block: any) => {
    if (done || block.type !== "thinking") return block;
    done = true;
    return { ...block, thinking: newText };
  });
  return { ...message, content };
}

function detectSemanticLoop(text: string): { cleanPrefix: string } | null {
  const counts = new Map<string, number>();
  let searchFrom = 0;
  for (const para of text.split(/\n\n+/)) {
    const paraStart = text.indexOf(para, searchFrom);
    if (paraStart === -1) continue;
    searchFrom = paraStart + para.length;
    const trimmed = para.trim();
    if (trimmed.length >= cfg.PARA_MIN_LEN) {
      const key = trimmed.slice(0, cfg.PARA_FINGERPRINT_LEN);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count >= cfg.PARA_LOOP_THRESHOLD) {
        return { cleanPrefix: text.slice(0, paraStart) };
      }
    }
  }
  return null;
}

function detectRepeatingSuffix(text: string): { cleanPrefix: string } | null {
  const n = text.length;
  const limit = Math.min(cfg.MAX_THINKING_WINDOW, Math.floor(n / 2));
  for (let w = cfg.MIN_THINKING_WINDOW; w <= limit; w++) {
    const tail = text.slice(n - w);
    const prev = text.slice(n - 2 * w, n - w);
    if (prev.length === w && tail === prev) {
      return { cleanPrefix: text.slice(0, n - w) };
    }
  }
  return null;
}

function detectSequenceRepeat(history: string[]): number {
  const n = history.length;
  for (let w = 1; w <= Math.floor(n / 2); w++) {
    const tail = history.slice(n - w);
    const prev = history.slice(n - w * 2, n - w);
    if (prev.length === w && tail.every((v, i) => v === prev[i])) return w;
  }
  return 0;
}

function hashToolCall(toolName: string, input: unknown): string {
  return `${toolName}:${stableStringify(input)}`;
}

function stableStringify(val: unknown): string {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(stableStringify).join(",")}]`;
  const keys = Object.keys(val as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((val as any)[k])}`).join(",")}}`;
}
