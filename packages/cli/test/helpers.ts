import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { vi } from "vitest";
import { run } from "../src/cli";
import type { Stdin } from "../src/context";

export type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
};

export type Route = (
  call: Call,
) =>
  { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

export function mockFetch(route: Route) {
  const calls: Call[] = [];
  const fn = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const call: Call = {
        method: init?.method ?? "GET",
        url: String(input),
        headers,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const r = route(call);
      if (r instanceof Error) throw r;
      return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json", ...r.headers },
      });
    },
  );
  return { fetch: fn as unknown as typeof fetch, calls };
}

export function tmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usesend-cli-test-"));
  return path.join(dir, "cli.json");
}

export async function cli(
  argv: string[],
  opts: {
    env?: Record<string, string | undefined>;
    fetch?: typeof fetch;
    stdin?: string;
    tty?: boolean;
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const stdin = Readable.from(
    opts.stdin !== undefined ? [opts.stdin] : [],
  ) as unknown as Stdin;
  stdin.isTTY = opts.tty ?? false;
  const code = await run(argv, {
    env: { USESEND_CONFIG: tmpConfig(), ...opts.env },
    fetch:
      opts.fetch ?? mockFetch(() => new Error("no network in tests")).fetch,
    stdin,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    promptSecret: async () => "us_prompted_secretsecret",
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

export const KEY = "us_abc123_supersecrettokenvalue9876";
export const BASE = "https://mail.example.test";
export const ENV = { USESEND_API_KEY: KEY, USESEND_BASE_URL: BASE };
