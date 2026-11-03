---
name: webhooks
description: useSend webhook event types and payloads, delivery headers and retries, and how a receiving app verifies the X-UseSend-Signature (usesend-js Webhooks or manual HMAC), plus local verification with usesend webhooks verify.
---

# Webhooks

Endpoints and signing secrets are configured in the dashboard (Webhooks); the
public API does not manage them. `usesend webhooks events` lists event types.

## Events

- email: `email.queued`, `email.sent`, `email.delivery_delayed`, `email.delivered`,
  `email.bounced`, `email.rejected`, `email.rendering_failure`, `email.complained`,
  `email.failed`, `email.cancelled`, `email.suppressed`, `email.opened`, `email.clicked`
- domain: `domain.created`, `domain.verified`, `domain.updated`, `domain.deleted`
- contact: `contact.created`, `contact.updated`, `contact.deleted`
- test: `webhook.test`

Body (JSON):

```json
{ "id": "call id", "type": "email.delivered", "version": "2026-01-18",
  "createdAt": "ISO", "teamId": 1, "attempt": 1, "data": { ... } }
```

Email `data`: `{id, status, from, to[], occurredAt, subject?, campaignId?, contactId?, domainId?, templateId?, metadata?}`
plus `bounce {type, subType, message?}`, `failed {reason}`,
`suppression {type, reason}`, `open {timestamp, userAgent?, ip?}`,
`click {timestamp, url, ...}` for the matching events.
Domain `data`: `{id, name, status, region, dkimStatus, spfDetails, ...}`.
Contact `data`: `{id, email, contactBookId, subscribed, properties, firstName, lastName, ...}`.

## Delivery

Headers: `X-UseSend-Event`, `X-UseSend-Call` (unique per call — use it to
dedupe), `X-UseSend-Timestamp` (ms since epoch), `X-UseSend-Signature`
(`v1=<hex>`), `X-UseSend-Retry` (`true` on retries). Timeout 10s; up to 6
attempts with exponential backoff (5s base). Respond 2xx quickly; process async.
Endpoints with many consecutive failures get auto-disabled.

## Verifying signatures

Signature = `"v1=" + hex(HMAC_SHA256(secret, timestamp + "." + rawBody))`.
Always verify against the **raw** body (before JSON parsing) and reject
timestamps older than 5 minutes.

```ts
import { Webhooks } from "usesend-js"; // or: new UseSend(key).webhooks(secret)
const webhooks = new Webhooks(process.env.USESEND_WEBHOOK_SECRET!);

export async function POST(req: Request) {
  // Next.js App Router
  try {
    const event = webhooks.constructEvent(await req.text(), {
      headers: req.headers,
    });
    if (event.type === "email.bounced") {
      /* event.data.bounce.type */
    }
    return new Response("ok");
  } catch {
    return new Response("invalid signature", { status: 401 });
  }
}
```

Express: use `express.raw({ type: "application/json" })` so `req.body` is the raw Buffer.
`webhooks.verify(body, { headers })` returns a boolean instead of throwing.
Error codes: MISSING_SIGNATURE, MISSING_TIMESTAMP, INVALID_SIGNATURE_FORMAT,
INVALID_TIMESTAMP, TIMESTAMP_OUT_OF_RANGE, SIGNATURE_MISMATCH, INVALID_JSON.

Manual (any language): compute the HMAC above, constant-time compare with the header.

## Local check

```bash
export USESEND_WEBHOOK_SECRET=whsec_...           # secret is read from env, never argv
usesend webhooks verify --body-file body.json --signature "v1=..." --timestamp 1730000000000 \
  [--tolerance -1]                                # -1 skips the age check for captured payloads
```

Exit 0 if valid, 5 with the error code otherwise.
