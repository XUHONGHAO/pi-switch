import type { ProviderConfig } from "../config/loader";
import { modelsEndpoint, resolveApiKey } from "./openai";
import { resolveConfigValue, resolveHeaderValues } from "../config/secret";

export interface ProbeResult {
  provider: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  modelCount?: number;
  error?: string;
}

/**
 * Lightweight reachability probe. `/models` is standardized only for OpenAI
 * compatible endpoints; native providers may return 404 even while request
 * streaming is correctly configured.
 */
export async function probeProvider(
  name: string,
  provider: ProviderConfig,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const key = await resolveConfigValue(resolveApiKey(provider, name));
    const headers: Record<string, string> = { Accept: "application/json", ...await resolveHeaderValues(provider.headers) };
    if (key) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(modelsEndpoint(provider.baseUrl), { method: "GET", headers, signal });
    let modelCount: number | undefined;
    if (response.ok) {
      const payload = await response.json().catch(() => undefined) as { data?: unknown[] } | undefined;
      if (Array.isArray(payload?.data)) modelCount = payload.data.length;
    }
    return {
      provider: name,
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      ...(modelCount !== undefined ? { modelCount } : {}),
      ...(!response.ok ? { error: `${response.status} ${response.statusText}` } : {}),
    };
  } catch (err) {
    return { provider: name, ok: false, latencyMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
  }
}
