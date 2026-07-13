// Run: node --test test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Pure logic duplicated from extensions/loop-police.ts — no build step
const MIN_THINKING_WINDOW = 80;
const MAX_THINKING_WINDOW = 2000;
const PARA_MIN_LEN = 40;
const PARA_FINGERPRINT_LEN = 60;
const PARA_LOOP_THRESHOLD = 3;

function detectRepeatingSuffix(text) {
  const n = text.length;
  const limit = Math.min(MAX_THINKING_WINDOW, Math.floor(n / 2));
  for (let w = MIN_THINKING_WINDOW; w <= limit; w++) {
    const tail = text.slice(n - w);
    const prev = text.slice(n - 2 * w, n - w);
    if (prev.length === w && tail === prev) return { cleanPrefix: text.slice(0, n - w) };
  }
  return null;
}

function detectSemanticLoop(text) {
  const counts = new Map();
  let searchFrom = 0;
  for (const para of text.split(/\n\n+/)) {
    const paraStart = text.indexOf(para, searchFrom);
    if (paraStart === -1) continue;
    searchFrom = paraStart + para.length;
    const trimmed = para.trim();
    if (trimmed.length >= PARA_MIN_LEN) {
      const key = trimmed.slice(0, PARA_FINGERPRINT_LEN);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count >= PARA_LOOP_THRESHOLD) return { cleanPrefix: text.slice(0, paraStart) };
    }
  }
  return null;
}

function detectSequenceRepeat(history) {
  const n = history.length;
  for (let w = 1; w <= Math.floor(n / 2); w++) {
    const tail = history.slice(n - w);
    const prev = history.slice(n - w * 2, n - w);
    if (prev.length === w && tail.every((v, i) => v === prev[i])) return w;
  }
  return 0;
}

function extractThinking(message) {
  if (!Array.isArray(message?.content)) return null;
  for (const block of message.content)
    if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
  return null;
}

function replaceThinking(message, newText) {
  if (!Array.isArray(message?.content)) return message;
  let done = false;
  const content = message.content.map((block) => {
    if (done || block.type !== "thinking") return block;
    done = true;
    return { ...block, thinking: newText };
  });
  return { ...message, content };
}

