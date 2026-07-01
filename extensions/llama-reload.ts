// Minimal llama-server admin client for model reload (no pi-llama-cpp dependency).

export type ServerMode = "router" | "single" | "legacy" | "unknown";

export interface LlamaAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface ReloadResult {
  ok: boolean;
  mode: ServerMode;
  message: string;
}

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;

export function deriveAdminBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
}

function buildHeaders(auth?: LlamaAuth): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(auth?.headers ?? {}),
  };
  if (auth?.apiKey && !headers.Authorization) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  return headers;
}

async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = HEALTH_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url: string, body: unknown, auth?: LlamaAuth): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(auth),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
}

export async function probeLlamaServer(adminBase: string, auth?: LlamaAuth): Promise<boolean> {
  try {
    const health = await fetchJson<{ status?: string }>(`${adminBase}/health`, {
      headers: buildHeaders(auth),
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
    return health.status === "ok" || health.status === "healthy";
  } catch {
    return false;
  }
}

export async function detectServerMode(adminBase: string, auth?: LlamaAuth): Promise<ServerMode> {
  try {
    const props = await fetchJson<{ role?: string }>(`${adminBase}/props?autoload=false`, {
      headers: buildHeaders(auth),
    });
    if (props.role === "router") return "router";
  } catch {
    // fall through
  }

  try {
    const models = await fetchJson<{ data?: Array<Record<string, unknown>> }>(
      `${adminBase}/v1/models`,
      { headers: buildHeaders(auth) }
    );
    const first = models.data?.[0];
    if (first && "max_model_len" in first) return "legacy";
    if (first) return "single";
  } catch {
    // fall through
  }

  return "unknown";
}

async function isModelLoaded(adminBase: string, modelId: string, auth?: LlamaAuth): Promise<boolean> {
  try {
    const props = await fetchJson<{ error?: { code?: number; message?: string }; is_sleeping?: boolean }>(
      `${adminBase}/props?model=${encodeURIComponent(modelId)}`,
      { headers: buildHeaders(auth) }
    );
    if (props.is_sleeping) return true;
    if (!props.error) return true;
    if (props.error.code === 503) return false;
    if (props.error.code === 400 && props.error.message === "model is not loaded") return false;
    return false;
  } catch {
    return false;
  }
}

export async function pollUntilLoaded(
  adminBase: string,
  modelId: string,
  auth?: LlamaAuth,
  timeoutMs = POLL_TIMEOUT_MS
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isModelLoaded(adminBase, modelId, auth)) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Model load timed out after ${timeoutMs}ms: ${modelId}`);
}

export async function tryEraseSlots(adminBase: string, auth?: LlamaAuth): Promise<boolean> {
  for (let slot = 0; slot < 8; slot++) {
    try {
      const res = await fetch(`${adminBase}/slots/${slot}?action=erase`, {
        method: "POST",
        headers: buildHeaders(auth),
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (res.ok) return true;
    } catch {
      // try next slot
    }
  }
  return false;
}

async function resolveModelId(adminBase: string, modelId: string, auth?: LlamaAuth): Promise<string> {
  try {
    const models = await fetchJson<{ data?: Array<{ id: string }> }>(`${adminBase}/v1/models`, {
      headers: buildHeaders(auth),
    });
    if (models.data?.length === 1) return models.data[0].id;
    const match = models.data?.find((m) => m.id === modelId);
    if (match) return match.id;
  } catch {
    // use provided id
  }
  return modelId;
}

export async function reloadModel(
  adminBase: string,
  modelId: string,
  mode: ServerMode,
  auth?: LlamaAuth
): Promise<ReloadResult> {
  const resolvedId = await resolveModelId(adminBase, modelId, auth);

  if (mode === "router") {
    try {
      await postJson(`${adminBase}/models/unload`, { model: resolvedId }, auth);
    } catch {
      // best-effort unload
    }
    await postJson(`${adminBase}/models/load`, { model: resolvedId }, auth);
    await pollUntilLoaded(adminBase, resolvedId, auth);
    return { ok: true, mode, message: `Router reload completed for ${resolvedId}` };
  }

  if (mode === "single" || mode === "legacy" || mode === "unknown") {
    try {
      await postJson(`${adminBase}/models/load`, { model: resolvedId }, auth);
      await pollUntilLoaded(adminBase, resolvedId, auth);
      return { ok: true, mode, message: `Model reload completed for ${resolvedId}` };
    } catch (loadErr) {
      const erased = await tryEraseSlots(adminBase, auth);
      if (erased) {
        return {
          ok: true,
          mode,
          message: `Slot cache erased (load API unavailable: ${loadErr instanceof Error ? loadErr.message : loadErr})`,
        };
      }
      return {
        ok: false,
        mode,
        message: `Reload not supported: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`,
      };
    }
  }

  return { ok: false, mode, message: "Unknown server mode" };
}

export async function attemptModelReload(
  apiBaseUrl: string,
  modelId: string,
  auth?: LlamaAuth
): Promise<ReloadResult> {
  const adminBase = deriveAdminBaseUrl(apiBaseUrl);
  const healthy = await probeLlamaServer(adminBase, auth);
  if (!healthy) {
    return {
      ok: false,
      mode: "unknown",
      message: `llama-server not reachable at ${adminBase}`,
    };
  }

  const mode = await detectServerMode(adminBase, auth);
  return reloadModel(adminBase, modelId, mode, auth);
}
