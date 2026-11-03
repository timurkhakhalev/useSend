import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATE_HTML_PLACEHOLDER } from "../src/commands/emails";
import { postboxDkimValue, zoneOf } from "../src/commands/domains";
import { readConfig } from "../src/config";
import { BASE, ENV, KEY, cli, mockFetch, tmpConfig } from "./helpers";

describe("emails send", () => {
  it("builds the payload from flags and files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usesend-send-"));
    fs.writeFileSync(path.join(dir, "body.html"), "<p>Hi</p>");
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");
    const { fetch, calls } = mockFetch(() => ({ body: { emailId: "e1" } }));
    const r = await cli(
      [
        "emails",
        "send",
        "--to",
        "a@x.com,b@x.com",
        "--from",
        "Acme <f@x.com>",
        "--subject",
        "Hi",
        "--html-file",
        path.join(dir, "body.html"),
        "--attach",
        path.join(dir, "a.txt"),
        "--scheduled-at",
        "2030-01-01T10:00:00+03:00",
        "--idempotency-key",
        "order-1",
        "--header",
        "X-Tag: q4",
        "--json",
      ],
      { env: ENV, fetch },
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ ok: true, data: { emailId: "e1" } });
    expect(calls[0]!.headers["idempotency-key"]).toBe("order-1");
    expect(calls[0]!.body).toEqual({
      to: ["a@x.com", "b@x.com"],
      from: "Acme <f@x.com>",
      subject: "Hi",
      html: "<p>Hi</p>",
      headers: { "X-Tag": "q4" },
      attachments: [
        { filename: "a.txt", content: Buffer.from("hello").toString("base64") },
      ],
      scheduledAt: "2030-01-01T07:00:00.000Z",
    });
  });

  it("preserves inline attachment metadata from a payload file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usesend-inline-"));
    const attachments = [
      {
        filename: "torch.png",
        content: "aW1hZ2U=",
        contentId: "torch@site",
        contentType: "image/png",
      },
    ];
    const file = path.join(dir, "payload.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        from: "hi@x.com",
        to: "a@x.com",
        subject: "Inline",
        html: '<img src="cid:torch@site">',
        attachments,
      }),
    );
    const { fetch, calls } = mockFetch(() => ({
      body: { emailId: "inline-1" },
    }));
    const result = await cli(["emails", "send", "--file", file, "--json"], {
      env: ENV,
      fetch,
    });
    expect(result.code).toBe(0);
    expect((calls[0]!.body as { attachments: unknown }).attachments).toEqual(
      attachments,
    );
  });

  it("template sends get a placeholder html and parsed variables; USESEND_FROM is the default sender", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: { emailId: "e2" } }));
    const r = await cli(
      [
        "emails",
        "send",
        "--to",
        "a@x.com",
        "--template-id",
        "tpl1",
        "--variables",
        '{"name":"Ada","n":3}',
        "--json",
      ],
      { env: { ...ENV, USESEND_FROM: "hi@x.com" }, fetch },
    );
    expect(r.code).toBe(0);
    expect(calls[0]!.body).toEqual({
      to: "a@x.com",
      from: "hi@x.com",
      templateId: "tpl1",
      variables: { name: "Ada", n: "3" },
      html: TEMPLATE_HTML_PLACEHOLDER,
    });
  });

  it("rejects an invalid --scheduled-at before calling the API", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: {} }));
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
        "--scheduled-at",
        "someday",
        "--json",
      ],
      { env: ENV, fetch },
    );
    expect(r.code).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("emails list / get", () => {
  it("passes query parameters", async () => {
    const { fetch, calls } = mockFetch(() => ({
      body: { data: [], count: 0 },
    }));
    await cli(
      [
        "emails",
        "list",
        "--limit",
        "5",
        "--domain-id",
        "1",
        "--domain-id",
        "2",
        "--json",
      ],
      { env: ENV, fetch },
    );
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("limit")).toBe("5");
    expect(u.searchParams.getAll("domainId")).toEqual(["1", "2"]);
  });

  it("renders the event timeline in human mode", async () => {
    const { fetch } = mockFetch(() => ({
      body: {
        id: "e1",
        from: "f@x.com",
        to: ["a@x.com"],
        subject: "Hi",
        emailEvents: [
          { status: "DELIVERED", createdAt: "2026-01-01T00:00:02Z" },
          { status: "SENT", createdAt: "2026-01-01T00:00:01Z" },
        ],
      },
    }));
    const r = await cli(["emails", "get", "e1"], { env: ENV, fetch });
    expect(r.stdout).toMatch(/status\s+DELIVERED/);
    expect(r.stdout.indexOf("SENT")).toBeLessThan(
      r.stdout.lastIndexOf("DELIVERED"),
    );
  });
});