function stableStringify(val) {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(stableStringify).join(",")}]`;
  const keys = Object.keys(val).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(val[k])}`).join(",")}}`;
}

function hashToolCall(toolName, input) {
  return `${toolName}:${stableStringify(input)}`;
}

function jaccard(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

function setConfigValue(target, pair) {
  const eq = pair.indexOf("=");
  if (eq <= 0) return `unknown: ${pair}`;
  const key = pair.slice(0, eq);
  const val = pair.slice(eq + 1);
  if (!(key in target)) return `unknown: ${key}`;
  if (typeof target[key] === "string") return `not settable: ${key} (edit loop-police.json)`;
  const num = Number(val);
  if (val === "" || !Number.isFinite(num)) return `invalid: ${key}=${val}`;
  target[key] = num;
  return `${key}=${num}`;
}

function migrateToolLoopBan(fromFile) {
  if (!fromFile || fromFile.CONFIG_VERSION !== undefined) return null;
  const old = fromFile.TOOL_LOOP_BAN;
  if (old !== 0 && old !== 1) return null;
  return old + 1;
}

function fmt(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    key in vars ? String(vars[key]) : whole
  );
}

function isReadTool(name) { return /\bread|view|cat\b/i.test(name); }
function isSearchTool(name) { return /grep|search|find|glob|\brg\b/i.test(name); }

function getInputPath(input) {
  if (typeof input !== "object" || !input) return null;
  return input.path ?? input.file_path ?? input.filename ?? input.file ?? input.directory ?? input.dir ?? null;
}

function getSearchPattern(input) {
  if (typeof input !== "object" || !input) return null;
  return input.pattern ?? input.query ?? input.regex ?? input.search ?? input.term ?? null;
}

const COMMAND_EXCEPTION_LIST = [];

function isExceptedTool(toolName, list = COMMAND_EXCEPTION_LIST) {
  return list.some(
    (name) => toolName === name || toolName.toLowerCase() === name.toLowerCase()
  );
}

function normalizePath(path) {
  return path.replace(/\\/g, "/").toLowerCase();
}

function parsePathLineSuffix(path) {
  const rangeMatch = path.match(/:(\d+)(?:-(\d+))?$/);
  if (!rangeMatch) return { filePath: path, lineRange: null };
  const start = rangeMatch[1];
  const end = rangeMatch[2] ?? start;
  return {
    filePath: path.slice(0, rangeMatch.index),
    lineRange: `${start}-${end}`,
  };
}

function getLineRangeFromInput(input) {
  if (typeof input !== "object" || !input) return null;
  const start = input.start_line ?? input.line_start ?? input.start ?? input.offset;
  const end = input.end_line ?? input.line_end ?? input.end;
  const limit = input.limit;
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

function getFileReadKey(path, input) {
  const { filePath, lineRange: pathLineRange } = parsePathLineSuffix(path);
  const inputLineRange = getLineRangeFromInput(input);
  const lineRange = inputLineRange ?? pathLineRange;
  const normalized = normalizePath(filePath);
  return lineRange ? `${normalized}:${lineRange}` : normalized;
}

function trackFileRead(fileReadCounts, path, input, limit) {
  const readKey = getFileReadKey(path, input);
  const count = (fileReadCounts.get(readKey) ?? 0) + 1;
  fileReadCounts.set(readKey, count);
  return { readKey, count, blocked: count >= limit };
}

function trackSequenceCall(sequenceHistory, toolName, input, exceptionList = COMMAND_EXCEPTION_LIST) {
  if (isExceptedTool(toolName, exceptionList)) return { blocked: false, windowSize: 0 };
  const hash = hashToolCall(toolName, input);
  const candidate = [...sequenceHistory, hash];
  const windowSize = detectSequenceRepeat(candidate);
  if (windowSize > 0) return { blocked: true, windowSize };
  sequenceHistory.push(hash);
  return { blocked: false, windowSize: 0 };
}

// ponytail: local helper that mirrors the stagnation check in message_end
function isStagnant(history, window, threshold) {
  if (history.length < window) return false;
  const recent = history.slice(-window);
  return recent.every((t, i) => i === 0 || jaccard(recent[i - 1], t) >= threshold);
}

// ---------------------------------------------------------------------------
// Fixtures — phrases must be > MIN_THINKING_WINDOW (80 chars)
// ---------------------------------------------------------------------------

const A = "I'm realizing the core issue: the model only allows one active profile per model. ";   // 82
const B = "The most practical approach would be to merge parameters from multiple profiles.   ";  // 82
const C = "However there might be parameter conflicts when two profiles define the same key.   ";  // 83

assert.ok(A.length > MIN_THINKING_WINDOW, "fixture A must be > 80 chars");
assert.ok(B.length > MIN_THINKING_WINDOW, "fixture B must be > 80 chars");
assert.ok(C.length > MIN_THINKING_WINDOW, "fixture C must be > 80 chars");

// Semantic loop fixtures — must be > PARA_MIN_LEN (40 chars)
const P1 = "The segfault might be related to the ComboBox widget initialization and timing.";
const P2 = "Actually, no. The set_profiles method is called after the UI is fully built here.";
const P3 = "OK, I am going in circles. Let me just try running the app to reproduce this.";
const P4 = "Let me check if there is an issue with the way I am creating the ComboBox widget.";

assert.ok(P1.length > PARA_MIN_LEN, "fixture P1 must be > PARA_MIN_LEN");
assert.ok(P2.length > PARA_MIN_LEN, "fixture P2 must be > PARA_MIN_LEN");
assert.ok(P3.length > PARA_MIN_LEN, "fixture P3 must be > PARA_MIN_LEN");
assert.ok(P4.length > PARA_MIN_LEN, "fixture P4 must be > PARA_MIN_LEN");

// ---------------------------------------------------------------------------

describe("detectRepeatingSuffix", () => {
  test("unique text — no loop", () => {
    assert.equal(detectRepeatingSuffix(A + B + C), null);
  });

  test("text shorter than MIN_THINKING_WINDOW * 2 — no detection", () => {
    assert.equal(detectRepeatingSuffix(A), null);
  });

  test("detects A+B+A+B loop", () => {
    assert.notEqual(detectRepeatingSuffix(A + B + A + B), null);
  });

  test("cleanPrefix for A+B+A+B is A+B", () => {
    assert.equal(detectRepeatingSuffix(A + B + A + B).cleanPrefix, A + B);
  });

  test("half-cycle A+B+A does not trigger", () => {
    assert.equal(detectRepeatingSuffix(A + B + A), null);
  });

  test("non-adjacent A+B+C+A+B does not trigger (C breaks adjacency)", () => {
    assert.equal(detectRepeatingSuffix(A + B + C + A + B), null);
  });

  test("three-cycle A+B+A+B+A+B still detects", () => {
    assert.notEqual(detectRepeatingSuffix(A + B + A + B + A + B), null);
  });

  test("no false positive: similar but not identical phrases", () => {
    const A1 = "I'm realizing the core issue: the model only allows one active profile per model. ";
    const A2 = "I'm realizing the core issue: the model only allows one active profile per MODEL. ";
    assert.equal(detectRepeatingSuffix(A1 + B + A2 + B), null);
  });

  test("repeating unit longer than MAX_THINKING_WINDOW is not detected (cap)", () => {
    let unit = "";
    for (let i = 0; unit.length <= MAX_THINKING_WINDOW; i++) unit += `segment ${i} of unique filler text. `;
    assert.equal(detectRepeatingSuffix(unit + unit), null);
  });

  test("streaming simulation: loop fires before stream ends", () => {
    const fullLoop = A + B + A + B + A + B;
    let detected = false;
    let detectedAt = -1;
    const CHECK_STRIDE = 50;
    for (let i = CHECK_STRIDE; i <= fullLoop.length; i += CHECK_STRIDE) {
      const chunk = fullLoop.slice(0, i);
      if (chunk.length < MIN_THINKING_WINDOW * 2) continue;
      if (detectRepeatingSuffix(chunk)) { detected = true; detectedAt = i; break; }
    }
    assert.ok(detected, "loop should be detected before stream ends");
    assert.ok(detectedAt < fullLoop.length, `detection at ${detectedAt} should precede end ${fullLoop.length}`);
  });
});

describe("detectSequenceRepeat", () => {
  test("empty history — no loop", () => assert.equal(detectSequenceRepeat([]), 0));
  test("single call — no loop", () => assert.equal(detectSequenceRepeat(["h1"]), 0));
  test("two different calls — no loop", () => assert.equal(detectSequenceRepeat(["h1", "h2"]), 0));
  test("same call twice → window 1", () => assert.equal(detectSequenceRepeat(["h1", "h1"]), 1));
  test("two-call sequence repeated → window 2", () => assert.equal(detectSequenceRepeat(["h1", "h2", "h1", "h2"]), 2));
  test("three-call sequence repeated → window 3", () => assert.equal(detectSequenceRepeat(["h1", "h2", "h3", "h1", "h2", "h3"]), 3));
  test("partial second repetition — no detection yet", () => assert.equal(detectSequenceRepeat(["h1", "h2", "h3", "h1", "h2"]), 0));
  test("unrelated prefix before loop — still detects", () => assert.equal(detectSequenceRepeat(["x", "y", "h1", "h2", "h1", "h2"]), 2));

  test("detection fires on the call that completes the repeat", () => {
    const partial = ["h1", "h2", "h3", "h1", "h2"];
    assert.equal(detectSequenceRepeat(partial), 0);
    assert.equal(detectSequenceRepeat([...partial, "h3"]), 3);
  });

  test("tool call loop simulation: blocks before third cycle", () => {
    const history = [];
    const sequence = ["read:/foo", "bash:ls", "read:/bar"];
    let blocked = false;
    let blockAt = null;
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const call of sequence) {
        const candidate = [...history, call];
        const w = detectSequenceRepeat(candidate);
        if (w > 0) { blocked = true; blockAt = call; break; }
        history.push(call);
      }
      if (blocked) break;
    }
    assert.ok(blocked, "loop should be blocked");
    assert.equal(blockAt, sequence[sequence.length - 1]);
  });
});

describe("extractThinking", () => {
  test("returns thinking text", () => {
    assert.equal(
      extractThinking({ role: "assistant", content: [{ type: "thinking", thinking: "my thought" }, { type: "text", text: "response" }] }),
      "my thought"
    );
  });
  test("null when no thinking block", () => {
    assert.equal(extractThinking({ role: "assistant", content: [{ type: "text", text: "response" }] }), null);
  });
  test("null for string content", () => assert.equal(extractThinking({ role: "user", content: "text" }), null));
  test("null for null", () => assert.equal(extractThinking(null), null));
});

describe("replaceThinking", () => {
  test("replaces thinking, leaves other blocks", () => {
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "original" }, { type: "text", text: "response" }] };
    const result = replaceThinking(msg, "truncated [LOOP]");
    assert.equal(result.content[0].thinking, "truncated [LOOP]");
    assert.equal(result.content[1].text, "response");
  });

  test("does not mutate original", () => {
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "original" }] };
    replaceThinking(msg, "new");
    assert.equal(msg.content[0].thinking, "original");
  });

  test("only replaces first thinking block", () => {
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "first" }, { type: "thinking", thinking: "second" }] };
    const result = replaceThinking(msg, "replaced");
    assert.equal(result.content[0].thinking, "replaced");
    assert.equal(result.content[1].thinking, "second");
  });
});

describe("hashToolCall", () => {
  test("same tool + args → same hash", () => {
    assert.equal(hashToolCall("read", { path: "/foo", limit: 100 }), hashToolCall("read", { path: "/foo", limit: 100 }));
  });
  test("different key order → same hash (stable stringify)", () => {
    assert.equal(hashToolCall("read", { limit: 100, path: "/foo" }), hashToolCall("read", { path: "/foo", limit: 100 }));
  });
  test("different tool name → different hash", () => {
    assert.notEqual(hashToolCall("read", { path: "/foo" }), hashToolCall("bash", { path: "/foo" }));
  });
  test("different args → different hash", () => {
    assert.notEqual(hashToolCall("read", { path: "/foo" }), hashToolCall("read", { path: "/bar" }));
  });
  test("nested objects sorted stably", () => {
    assert.equal(hashToolCall("tool", { b: 2, a: { y: 1, x: 0 } }), hashToolCall("tool", { a: { x: 0, y: 1 }, b: 2 }));
  });
  test("null input", () => {
    assert.equal(hashToolCall("tool", null), hashToolCall("tool", null));
  });
  test("array order matters (arrays are not sorted)", () => {
    assert.notEqual(hashToolCall("t", { files: [1, 2] }), hashToolCall("t", { files: [2, 1] }));
  });
  test("array and object with same entries differ", () => {
    assert.notEqual(hashToolCall("t", { a: ["x"] }), hashToolCall("t", { a: { 0: "x" } }));
  });
});

describe("detectSemanticLoop", () => {
  test("all unique paragraphs — no loop", () => {
    assert.equal(detectSemanticLoop([P1, P2, P3, P4].join("\n\n")), null);
  });
  test("paragraph appearing twice — no detection (threshold is 3)", () => {
    assert.equal(detectSemanticLoop([P1, P2, P1, P4].join("\n\n")), null);
  });
  test("paragraph appearing 3 times → detected", () => {
    assert.notEqual(detectSemanticLoop([P1, P2, P1, P3, P1].join("\n\n")), null);
  });
  test("cleanPrefix is everything before the 3rd occurrence", () => {
    const text = [P1, P2, P1, P3, P1].join("\n\n");
    assert.equal(detectSemanticLoop(text).cleanPrefix, [P1, P2, P1, P3].join("\n\n") + "\n\n");
  });
  test("short paragraphs (< PARA_MIN_LEN) are ignored", () => {
    assert.equal(detectSemanticLoop(["OK.", "OK.", "OK.", P1].join("\n\n")), null);
  });
  test("near-identical paragraphs share fingerprint (same first 60 chars)", () => {
    const P1a = "The segfault might be related to the ComboBox widget initialization timing.";
    const P1b = "The segfault might be related to the ComboBox widget initialization timing issues.";
    assert.notEqual(detectSemanticLoop([P1a, P2, P1b, P3, P1a].join("\n\n")), null);
  });
  test("real-world reasoning cycle triggers detection", () => {
    const segments = [
      "Actually, I think the issue might be related to the ComboBox widget. Let me check if there is an issue with the way I am creating the ComboBox.",
      "Wait, I just realized something. The ComboBox is created in the __init__ method, and it is added to the layout. But set_profiles is called later.",
      "Actually, no. The set_profiles method is called in _refresh_profiles, which is called after the UI is fully built. So that should not be an issue.",
      "OK, I am going in circles. Let me just try to run the app again and see if the segfault happens consistently. If it does, I will need to investigate.",
      "Actually, I think the issue might be related to the ComboBox widget. Let me check if there is an issue with the way I am creating the ComboBox.",
      "Wait, I just realized something. The ComboBox is created in the __init__ method, and it is added to the layout. But set_profiles is called later.",
      "Actually, no. The set_profiles method is called in _refresh_profiles, which is called after the UI is fully built. So that should not be an issue.",
      "OK, I am going in circles. Let me just try to run the app again and see if the segfault happens consistently. If it does, I will need to investigate.",
      "Actually, I think the issue might be related to the ComboBox widget. Let me check if there is an issue with the way I am creating the ComboBox.",
    ];
    assert.notEqual(detectSemanticLoop(segments.join("\n\n")), null);
  });
});

describe("jaccard", () => {
  test("identical strings → 1", () => assert.equal(jaccard("hello world", "hello world"), 1));
  test("completely disjoint → 0", () => assert.equal(jaccard("foo bar", "baz qux"), 0));
  test("empty vs empty → 1 (no union)", () => assert.equal(jaccard("", ""), 1));
  test("case insensitive", () => assert.equal(jaccard("Hello World", "hello world"), 1));

  test("50% overlap: {a,b} vs {b,c} → 1/3", () => {
    assert.ok(Math.abs(jaccard("a b", "b c") - 1 / 3) < 0.001);
  });

  test("above 0.85 for near-identical thinking (one word changed)", () => {
    const a = "I need to find where the bug is. Let me check the file structure first.";
    const b = "I need to find where the bug is. Let me check the file structure again.";
    assert.ok(jaccard(a, b) >= 0.85);
  });

  test("below 0.85 for clearly different thinking", () => {
    const a = "The problem is in the database layer, I should check the query execution plan.";
    const b = "Let me try a completely different approach using the REST API endpoint directly.";
    assert.ok(jaccard(a, b) < 0.85);
  });

  test("extra whitespace is ignored", () => {
    assert.equal(jaccard("  hello   world  ", "hello world"), 1);
  });

  test("single shared word out of many → low score", () => {
    // "the" shared, everything else different
    const a = "the quick brown fox jumps over lazy dog";
    const b = "the slow white cat sits under tall tree";
    assert.ok(jaccard(a, b) < 0.3);
  });
});

describe("isReadTool", () => {
  test("read → true", () => assert.ok(isReadTool("read")));
  test("read_file → true", () => assert.ok(isReadTool("read_file")));
  test("view_file → true", () => assert.ok(isReadTool("view_file")));
  test("cat → true", () => assert.ok(isReadTool("cat")));
  test("Read (uppercase) → true", () => assert.ok(isReadTool("Read")));
  test("write_file → false", () => assert.ok(!isReadTool("write_file")));
  test("grep → false", () => assert.ok(!isReadTool("grep")));
  test("bash → false", () => assert.ok(!isReadTool("bash")));
  test("spread → false (read not at word boundary)", () => assert.ok(!isReadTool("spread")));
  test("concatenate → false (cat not at word boundary)", () => assert.ok(!isReadTool("concatenate")));
});

describe("isSearchTool", () => {
  test("grep → true", () => assert.ok(isSearchTool("grep")));
  test("search_files → true", () => assert.ok(isSearchTool("search_files")));
  test("find_files → true", () => assert.ok(isSearchTool("find_files")));
  test("glob → true", () => assert.ok(isSearchTool("glob")));
  test("rg → true", () => assert.ok(isSearchTool("rg")));
  test("Grep (uppercase) → true", () => assert.ok(isSearchTool("Grep")));
  test("read_file → false", () => assert.ok(!isSearchTool("read_file")));
  test("bash → false", () => assert.ok(!isSearchTool("bash")));
  test("write_file → false", () => assert.ok(!isSearchTool("write_file")));
  test("args → false (rg not at word boundary)", () => assert.ok(!isSearchTool("args")));
});

describe("getInputPath", () => {
  test("path field", () => assert.equal(getInputPath({ path: "/foo" }), "/foo"));
  test("file_path field", () => assert.equal(getInputPath({ file_path: "/bar" }), "/bar"));
  test("filename field", () => assert.equal(getInputPath({ filename: "x.ts" }), "x.ts"));
  test("file field", () => assert.equal(getInputPath({ file: "y.py" }), "y.py"));
  test("directory field", () => assert.equal(getInputPath({ directory: "/src" }), "/src"));
  test("dir field", () => assert.equal(getInputPath({ dir: "/lib" }), "/lib"));
  test("path takes precedence over file_path", () => assert.equal(getInputPath({ path: "/a", file_path: "/b" }), "/a"));
  test("empty object → null", () => assert.equal(getInputPath({}), null));
  test("null → null", () => assert.equal(getInputPath(null), null));
  test("string → null", () => assert.equal(getInputPath("not-an-object"), null));
  test("array → null", () => assert.equal(getInputPath(["/foo"]), null));
});

describe("getSearchPattern", () => {
  test("pattern field", () => assert.equal(getSearchPattern({ pattern: "foo" }), "foo"));
  test("query field", () => assert.equal(getSearchPattern({ query: "bar" }), "bar"));
  test("regex field", () => assert.equal(getSearchPattern({ regex: "\\d+" }), "\\d+"));
  test("search field", () => assert.equal(getSearchPattern({ search: "baz" }), "baz"));
  test("term field", () => assert.equal(getSearchPattern({ term: "qux" }), "qux"));
  test("pattern takes precedence over query", () => assert.equal(getSearchPattern({ pattern: "a", query: "b" }), "a"));
  test("empty object → null", () => assert.equal(getSearchPattern({}), null));
  test("null → null", () => assert.equal(getSearchPattern(null), null));
});

describe("getFileReadKey", () => {
  const file = "c:/Proiecte/CSharp/TransportFull/Transport/Transport/ViewModels/CursaExtViewModel.cs";

  test("same path with different line suffixes → different keys", () => {
    const a = getFileReadKey(`${file}:55-114`, {});
    const b = getFileReadKey(`${file}:115-200`, {});
    assert.notEqual(a, b);
    assert.equal(a, `${normalizePath(file)}:55-114`);
    assert.equal(b, `${normalizePath(file)}:115-200`);
  });

  test("offset + limit in input → line range key", () => {
    const key = getFileReadKey(file, { path: file, offset: 55, limit: 60 });
    assert.equal(key, `${normalizePath(file)}:55-114`);
  });

  test("start_line + end_line in input", () => {
    const key = getFileReadKey(file, { path: file, start_line: 115, end_line: 200 });
    assert.equal(key, `${normalizePath(file)}:115-200`);
  });

  test("full file read without line range", () => {
    const key = getFileReadKey(file, { path: file });
    assert.equal(key, normalizePath(file));
  });

  test("same line range read repeatedly shares one counter", () => {
    const counts = new Map();
    const input = { path: `${file}:55-114` };
    const limit = 4;
    for (let i = 1; i <= limit; i++) {
      const { count, blocked } = trackFileRead(counts, input.path, input, limit);
      assert.equal(count, i);
      assert.equal(blocked, i >= limit);
    }
    assert.equal(counts.size, 1);
  });

  test("different line ranges of same file have separate counters", () => {
    const counts = new Map();
    trackFileRead(counts, `${file}:55-114`, {}, 4);
    trackFileRead(counts, `${file}:115-200`, {}, 4);
    assert.equal(counts.size, 2);
  });

  test("path normalization: backslashes and case", () => {
    const a = getFileReadKey("C:\\Foo\\Bar.cs:10-20", {});
    const b = getFileReadKey("c:/foo/bar.cs:10-20", {});
    assert.equal(a, b);
  });
});

describe("isExceptedTool", () => {
  test("wiki-ingest is not excepted by default", () => assert.ok(!isExceptedTool("wiki-ingest")));
  test("wiki-ingest is excepted when configured", () => assert.ok(isExceptedTool("wiki-ingest", ["wiki-ingest"])));
  test("LLM-WIKI is not excepted by default", () => assert.ok(!isExceptedTool("LLM-WIKI")));
  test("case insensitive match when configured", () => assert.ok(isExceptedTool("Wiki-Ingest", ["wiki-ingest"])));
  test("read is not excepted", () => assert.ok(!isExceptedTool("read")));
});

describe("COMMAND_EXCEPTION_LIST sequence tracking", () => {
  const wikiExceptions = ["wiki-ingest"];

  test("repeated excepted tool does not trigger sequence loop", () => {
    const history = [];
    for (let i = 0; i < 6; i++) {
      const result = trackSequenceCall(history, "wiki-ingest", { source: `doc-${i}` }, wikiExceptions);
      assert.ok(!result.blocked);
    }
    assert.equal(history.length, 0);
  });

  test("repeated non-excepted tool still triggers sequence loop", () => {
    const history = [];
    trackSequenceCall(history, "read", { path: "/foo" });
    const result = trackSequenceCall(history, "read", { path: "/foo" });
    assert.ok(result.blocked);
    assert.equal(result.windowSize, 1);
  });

  test("excepted tool between reads does not pollute sequence history", () => {
    const history = [];
    trackSequenceCall(history, "read", { path: "/foo" });
    trackSequenceCall(history, "wiki-ingest", { source: "a" }, wikiExceptions);
    const result = trackSequenceCall(history, "read", { path: "/foo" });
    assert.ok(result.blocked);
    assert.equal(result.windowSize, 1);
  });
});

// response-quality + llama-reload (mirrored from extensions/*.ts)
function deriveAdminBaseUrl(apiBaseUrl) {
  return apiBaseUrl.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
}

function extractAssistantText(message) {
  if (typeof message !== "object" || !message) return "";
  const content = message.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function extractToolCalls(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter((b) => b?.type === "toolCall" || b?.type === "tool_use")
    .map((b) => ({ name: b.name ?? b.toolName ?? "", args: b.arguments ?? b.input ?? b.args ?? {} }));
}

function isValidToolCall(call) {
  if (!call.name.trim()) return false;
  if (call.args == null) return false;
  if (typeof call.args === "string") {
    const t = call.args.trim();
    if (!t) return false;
    try { JSON.parse(t); } catch { return false; }
  }
  return true;
}

function isMalformedResponse(message) {
  const text = extractAssistantText(message);
  const tools = extractToolCalls(message);
  if (!text && tools.length === 0) return true;
  if (tools.length > 0 && tools.every((t) => !isValidToolCall(t))) return true;
  return false;
}

function fingerprintAssistantOutput(message) {
  const text = extractAssistantText(message);
  const tools = extractToolCalls(message);
  const toolPart = tools.map((t) => `${t.name}:${stableStringify(t.args)}`).sort().join("|");
  return `${text}::${toolPart}`;
}

function isIdenticalAcrossPrompts(prev, curr) {
  return prev.assistant.length > 0 && prev.assistant === curr.assistant && prev.user !== curr.user;
}

function shouldCountPersistFailure(message, branch, prev) {
  if (isMalformedResponse(message)) {
    const assistant = fingerprintAssistantOutput(message);
    const userEntry = branch.findLast?.((e) => e?.message?.role === "user");
    const user = userEntry ? JSON.stringify(userEntry.message?.content ?? "") : "";
    return { count: true, reason: "malformed response", curr: { assistant, user } };
  }
  const assistant = fingerprintAssistantOutput(message);
  const users = branch.filter((e) => (e?.message ?? e)?.role === "user");
  const lastUser = users.at(-1);
  if (!lastUser) return { count: false, curr: null };
  const user = JSON.stringify((lastUser.message ?? lastUser).content ?? "");
  const curr = { assistant, user };
  if (prev && isIdenticalAcrossPrompts(prev, curr)) {
    return { count: true, reason: "identical response across prompts", curr };
  }
  return { count: false, curr };
}

// tool-call-text (mirrored from extensions/tool-call-text.ts)
const LEAK_LABEL = "[TEXT TOOL CALL LEAKED — stripped by loop-police]";
const TOOL_CALL_TAG_RE = /<\/?tool_call\b/i;
const FUNCTION_TAG_RE = /<function=[\w-]+/i;
const PARAMETER_TAG_RE = /<parameter=[\w-]+/i;

function findLeakStart(text) {
  const markers = [];
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

function hasTextToolCallLeak(text) {
  if (!text) return false;
  return findLeakStart(text) >= 0;
}

function stripTextToolCallLeak(text) {
  const start = findLeakStart(text);
  if (start < 0) return { cleaned: text, hadLeak: false };
  const prefix = text.slice(0, start).trimEnd();
  const cleaned = prefix ? `${prefix}\n\n${LEAK_LABEL}` : LEAK_LABEL;
  return { cleaned, hadLeak: true };
}

function detectTextToolCallLeak(message) {
  if (extractToolCalls(message).length > 0) return null;
  const text = extractAssistantText(message);
  if (!hasTextToolCallLeak(text)) return null;
  return { text };
}

function replaceLeakedText(message) {
  if (typeof message !== "object" || !message) return message;
  const content = message.content;
  if (!Array.isArray(content)) return message;
  let changed = false;
  const newContent = content.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const { cleaned, hadLeak } = stripTextToolCallLeak(block.text);
    if (!hadLeak) return block;
    changed = true;
    return { ...block, text: cleaned };
  });
  return changed ? { ...message, content: newContent } : message;
}

describe("text tool call leak", () => {
  const leakedXml = [
    "Tabs, not spaces. Let me use exact tab-based content:",
    "",
    "<tool_call>",
    "<function=edit>",
    "<parameter=path>",
    "D:/Proiecte/CSharp/transport/Transport/Forms/frmCursaSearch.xaml.cs",
    "</parameter>",
    "<parameter=edits>",
    '[{"oldText": "foo", "newText": "bar"}]',
    "</parameter>",
    "</function>",
    "</tool_call>",
  ].join("\n");

  test("detects full tool_call XML with function and parameter tags", () => {
    assert.ok(hasTextToolCallLeak(leakedXml));
    assert.ok(detectTextToolCallLeak({ role: "assistant", content: [{ type: "text", text: leakedXml }] }));
  });

  test("detects incomplete tool_call at end of stream", () => {
    const incomplete = "I'll edit the file now.\n\n<tool_call>\n<function=edit>\n<parameter=path>";
    assert.ok(hasTextToolCallLeak(incomplete));
    assert.ok(detectTextToolCallLeak({ role: "assistant", content: [{ type: "text", text: incomplete }] }));
  });

  test("detects function+parameter pair without outer tool_call wrapper", () => {
    const inner = "<function=read>\n<parameter=path>/foo</parameter>\n</function>";
    assert.ok(hasTextToolCallLeak(inner));
  });

  test("does not fire when structured toolCall blocks are present", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: leakedXml },
        { type: "toolCall", name: "edit", arguments: { path: "/foo" } },
      ],
    };
    assert.equal(detectTextToolCallLeak(message), null);
  });

  test("does not fire on normal prose mentioning tool_call", () => {
    const prose = "Models sometimes output a tool_call tag as plain text, which is wrong.";
    assert.ok(!hasTextToolCallLeak(prose));
    assert.equal(detectTextToolCallLeak({ role: "assistant", content: [{ type: "text", text: prose }] }), null);
  });

  test("stripTextToolCallLeak preserves prefix text and adds label", () => {
    const { cleaned, hadLeak } = stripTextToolCallLeak(leakedXml);
    assert.ok(hadLeak);
    assert.ok(cleaned.startsWith("Tabs, not spaces."));
    assert.ok(cleaned.includes(LEAK_LABEL));
    assert.ok(!cleaned.includes("<tool_call>"));
  });

  test("stripTextToolCallLeak on leak-only text yields label only", () => {
    const { cleaned, hadLeak } = stripTextToolCallLeak("<tool_call>\n<function=edit>");
    assert.ok(hadLeak);
    assert.equal(cleaned, LEAK_LABEL);
  });

  test("replaceLeakedText mutates only text blocks", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "planning the edit" },
        { type: "text", text: leakedXml },
      ],
    };
    const cleaned = replaceLeakedText(message);
    assert.notEqual(cleaned, message);
    assert.equal(cleaned.content[0].thinking, "planning the edit");
    assert.ok(cleaned.content[1].text.includes(LEAK_LABEL));
    assert.ok(!cleaned.content[1].text.includes("<tool_call>"));
  });

  test("replaceLeakedText leaves healthy messages unchanged", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "All done." }] };
    assert.equal(replaceLeakedText(message), message);
  });
});

describe("deriveAdminBaseUrl", () => {
  test("strips /v1 suffix", () => assert.equal(deriveAdminBaseUrl("http://localhost:8020/v1"), "http://localhost:8020"));
  test("strips /v1/ suffix", () => assert.equal(deriveAdminBaseUrl("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080"));
  test("no suffix unchanged", () => assert.equal(deriveAdminBaseUrl("http://localhost:8080"), "http://localhost:8080"));
});

describe("isMalformedResponse", () => {
  test("empty message is malformed", () => {
    assert.ok(isMalformedResponse({ role: "assistant", content: [] }));
  });
  test("text only is healthy", () => {
    assert.ok(!isMalformedResponse({ role: "assistant", content: [{ type: "text", text: "hello" }] }));
  });
  test("valid tool call is healthy", () => {
    assert.ok(!isMalformedResponse({
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path: "/foo" } }],
    }));
  });
  test("all invalid tool calls is malformed", () => {
    assert.ok(isMalformedResponse({
      role: "assistant",
      content: [{ type: "toolCall", name: "", arguments: {} }],
    }));
  });
});

describe("isIdenticalAcrossPrompts", () => {
  test("same assistant different user", () => {
    assert.ok(isIdenticalAcrossPrompts(
      { assistant: "a::", user: "u1" },
      { assistant: "a::", user: "u2" }
    ));
  });
  test("different assistant", () => {
    assert.ok(!isIdenticalAcrossPrompts(
      { assistant: "a::", user: "u1" },
      { assistant: "b::", user: "u2" }
    ));
  });
});

describe("persistFailureCount simulation", () => {
  test("threshold triggers after N failures", () => {
    const threshold = 3;
    let count = 0;
    let reloads = 0;
    const record = () => { count++; if (count >= threshold) reloads++; };
    record(); record();
    assert.equal(reloads, 0);
    record();
    assert.equal(reloads, 1);
  });
});

describe("stagnation detection", () => {
  const THRESHOLD = 0.85;
  const WINDOW = 4;

  test("fewer turns than window → no stagnation", () => {
    const t = "I need to find where the bug is. Let me check the file structure and understand.";
    assert.ok(!isStagnant([t, t, t], WINDOW, THRESHOLD));
  });

  test("identical thinking for N turns → stagnation", () => {
    const t = "I need to check the file structure and understand the dependencies before proceeding further with the fix.";
    assert.ok(isStagnant([t, t, t, t], WINDOW, THRESHOLD));
  });

  test("one clearly different turn breaks stagnation", () => {
    const t = "I need to check the file structure and understand the dependencies before proceeding further.";
    const diff = "Let me try a completely different approach and look at the API documentation instead of the source code.";
    assert.ok(!isStagnant([t, t, diff, t], WINDOW, THRESHOLD));
  });

  test("near-identical thinking (minor word change each turn) still stagnates", () => {
    const a = "I need to find where the bug is. Let me check the file structure first and understand the codebase.";
    const b = "I need to find where the bug is. Let me check the file structure again and understand the codebase.";
    const c = "I need to find where the bug is. Let me check the file structure now and understand the codebase.";
    const d = "I need to find where the bug is. Let me check the file structure carefully and understand the codebase.";
    assert.ok(isStagnant([a, b, c, d], WINDOW, THRESHOLD));
  });

  test("stagnation only checks the last WINDOW turns", () => {
    const t = "I need to check the file structure and understand the dependencies before proceeding further.";
    const diff = "Let me try something completely new and approach the problem from a totally different angle.";
    // history: [diff, diff, t, t, t, t] — last 4 are all t → stagnant
    assert.ok(isStagnant([diff, diff, t, t, t, t], WINDOW, THRESHOLD));
  });

  test("clears after stagnation: fresh window is clean", () => {
    const t = "I need to check the file structure and understand the dependencies before proceeding further.";
    const diff = "Let me try something completely new and approach the problem from a totally different angle.";
    // After stagnation is detected and history is cleared, 1 new turn is not stagnant
    assert.ok(!isStagnant([diff], WINDOW, THRESHOLD));
  });
});

describe("setConfigValue", () => {
  test("valid integer assignment mutates and reports", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT=6"), "FILE_READ_LIMIT=6");
    assert.equal(cfg.FILE_READ_LIMIT, 6);
  });

  test("valid float assignment", () => {
    const cfg = { STAGNATION_THRESHOLD: 0.85 };
    assert.equal(setConfigValue(cfg, "STAGNATION_THRESHOLD=0.9"), "STAGNATION_THRESHOLD=0.9");
    assert.equal(cfg.STAGNATION_THRESHOLD, 0.9);
  });

  test("unknown key is rejected without mutation", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "NOPE=3"), "unknown: NOPE");
    assert.deepEqual(cfg, { FILE_READ_LIMIT: 4 });
  });

  test("missing '=' is rejected, echoes the full pair", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    // No '=' → the whole token is echoed, not a truncated key.
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT"), "unknown: FILE_READ_LIMIT");
    assert.equal(cfg.FILE_READ_LIMIT, 4);
  });

  test("leading '=' (empty key) is rejected, echoes the full pair", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "=5"), "unknown: =5");
  });

  test("non-numeric value is rejected, no NaN written", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT=abc"), "invalid: FILE_READ_LIMIT=abc");
    assert.equal(cfg.FILE_READ_LIMIT, 4);
  });

  test("trailing garbage is rejected (Number, not parseFloat)", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT=3px"), "invalid: FILE_READ_LIMIT=3px");
    assert.equal(cfg.FILE_READ_LIMIT, 4);
  });

  test("empty value is rejected", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT="), "invalid: FILE_READ_LIMIT=");
    assert.equal(cfg.FILE_READ_LIMIT, 4);
  });

  test("Infinity is rejected as non-finite", () => {
    const cfg = { FILE_READ_LIMIT: 4 };
    assert.equal(setConfigValue(cfg, "FILE_READ_LIMIT=Infinity"), "invalid: FILE_READ_LIMIT=Infinity");
    assert.equal(cfg.FILE_READ_LIMIT, 4);
  });

  test("negative and zero values are allowed (finite numbers)", () => {
    const cfg = { CHECK_STRIDE: 50 };
    assert.equal(setConfigValue(cfg, "CHECK_STRIDE=0"), "CHECK_STRIDE=0");
    assert.equal(cfg.CHECK_STRIDE, 0);
  });

  test("string (message) keys are not settable, left unchanged", () => {
    const cfg = { MSG_TOOL_LOOP: "loop!" };
    assert.equal(
      setConfigValue(cfg, "MSG_TOOL_LOOP=5"),
      "not settable: MSG_TOOL_LOOP (edit loop-police.json)"
    );
    assert.equal(cfg.MSG_TOOL_LOOP, "loop!");
  });
});

describe("migrateToolLoopBan (pre-1.5.0 config migration)", () => {
  test("old temporary (0) → new temporary (1)", () => {
    assert.equal(migrateToolLoopBan({ TOOL_LOOP_BAN: 0 }), 1);
  });

  test("old permanent (1) → new permanent (2)", () => {
    assert.equal(migrateToolLoopBan({ TOOL_LOOP_BAN: 1 }), 2);
  });

  test("stamped file (any CONFIG_VERSION) is never migrated", () => {
    assert.equal(migrateToolLoopBan({ CONFIG_VERSION: 2, TOOL_LOOP_BAN: 0 }), null);
    assert.equal(migrateToolLoopBan({ CONFIG_VERSION: 1, TOOL_LOOP_BAN: 1 }), null);
  });

  test("missing TOOL_LOOP_BAN → no migration (new default applies)", () => {
    assert.equal(migrateToolLoopBan({ FILE_READ_LIMIT: 6 }), null);
  });

  test("missing/corrupt file (null) → no migration", () => {
    assert.equal(migrateToolLoopBan(null), null);
  });

  test("values outside the old scale are left alone", () => {
    assert.equal(migrateToolLoopBan({ TOOL_LOOP_BAN: 2 }), null);
    assert.equal(migrateToolLoopBan({ TOOL_LOOP_BAN: "1" }), null);
  });
});

describe("fmt (message template interpolation)", () => {
  test("fills a single placeholder", () => {
    assert.equal(fmt("read {count} times", { count: 4 }), "read 4 times");
  });

  test("fills multiple distinct placeholders", () => {
    assert.equal(
      fmt('"{path}" read {count}x', { path: "/a", count: 3 }),
      '"/a" read 3x',
    );
  });

  test("same placeholder repeated is filled each time", () => {
    assert.equal(fmt("{count}/{count}", { count: 2 }), "2/2");
  });

  test("unknown placeholder is left verbatim (visible typo)", () => {
    assert.equal(fmt("hi {nope}", { count: 1 }), "hi {nope}");
  });

  test("no placeholders → returned unchanged", () => {
    assert.equal(fmt("plain message", { count: 1 }), "plain message");
  });

  test("coerces non-string template to string", () => {
    assert.equal(fmt(42, {}), "42");
  });

  test("string values interpolate too", () => {
    assert.equal(fmt("pattern {pattern}", { pattern: "GL" }), "pattern GL");
  });
});
