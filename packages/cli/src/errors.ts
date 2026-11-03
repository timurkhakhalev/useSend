/**
 * Process exit codes. These are part of the CLI contract — agents branch on
 * them — so never renumber an existing code.
 */
export const ExitCode = {
  OK: 0,
  /** Unexpected failure or a 5xx response from the server. */
  GENERAL: 1,
  /** Bad flags/arguments, unreadable input file, invalid JSON passed in. */
  USAGE: 2,
  /** Missing API key, or the server answered 401/403. */
  AUTH: 3,
  /** The server answered 404. */
  NOT_FOUND: 4,
  /** The server rejected the payload (400/409/422). */
  VALIDATION: 5,
  /** The server answered 429. */
  RATE_LIMITED: 6,
  /** DNS/TCP/TLS failure or timeout — the server was not reached. */
  NETWORK: 7,
  /** A destructive or mass action was attempted without --yes. */
  CONFIRMATION_REQUIRED: 8,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: ExitCodeValue,
    public readonly hint?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function usageError(message: string, hint?: string) {
  return new CliError("USAGE", message, ExitCode.USAGE, hint);
}

export function exitCodeForStatus(status: number): ExitCodeValue {
  if (status === 401 || status === 403) return ExitCode.AUTH;
  if (status === 404) return ExitCode.NOT_FOUND;
  if (status === 429) return ExitCode.RATE_LIMITED;
  if (status >= 400 && status < 500) return ExitCode.VALIDATION;
  return ExitCode.GENERAL;
}

export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 405:
      return "METHOD_NOT_ALLOWED";
    case 409:
      return "NOT_UNIQUE";
    case 422:
      return "UNPROCESSABLE_ENTITY";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "INTERNAL_SERVER_ERROR" : `HTTP_${status}`;
  }
}

export function hintForStatus(status: number): string | undefined {
  switch (status) {
    case 401:
      return "The API key is missing or invalid. Run `usesend auth login` or check USESEND_API_KEY.";
    case 403:
      return "The API key is valid but not allowed here (e.g. key restricted to another domain, or unverified sending domain).";
    case 404:
      return "Check the id. List resources first, e.g. `usesend domains list`.";
    case 429:
      return "Rate limited. Wait the Retry-After seconds and retry; batch sends count as one request.";
    default:
      return status >= 500
        ? "Server error. Retry later; check `usesend doctor`."
        : undefined;
  }
}
