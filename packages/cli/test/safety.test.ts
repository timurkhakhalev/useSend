import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV, cli, mockFetch } from "./helpers";

const domain = {
  id: 7,
  name: "mail.acme.com",
  status: "SUCCESS",
  region: "us-east-1",
  dnsRecords: [],
};

function api() {
  return mockFetch((c) => {
    if (c.method === "GET" && c.url.endsWith("/domains/7"))
      return { body: domain };
    if (c.method === "GET" && c.url.endsWith("/domains"))
      return { body: [domain] };
    if (c.method === "DELETE")
      return {
        body: { id: 7, success: true, message: "Domain deleted successfully" },
      };
    if (c.method === "GET" && c.url.includes("/campaigns/"))
      return {
        body: {
          id: "c1",
          name: "Launch",
          status: "DRAFT",
          contactBookId: "b1",
        },
      };
    if (c.method === "POST")
      return { body: { success: true, data: [{ emailId: "e1" }] } };
    return { status: 404, body: { error: "nope" } };
  });
}

describe("--yes guard", () => {
  it("refuses domains delete without --yes, exits 8 and sends no DELETE", async () => {
    const { fetch, calls } = api();
    const r = await cli(["domains", "delete", "7", "--json"], {
      env: ENV,
      fetch,
    });
    expect(r.code).toBe(8);
    const err = r.json().error;
    expect(err.code).toBe("CONFIRMATION_REQUIRED");
    expect(err.message).toContain("mail.acme.com");
    expect(err.details).toMatchObject({ method: "DELETE", path: "/domains/7" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes with --yes, also resolving the domain by name", async () => {
    const { fetch, calls } = api();
    const r = await cli(
      ["domains", "delete", "mail.acme.com", "--yes", "--json"],
      { env: ENV, fetch },
    );
    expect(r.code).toBe(0);
    expect(
      calls.filter((c) => c.method === "DELETE").map((c) => c.url),
    ).toEqual(["https://mail.example.test/api/v1/domains/7"]);
  });

  it("human mode explains what would happen on stderr", async () => {
    const { fetch } = api();
    const r = await cli(["contacts", "delete", "b1", "ct1"], {
      env: ENV,
      fetch,
    });
    expect(r.code).toBe(8);
    expect(r.stderr).toContain("refusing without --yes");
    expect(r.stderr).toContain("Would run:");
  });

  it.each([
    [["campaigns", "delete", "c1"]],
    [["campaigns", "resume", "c1"]],
    [["campaigns", "schedule", "c1"]],
    [["contact-books", "delete", "b1"]],
    [["contacts", "bulk-delete", "b1", "--ids", "a,b"]],
    [
      [
        "campaigns",
        "create",
        "--name",
        "n",
        "--from",
        "f@x.com",
        "--subject",
        "s",
        "--contact-book",
        "b1",
        "--html",
        "<p>x</p>",
        "--send-now",
      ],
    ],
  ])("%j requires --yes", async (argv) => {
    const { fetch, calls } = api();
    const r = await cli([...argv, "--json"], { env: ENV, fetch });
    expect(r.code).toBe(8);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("batch sends above the recipient threshold need --yes; small ones do not", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usesend-batch-"));
    const big = path.join(dir, "big.json");
    const small = path.join(dir, "small.json");
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        to: `u${i}@x.com`,
        subject: "s",
        text: "t",
      }));
    fs.writeFileSync(big, JSON.stringify(mk(11)));
    fs.writeFileSync(small, JSON.stringify(mk(2)));

    let api1 = api();
    let r = await cli(
      ["emails", "batch", "--file", big, "--from", "f@x.com", "--json"],
      { env: ENV, fetch: api1.fetch },
    );
    expect(r.code).toBe(8);
    expect(r.json().error.details).toMatchObject({
      emails: 11,
      recipients: 11,
    });
    expect(api1.calls).toHaveLength(0);

    api1 = api();
    r = await cli(
      [
        "emails",
        "batch",
        "--file",
        big,
        "--from",
        "f@x.com",
        "--yes",
        "--json",
      ],
      { env: ENV, fetch: api1.fetch },
    );
    expect(r.code).toBe(0);
    expect((api1.calls[0]!.body as unknown[]).length).toBe(11);

    api1 = api();
    r = await cli(
      ["emails", "batch", "--file", small, "--from", "f@x.com", "--json"],
      { env: ENV, fetch: api1.fetch },
    );
    expect(r.code).toBe(0);
    expect(r.json().data).toEqual([{ emailId: "e1" }]);
  });

  it("counts cc/bcc and comma-separated recipients for send safety", async () => {
    const { fetch, calls } = api();
    const to = Array.from({ length: 10 }, (_, i) => `u${i}@x.com`).join(",");
    const r = await cli(
      [
        "emails",
        "send",
        "--to",
        to,
        "--bcc",
        "extra@x.com",
        "--from",
        "f@x.com",
        "--subject",
        "s",
        "--text",
        "t",
        "--json",
      ],
      { env: ENV, fetch },
    );
    expect(r.code).toBe(8);
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed batch input before network access", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usesend-batch-"));
    const file = path.join(dir, "bad.json");
    const { fetch, calls } = api();
    for (const item of [
      null,
      3,
      { to: 42, from: "f@x.com", subject: "s", text: "t" },
    ]) {
      fs.writeFileSync(file, JSON.stringify([item]));
      const r = await cli(["emails", "batch", "--file", file, "--json"], {
        env: ENV,
        fetch,
      });
      expect(r.code).toBe(2);
    }
    expect(calls).toHaveLength(0);
  });

  it("--dry-run sends nothing and needs no key", async () => {
    const { fetch, calls } = api();
    const r = await cli(
      [
        "emails",
        "send",
        "--to",
        "a@x.com",
        "--from",
        "f@x.com",
        "--subject",
        "s",
        "--text",
        "t",
        "--idempotency-key",
        "k1",
        "--dry-run",
        "--json",
      ],
      { env: {}, fetch },
    );
    expect(r.code).toBe(0);
    expect(r.json().data).toMatchObject({
      dryRun: true,
      request: {
        method: "POST",
        path: "/emails",
        headers: { "Idempotency-Key": "k1" },
      },
    });
    expect(calls).toHaveLength(0);
  });
});
