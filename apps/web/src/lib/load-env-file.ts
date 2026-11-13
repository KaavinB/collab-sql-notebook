import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Loads KEY=value pairs from an env file into `env`, without overriding
 * variables that are already set (so the real environment, e.g. CI or Vercel,
 * always wins). A missing file is not an error: production has no .env.
 * Returns the names of the variables it set.
 */
export function loadEnvFile(
  filePath: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!existsSync(filePath)) return [];
  const parsed = parseEnv(readFileSync(filePath, "utf8"));
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined && value !== undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
