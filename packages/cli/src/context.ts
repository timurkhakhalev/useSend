import fs from "node:fs";
import type { Command } from "commander";
import { ApiClient, type FetchLike } from "./api";
import { resolveSettings, type Env, type ResolvedSettings } from "./config";
import { CliError, ExitCode, usageError } from "./errors";
import { Output } from "./output";

export type Stdin = NodeJS.ReadableStream & { isTTY?: boolean };

export type Deps = {
  env: Env;
  fetch: FetchLike;
  stdin: Stdin;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Prompt for a secret without echo (TTY only). Injected for tests. */
  promptSecret?: (question: string) => Promise<string>;
};

export type GlobalOpts = {
  json?: boolean;
  apiKey?: string;
  baseUrl?: string;
  profile?: string;
  timeout?: string;
};

export class Context {
  out: Output;
  constructor(
    public readonly deps: Deps,
    json: boolean,
  ) {
    this.out = new Output(json, deps.stdout, deps.stderr);
  }

  get env() {
    return this.deps.env;
  }

  settings(opts: GlobalOpts): ResolvedSettings {
    return resolveSettings(
      { apiKey: opts.apiKey, baseUrl: opts.baseUrl, profile: opts.profile },
      this.deps.env,
    );
  }

  client(opts: GlobalOpts): ApiClient {
    const s = this.settings(opts);
    return new ApiClient(s.baseUrl, s.apiKey, this.deps.fetch, timeoutMs(opts));
  }

  async readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.deps.stdin) {
      chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
      );
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Read a file path, or stdin when path is "-". */
  async readText(path: string, what = "file"): Promise<string> {
    if (path === "-") return this.readStdin();
    try {
      return fs.readFileSync(path, "utf8");
    } catch (err) {
      throw usageError(
        `Cannot read ${what} ${path}: ${(err as Error).message}`,
      );
    }
  }

  async readJson<T = unknown>(path: string, what = "JSON file"): Promise<T> {
    const text = await this.readText(path, what);
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw usageError(
        `${what} ${path === "-" ? "(stdin)" : path} is not valid JSON: ${(err as Error).message}`,
      );
    }
  }
}

export function timeoutMs(opts: GlobalOpts): number {
  if (!opts.timeout) return 30_000;
  const n = Number(opts.timeout);
  if (!Number.isFinite(n) || n <= 0)
    throw usageError("--timeout must be a positive number of seconds");
  return Math.round(n * 1000);
}

/** Retrieve merged global + local options from the last action argument. */
export function optsOf<T extends object>(cmd: Command): T & GlobalOpts {
  return cmd.optsWithGlobals() as T & GlobalOpts;
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Flatten repeatable, comma-separated values: --to a,b --to c → [a,b,c] */
export function flatList(
  values: string[] | string | undefined,
): string[] | undefined {
  if (values === undefined) return undefined;
  const arr = (Array.isArray(values) ? values : [values])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return arr.length ? arr : undefined;
}

/** A single value when there's one, an array when there are several. */
export function oneOrMany(
  values: string[] | undefined,
): string | string[] | undefined {
  if (!values) return undefined;
  return values.length === 1 ? values[0] : values;
}

export function parseJsonOption<T = unknown>(
  flag: string,
  value: string | undefined,
): T | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    throw usageError(
      `${flag} must be valid JSON: ${(err as Error).message}`,
      `Example: ${flag} '{"name":"Ada"}'`,
    );
  }
}

export function parseStringRecord(
  flag: string,
  value: string | undefined,
): Record<string, string> | undefined {
  const parsed = parseJsonOption<unknown>(flag, value);
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError(`${flag} must be a JSON object of string values`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export function parseIntOption(
  flag: string,
  value: string | undefined,
  min = 1,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min)
    throw usageError(`${flag} must be an integer >= ${min}`);
  return n;
}

/**
 * Guard for destructive or mass actions. Without --yes we describe the
 * action and fail with CONFIRMATION_REQUIRED (exit 8) — nothing is sent.
 */
export function requireYes(
  opts: { yes?: boolean },
  action: string,
  details: unknown,
) {
  if (opts.yes) return;
  throw new CliError(
    "CONFIRMATION_REQUIRED",
    `${action} — refusing without --yes`,
    ExitCode.CONFIRMATION_REQUIRED,
    "Re-run with --yes to proceed (or --dry-run to preview the request).",
    details,
  );
}

export type PlannedRequest = {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};

/** Truncate attachment contents etc. so dry-run output stays readable. */
export function redactForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForDisplay);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "attachments" && Array.isArray(v)) {
        out[k] = v.map((a: { filename?: string; content?: string }) => ({
          filename: a.filename,
          content: `<base64, ${a.content?.length ?? 0} chars>`,
        }));
      } else if (
        (k === "html" || k === "content") &&
        typeof v === "string" &&
        v.length > 200
      ) {
        out[k] = `${v.slice(0, 200)}… (${v.length} chars)`;
      } else {
        out[k] = redactForDisplay(v);
      }
    }
    return out;
  }
  return value;
}

export function printDryRun(ctx: Context, req: PlannedRequest) {
  const data = {
    dryRun: true,
    request: { ...req, body: redactForDisplay(req.body) },
  };
  ctx.out.result(data, () => {
    const lines = [`[dry-run] ${req.method} /api/v1${req.path}`];
    if (req.headers && Object.keys(req.headers).length)
      lines.push(...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`));
    if (req.body !== undefined)
      lines.push(JSON.stringify(data.request.body, null, 2));
    lines.push("Nothing was sent.");
    return lines.join("\n");
  });
}
