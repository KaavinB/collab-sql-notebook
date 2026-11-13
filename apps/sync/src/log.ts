/**
 * One-line logs: an event name plus a few fields (notebook id, user id,
 * close code, error message). Never pass tickets, awareness states or
 * document content here: logs are read by more people than the documents.
 */

export type LogFields = Record<string, string | number | boolean | null | undefined>;

let quiet = false;

/** Tests turn routine logs and warnings off; errors still print. */
export function setQuiet(value: boolean): void {
  quiet = value;
}

function format(event: string, fields: LogFields): string {
  const parts = [`[sync] ${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) parts.push(`${key}=${String(value)}`);
  }
  return parts.join(" ");
}

export const log = {
  info(event: string, fields: LogFields = {}): void {
    if (!quiet) console.log(format(event, fields));
  },
  warn(event: string, fields: LogFields = {}): void {
    if (!quiet) console.warn(format(event, fields));
  },
  error(event: string, fields: LogFields = {}): void {
    console.error(format(event, fields));
  },
};

/** An error's message, without its stack or any attached data. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