describe("domains dns", () => {
  const domain = {
    id: 3,
    name: "mail.acme.com",
    subdomain: "mail",
    status: "PENDING",
    region: "us-east-1",
    dnsRecords: [
      {
        type: "MX",
        name: "mail.mail",
        value: "feedback-smtp.us-east-1.amazonses.com",
        ttl: "Auto",
        priority: "10",
        status: "PENDING",
      },
      {
        type: "TXT",
        name: "usesend._domainkey.mail",
        value: "p=MIIBkey",
        ttl: "Auto",
        status: "PENDING",
      },
    ],
  };

  it("computes the zone and FQDNs, and the Postbox DKIM form", async () => {
    expect(zoneOf(domain)).toBe("acme.com");
    expect(postboxDkimValue("p=ABC")).toBe("v=DKIM1;h=sha256;k=rsa;p=ABC");
    const { fetch } = mockFetch(() => ({ body: domain }));
    const r = await cli(["domains", "dns", "3", "--postbox", "--json"], {
      env: ENV,
      fetch,
    });
    const data = r.json().data;
    expect(data.zone).toBe("acme.com");
    expect(data.records[1]).toMatchObject({
      fqdn: "usesend._domainkey.mail.acme.com",
      value: "v=DKIM1;h=sha256;k=rsa;p=MIIBkey",
      purpose: "DKIM",
    });
  });

  it("prints bind zone lines", async () => {
    const { fetch } = mockFetch(() => ({ body: domain }));
    const r = await cli(["domains", "dns", "3", "--format", "bind"], {
      env: ENV,
      fetch,
    });
    expect(r.stdout).toContain(
      'usesend._domainkey.mail.acme.com.\t300\tIN\tTXT\t"p=MIIBkey"',
    );
    expect(r.stdout).toContain(
      "mail.mail.acme.com.\t300\tIN\tMX\t10 feedback-smtp.us-east-1.amazonses.com.",
    );
  });
});

