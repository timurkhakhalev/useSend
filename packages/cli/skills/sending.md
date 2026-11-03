---
name: sending
description: Sending email with usesend — transactional mail, HTML/text files, templates and variables, attachments, idempotency keys, scheduling, rescheduling/cancelling and batch sends.
---

# Sending email

## One email

```bash
usesend emails send \
  --from "Acme <hi@mail.acme.com>" \
  --to a@example.com --to b@example.com \
  --subject "Your receipt" \
  --html-file receipt.html --text-file receipt.txt \
  --json
# → {"ok":true,"data":{"emailId":"cm..."}}
```

- More than 10 recipients (to+cc+bcc) requires `--yes` for both send and batch.
- Body: `--html`, `--html-file`, `--text`, `--text-file` (`-` = stdin). At least one is required unless `--template-id` is used.
- `--attach <path>` (repeatable, max 10): base64-encoded by the CLI, filename = basename.
- `--header "X-Campaign: q4"` (repeatable) adds custom headers.
- `--in-reply-to <emailId>` threads a reply to an earlier email.
- `--file payload.json` takes a full API payload (`to, from, subject, html, text, templateId, variables, cc, bcc, replyTo, headers, attachments, scheduledAt, inReplyToId`); flags override its fields.
- `--dry-run` prints the exact request (attachments truncated) without sending.

## Templates and variables

```bash
usesend emails send --from hi@mail.acme.com --to a@example.com \
  --template-id <templateId> --variables '{"name":"Ada","code":"123"}'
```

- Templates are created in the dashboard; the id is shown there.
- The template's subject and HTML replace `--subject`/`--html`. `{{key}}` in
  the template subject/body is replaced by `variables[key]` (values are strings,
  substituted literally). The template must belong to the API key's team.
- The API schema requires `html` or `text` even with a template; the CLI fills a
  placeholder `html` that the server overwrites with the rendered template.

## Idempotency (safe retries)

`--idempotency-key <key>` (≤256 chars, e.g. an order or signup id), for `send` and `batch`:

- same key + same body → original `emailId`, nothing re-sent;
- same key + different body → 409 `NOT_UNIQUE` (exit 5);
- same key while the first request is in flight → 409; retry shortly.
  Keys expire after 24h. Always set one when retrying after exit 7 (network) or 6 (rate limit).

## Scheduling

```bash
usesend emails send ... --scheduled-at 2026-11-04T09:00:00+03:00   # ISO 8601 with offset
usesend emails update <emailId> --scheduled-at 2026-11-05T09:00:00Z  # reschedule
usesend emails cancel <emailId>                                    # cancel while SCHEDULED
```

The CLI normalises the time to UTC ISO. Natural language ("tomorrow 9am") works
only for campaigns, not for single emails.

## Batch (up to 100 emails per request)

```bash
cat > batch.json <<'JSON'
[
  {"to": "a@example.com", "subject": "Hi A", "text": "Hello A"},
  {"to": "b@example.com", "subject": "Hi B", "html": "<p>Hello B</p>"}
]
JSON
usesend emails batch --file batch.json --from hi@mail.acme.com --dry-run
usesend emails batch --file batch.json --from hi@mail.acme.com --json   # ≤10 recipients
usesend emails batch --file big.json --yes --idempotency-key newsletter-2026-11   # >10 recipients
```

- Each item uses the single-email payload shape; `--from` fills items without `from`.
- More than 10 total recipients (to+cc+bcc) requires `--yes` (exit 8 otherwise).
- Response: `data` = `[{"emailId": "..."}]` in input order.
- For audiences use campaigns (`skills get contacts-campaigns`), not big batches.

## Checking delivery

```bash
usesend emails get <emailId> --json   # data.emailEvents[] {status, createdAt, data}
usesend emails list --start-date 2026-11-01T00:00:00Z --domain-id 3 --limit 50
```

`latestStatus` in `emails list` is the newest event. BOUNCED/FAILED/REJECTED
events carry the reason in `data`. SUPPRESSED = recipient on the suppression list.

## Inline images

Use `emails send --file payload.json` (or `emails batch --file batch.json`)
with attachment fields `filename`, base64 `content`, optional `contentId` and
optional `contentType`. For example, `contentId: "torch@site"` matches
`<img src="cid:torch@site">` in HTML. Supply the ID without angle brackets.
`contentType: "image/png"` overrides inference from the filename.
Attachments with a content ID are inline; `--attach path` adds ordinary files.
