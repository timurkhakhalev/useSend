import { describe, expect, it } from "vitest";
import { BASE, ENV, KEY, cli, mockFetch } from "./helpers";

async function withStatus(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  const { fetch } = mockFetch(() => ({ status, body, headers }));
  return cli(["domains", "list", "--json"], { env: ENV, fetch });
}

describe("exit codes and error mapping", () => {
  it("0 on success, with auth header and /api/v1 prefix", async () => {
    const { fetch, calls } = mockFetch(() => ({
      body: [{ id: 1, name: "a.com", status: "SUCCESS" }],
    }));
    const r = await cli(["domains", "list", "--json"], { env: ENV, fetch });
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      ok: true,
      data: [{ id: 1, name: "a.com", status: "SUCCESS" }],
    });
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/domains`);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("3 on 401 and 403", async () => {
    const r = await withStatus(401, {
      error: { code: "UNAUTHORIZED", message: "Invalid API token" },
    });
    expect(r.code).toBe(3);
    expect(r.json().error).toMatchObject({
      code: "UNAUTHORIZED",
      message: "Invalid API token",
    });
    expect(
      (await withStatus(403, { error: { code: "FORBIDDEN", message: "x" } }))
        .code,
    ).toBe(3);
  });

  it("3 when no key is configured, without calling the API", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: [] }));
    const r = await cli(["domains", "list", "--json"], { env: {}, fetch });
    expect(r.code).toBe(3);
    expect(r.json().error.code).toBe("NO_API_KEY");
    expect(calls).toHaveLength(0);
  });

  it("4 on 404, including the {error: string} body shape", async () => {
    const r = await withStatus(404, { error: "Domain not found" });
    expect(r.code).toBe(4);
    expect(r.json().error).toMatchObject({
      code: "NOT_FOUND",
      message: "Domain not found",
    });
  });

  it("5 on zod validation errors with readable issues", async () => {
    const r = await withStatus(400, {
      success: false,
      error: {
        name: "ZodError",
        issues: [{ path: ["to"], message: "Required" }],
      },
    });
    expect(r.code).toBe(5);
    expect(r.json().error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "to: Required",
    });
  });

  it("5 on 409 NOT_UNIQUE", async () => {
    expect(
      (await withStatus(409, { error: { code: "NOT_UNIQUE", message: "dup" } }))
        .code,
    ).toBe(5);
  });

  it("6 on 429 with a Retry-After hint", async () => {
    const r = await withStatus(
      429,
      { error: { code: "RATE_LIMITED", message: "slow down" } },
      { "retry-after": "2" },
    );
    expect(r.code).toBe(6);
    expect(r.json().error.hint).toContain("2s");
  });

  it("1 on 500", async () => {
    expect(
      (
        await withStatus(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "x" },
        })
      ).code,
    ).toBe(1);
  });

  it("7 on network failure", async () => {
    const { fetch } = mockFetch(() =>
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      }),
    );
    const r = await cli(["domains", "list", "--json"], { env: ENV, fetch });
    expect(r.code).toBe(7);
    expect(r.json().error).toMatchObject({ code: "NETWORK_ERROR" });
    expect(r.json().error.message).toContain("ECONNREFUSED");
  });

  it("2 on usage errors (unknown command, missing option, bad JSON)", async () => {
    expect((await cli(["nope", "--json"])).code).toBe(2);
    const missing = await cli(["emails", "update", "id1", "--json"], {
      env: ENV,
    });
    expect(missing.code).toBe(2);
    expect(missing.json().error.code).toBe("USAGE");
    const badJson = await cli(
      [
        "emails",
        "send",
        "--to",
        "a@b.c",
        "--from",
        "x@y.z",
        "--template-id",
        "t",
        "--variables",
        "{nope",
        "--json",
      ],
      { env: ENV },
    );
    expect(badJson.code).toBe(2);
    expect(badJson.json().error.message).toContain("--variables");
  });

  it("does not leak the API key in error output", async () => {
    const r = await withStatus(401, {
      error: { code: "UNAUTHORIZED", message: "bad" },
    });
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });
});