describe("auth", () => {
  it("login reads the key from stdin, verifies it and stores it 0600", async () => {
    const file = tmpConfig();
    const { fetch, calls } = mockFetch(() => ({ body: [{ id: 1 }] }));
    const r = await cli(
      [
        "auth",
        "login",
        "--base-url",
        `${BASE}/`,
        "--profile",
        "work",
        "--json",
      ],
      {
        env: { USESEND_CONFIG: file },
        fetch,
        stdin: `${KEY}\n`,
      },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(KEY);
    expect(r.json().data).toMatchObject({
      profile: "work",
      baseUrl: BASE,
      apiKey: "us_****9876",
      verified: true,
      domains: 1,
    });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(readConfig(file)).toEqual({
      defaultProfile: "work",
      profiles: { work: { apiKey: KEY, baseUrl: BASE } },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("login does not save a key the API rejects", async () => {
    const file = tmpConfig();
    const { fetch } = mockFetch(() => ({
      status: 401,
      body: { error: { code: "UNAUTHORIZED", message: "bad" } },
    }));
    const r = await cli(["auth", "login", "--base-url", BASE, "--json"], {
      env: { USESEND_CONFIG: file },
      fetch,
      stdin: KEY,
    });
    expect(r.code).toBe(3);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("login refuses --api-key on argv", async () => {
    const r = await cli(["auth", "login", "--api-key", KEY, "--json"], {
      stdin: "",
    });
    expect(r.code).toBe(2);
  });

  it("login prompts on a TTY", async () => {
    const file = tmpConfig();
    const r = await cli(["auth", "login", "--no-verify", "--json"], {
      env: { USESEND_CONFIG: file },
      tty: true,
    });
    expect(r.code).toBe(0);
    expect(readConfig(file).profiles.default!.apiKey).toBe(
      "us_prompted_secretsecret",
    );
  });

  it("status masks the key and reports sources; logout removes the profile", async () => {
    const file = tmpConfig();
    await cli(["auth", "login", "--no-verify", "--base-url", BASE], {
      env: { USESEND_CONFIG: file },
      stdin: KEY,
    });
    const st = await cli(["auth", "status", "--json"], {
      env: { USESEND_CONFIG: file },
    });
    expect(st.code).toBe(0);
    expect(st.stdout).not.toContain(KEY);
    expect(st.json().data).toMatchObject({
      apiKey: "us_****9876",
      apiKeySource: "config",
      baseUrl: BASE,
      baseUrlSource: "config",
    });

    const out = await cli(["auth", "logout", "--json"], {
      env: { USESEND_CONFIG: file },
    });
    expect(out.json().data.removed).toEqual(["default"]);
    const after = await cli(["auth", "status", "--json"], {
      env: { USESEND_CONFIG: file },
    });
    expect(after.code).toBe(3);
  });
});

describe("doctor", () => {
  it("reports ok checks and domain statuses", async () => {
    const { fetch } = mockFetch((c) =>
      c.url.endsWith("/api/health")
        ? { body: { data: "Healthy" } }
        : {
            body: [
              { id: 1, name: "a.com", status: "SUCCESS" },
              { id: 2, name: "b.com", status: "PENDING" },
            ],
          },
    );
    const r = await cli(["doctor", "--json"], { env: ENV, fetch });
    expect(r.code).toBe(0);
    const checks = r.json().data.checks as Array<{
      name: string;
      status: string;
    }>;
    expect(checks.find((c) => c.name === "auth")!.status).toBe("ok");
    expect(checks.find((c) => c.name === "domain b.com")!.status).toBe("warn");
  });

  it("fails with the auth exit code when the key is rejected", async () => {
    const { fetch } = mockFetch((c) =>
      c.url.endsWith("/api/health")
        ? { body: { data: "Healthy" } }
        : {
            status: 401,
            body: { error: { code: "UNAUTHORIZED", message: "bad" } },
          },
    );
    const r = await cli(["doctor", "--json"], { env: ENV, fetch });
    expect(r.code).toBe(3);
    expect(r.json().error.code).toBe("DOCTOR_FAILED");
  });
});

describe("skills", () => {
  it("lists bundled skills with core first", async () => {
    const r = await cli(["skills", "list", "--json"]);
    const names = r.json().data.map((s: { name: string }) => s.name);
    expect(names[0]).toBe("core");
    expect(names).toEqual(
      expect.arrayContaining([
        "sending",
        "domains",
        "contacts-campaigns",
        "webhooks",
      ]),
    );
  });

  it("core --full appends the generated command reference", async () => {
    const short = await cli(["skills", "get", "core"]);
    const full = await cli(["skills", "get", "core", "--full"]);
    expect(short.stdout).toContain("# usesend core");
    expect(short.stdout).not.toContain("Command reference (generated)");
    expect(full.stdout).toContain("### emails send");
    expect(full.stdout).toContain("--idempotency-key");
  });

  it("unknown skill exits 4", async () => {
    expect((await cli(["skills", "get", "nope"])).code).toBe(4);
  });
});
