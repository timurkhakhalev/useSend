import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UseSend } from "usesend-js";
import { BASE, KEY, cli, mockFetch } from "./helpers";

it("uses the injected SDK transport for a send without changing global fetch", async () => {
  const original = globalThis.fetch;
  const { fetch, calls } = mockFetch(() => ({ body: { emailId: "e1" } }));
  const sdk = new UseSend(KEY, BASE, { fetch });
  expect(
    await sdk.emails.send(
      {
        from: "from@example.com",
        to: "to@example.com",
        subject: "Hi",
        text: "Hello",
      },
      { idempotencyKey: "sdk-1" },
    ),
  ).toEqual({ data: { emailId: "e1" }, error: null });
  expect(calls[0]).toMatchObject({
    method: "POST",
    url: `${BASE}/api/v1/emails`,
  });
  expect(calls[0]!.headers["idempotency-key"]).toBe("sdk-1");
  expect(globalThis.fetch).toBe(original);
});

describe("webhook verification", () => {
  it("accepts a signed raw body and rejects a changed body", async () => {
    const secret = "whsec_test";
    const timestamp = String(Date.now());
    const body = JSON.stringify({
      id: "hook1",
      type: "email.delivered",
      data: {},
    });
    const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
    const args = [
      "webhooks",
      "verify",
      "--body-file",
      "-",
      "--signature",
      signature,
      "--timestamp",
      timestamp,
      "--json",
    ];
    const env = { USESEND_WEBHOOK_SECRET: secret };
    const valid = await cli(args, { env, stdin: body });
    expect(valid.code).toBe(0);
    expect(valid.json().data).toEqual({
      valid: true,
      type: "email.delivered",
      id: "hook1",
    });
    const invalid = await cli(args, { env, stdin: body + " " });
    expect(invalid.code).toBe(5);
    expect(invalid.json().error.code).toBe("SIGNATURE_MISMATCH");
  });
});
