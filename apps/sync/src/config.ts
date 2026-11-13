/**
 * Settings, read once from the environment at startup.
 *
 * `pnpm dev:sync` loads the repo-root .env; the server never reads .env files
 * itself. A missing or weak secret stops the server at startup instead of
 * letting it run in a state where anyone could forge a ticket.
 */

export interface Config {
  host: string;
  port: number;
  /** HMAC key for sync tickets, shared with the API and nothing else. */
  ticketSecret: Buffer;
  /** Browser origins allowed to open a socket (exact match, scheme://host[:port]). */
  allowedOrigins: ReadonlySet<string>;
  /** A connection string `pg` understands (postgresql://...). */
  databaseUrl: string;
}

// The API refuses shorter secrets too; 32 characters is 128+ bits of
// randomness for a hex secret from `openssl rand -hex 32` (which gives 64).
const MIN_SECRET_LENGTH = 32;

export class ConfigError extends Error {}

/**
 * The API uses SQLAlchemy URLs, which name the driver
 * (postgresql+psycopg://...). `pg` wants the plain scheme.
 */
export function toPgUrl(databaseUrl: string): string {
  const match = /^postgres(?:ql)?(?:\+[a-z0-9_]+)?:\/\//i.exec(databaseUrl);
  if (!match) throw new ConfigError("DATABASE_URL must be a postgresql:// URL");
  return `postgresql://${databaseUrl.slice(match[0].length)}`;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 8020;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError("SYNC_PORT must be an integer from 0 to 65535");
  }
  return port;
}

function parseOrigins(value: string | undefined): Set<string> {
  const raw = value === undefined || value.trim() === "" ? "http://localhost:3000" : value;
  const origins = new Set<string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new ConfigError(`SYNC_ALLOWED_ORIGINS has an invalid origin: ${trimmed}`);
    }
    // Browsers send the serialized origin (no path, no trailing slash), so
    // compare against the same form.
    if (url.origin === "null" || url.origin !== trimmed.replace(/\/$/, "")) {
      throw new ConfigError(`SYNC_ALLOWED_ORIGINS entries must be bare origins: ${trimmed}`);
    }
    origins.add(url.origin);
  }
  return origins;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.SYNC_TICKET_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(
      `SYNC_TICKET_SECRET must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -hex 32)`,
    );
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError("DATABASE_URL is not set (see .env.example)");
  return {
    host: env.SYNC_HOST || "127.0.0.1",
    port: parsePort(env.SYNC_PORT),
    ticketSecret: Buffer.from(secret, "utf8"),
    allowedOrigins: parseOrigins(env.SYNC_ALLOWED_ORIGINS),
    databaseUrl: toPgUrl(databaseUrl),
  };
}
