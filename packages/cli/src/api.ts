import { UseSend } from "usesend-js";
import {
  CliError,
  ExitCode,
  codeForStatus,
  exitCodeForStatus,
  hintForStatus,
} from "./errors";

export type FetchLike = typeof fetch;

export type RequestOptions = {
  query?: Record<
    string,
    string | number | boolean | Array<string | number> | undefined
  >;
  body?: unknown;
  headers?: Record<string, string>;
  /** Do not send the Authorization header (e.g. /api/health). */
  noAuth?: boolean;
  /** Path is relative to the base URL instead of /api/v1. */
  raw?: boolean;
};

export const USER_AGENT = "usesend-cli";

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: RequestOptions["query"],
  raw = false,
): string {
  const url = new URL(`${baseUrl}${raw ? "" : "/api/v1"}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === "") continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

/** Turn any error body the public API produces into a readable message. */
export function extractErrorMessage(body: unknown): {
  code?: string;
  message?: string;
} {
  if (!body || typeof body !== "object") {
    return typeof body === "string" && body.trim()
      ? { message: body.trim().slice(0, 500) }
      : {};
  }
  const b = body as Record<string, unknown>;
  const err = b.error;
  // { error: { code, message } } — UnsendApiError
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    // zod-openapi validation failure: { success: false, error: { issues: [...] } }
    if (Array.isArray(e.issues)) {
      const issues = (e.issues as Array<Record<string, unknown>>)
        .map((i) => {
          const p =
            Array.isArray(i.path) && i.path.length
              ? `${i.path.join(".")}: `
              : "";
          return `${p}${String(i.message ?? "invalid")}`;
        })
        .join("; ");
      return {
        code: "VALIDATION_ERROR",
        message: issues || "Request validation failed",
      };
    }
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
    };
  }
  // { error: "Domain not found" }
  if (typeof err === "string") return { message: err };
  if (typeof b.message === "string") return { message: b.message };
  return {};
}

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async request<T = unknown>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    if (!opts.noAuth && !this.apiKey) {
      throw new CliError(
        "NO_API_KEY",
        "No API key configured",
        ExitCode.AUTH,
        "Run `usesend auth login` (key via stdin or prompt), or set USESEND_API_KEY.",
      );
    }
    const url = buildUrl(this.baseUrl, path, opts.query, opts.raw);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...opts.headers,
    };
    if (!opts.noAuth) headers.Authorization = `Bearer ${this.apiKey}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    // Use the SDK transport; this wrapper preserves HTTP status and Retry-After
    // for CLI exit codes before the SDK turns errors into response objects.
    const checkedFetch: FetchLike = async (input, init) => {
      let res: Response;
      try {
        res = await this.fetchImpl(input, init);
      } catch (err) {
        const e = err as Error & {
          cause?: { code?: string; message?: string };
        };
        const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
        const detail = e.cause?.code ?? e.cause?.message ?? e.message;
        throw new CliError(
          timedOut ? "TIMEOUT" : "NETWORK_ERROR",
          timedOut
            ? `Request to ${new URL(url).origin} timed out after ${this.timeoutMs}ms`
            : `Could not reach ${new URL(url).origin}: ${detail}`,
          ExitCode.NETWORK,
          "Check --base-url / USESEND_BASE_URL and connectivity; `usesend doctor` runs the checks.",
        );
      }
      if (res.ok) return res;
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* non-JSON server error */
      }
      const { code, message } = extractErrorMessage(parsed);
      let hint = hintForStatus(res.status);
      const retryAfter = res.headers.get("retry-after");
      if (res.status === 429 && retryAfter)
        hint = `Rate limited. Retry after ${retryAfter}s.`;
      throw new CliError(
        code ?? codeForStatus(res.status),
        message || `${res.status} ${res.statusText}`.trim(),
        exitCodeForStatus(res.status),
        hint,
        { status: res.status },
      );
    };
    const init: RequestInit = {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    try {
      if (opts.noAuth)
        return (await (await checkedFetch(url, init)).json()) as T;
      const sdk = new UseSend(this.apiKey, this.baseUrl, {
        fetch: checkedFetch,
      });
      const relativePath = url.slice(`${this.baseUrl}/api/v1`.length);
      const result = await sdk.fetchRequest<T>(relativePath, init);
      return result.data as T;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new CliError(
          "INVALID_RESPONSE",
          `Expected JSON from ${new URL(url).origin}`,
          ExitCode.GENERAL,
          "Is the base URL pointing at a useSend instance?",
        );
      }
      throw err;
    }
  }

  get<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("GET", path, opts);
  }
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("POST", path, { ...opts, body: body ?? {} });
  }
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("PUT", path, { ...opts, body: body ?? {} });
  }
  patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("PATCH", path, { ...opts, body: body ?? {} });
  }
  delete<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("DELETE", path, { ...opts, body });
  }
}
