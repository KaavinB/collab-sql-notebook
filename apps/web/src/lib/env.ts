/**
 * Validates the API base URL. NEXT_PUBLIC_* variables are inlined into the
 * browser bundle at build time, so a bad value should fail loudly, not as a
 * confusing fetch error later.
 */
export function parseApiBaseUrl(raw: string | undefined): string {
  if (!raw) {
    throw new Error("NEXT_PUBLIC_API_URL is not set (see .env.example)");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`NEXT_PUBLIC_API_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`NEXT_PUBLIC_API_URL must be http(s): ${raw}`);
  }
  // The value is shipped in the browser bundle and used as a prefix for paths,
  // so credentials, a query string or a fragment are always a mistake.
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("NEXT_PUBLIC_API_URL must not contain credentials, a query or a fragment");
  }
  // Drop any trailing slash so callers can always write `${base}/path`.
  return url.toString().replace(/\/$/, "");
}

/** Reads it lazily. It must be accessed as a literal property so Next can inline it. */
export function apiBaseUrl(): string {
  return parseApiBaseUrl(process.env.NEXT_PUBLIC_API_URL);
}
