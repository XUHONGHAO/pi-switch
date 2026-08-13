import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolveEnvRef } from "../provider/openai";

const execAsync = promisify(exec);

/** Resolve pi config-value syntax for account-pool secrets and headers. */
export async function resolveConfigValue(raw: string | undefined): Promise<string | undefined> {
  if (!raw) return undefined;
  if (raw.startsWith("$!")) return resolveEnvRef(raw);
  if (!raw.startsWith("!")) {
    const value = resolveEnvRef(raw);
    return value || undefined;
  }
  const command = raw.slice(1).trim();
  if (!command) return undefined;
  const { stdout } = await execAsync(command, {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim() || undefined;
}

export async function resolveHeaderValues(headers: Record<string, string> | undefined): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const result = await resolveConfigValue(value);
    if (result !== undefined) resolved[name] = result;
  }
  return resolved;
}
