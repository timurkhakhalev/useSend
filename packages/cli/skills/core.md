---
name: core
description: Core usesend CLI guide. Read before running any usesend command. Covers auth and profiles, the JSON output contract, exit codes, the --yes/--dry-run safety rules, common workflows (send, check delivery, domains, contacts, campaigns) and troubleshooting.
---

# usesend core

`usesend` drives a useSend instance (cloud or self-hosted) through its public
HTTP API (`/api/v1`). It wraps emails, domains, contacts, contact books,
campaigns and analytics. Every command takes `--json`.

## Setup (once)

```bash
usesend auth status                     # is a key configured? which instance?
printf %s "$KEY" | usesend auth login --base-url https://usesend.example.com
usesend doctor                          # config, reachability, auth, domain status
```

- `auth login` reads the key from **stdin** (or prompts without echo). It never
  accepts the key as an argument. Never echo/print a key; `auth status` shows it masked.
- Precedence: `--api-key`/`--base-url`/`--profile` flags > `USESEND_API_KEY`,
  `USESEND_BASE_URL`, `USESEND_PROFILE` env > `~/.config/usesend/cli.json` (mode 0600).
- Profiles for several instances/teams: `usesend auth login --profile staging`,
  then `--profile staging` per command or `usesend auth use staging`.
- `--base-url` is the instance origin (`https://app.usesend.com`), not `/api/v1`.

## Output contract

Default output is human-readable. With `--json`, stdout holds exactly one JSON document:

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "Domain not found", "hint": "...", "details": { } } }
```

`data` is the API response (sometimes lightly reshaped, e.g. `emails batch` →
`[{emailId}]`). `error.code` is the API code (`BAD_REQUEST`, `UNAUTHORIZED`,
`FORBIDDEN`, `NOT_FOUND`, `NOT_UNIQUE`, `RATE_LIMITED`, `INTERNAL_SERVER_ERROR`,
`VALIDATION_ERROR`) or a CLI code (`USAGE`, `NO_API_KEY`, `NETWORK_ERROR`,
`TIMEOUT`, `CONFIRMATION_REQUIRED`, `DOCTOR_FAILED`). Notes go to stderr.

## Exit codes

| code | meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| 0    | success                                                             |
| 1    | general error / server 5xx / domain not verified                    |
| 2    | usage: bad flags, unreadable file, invalid JSON input               |
| 3    | auth: no key, 401 or 403                                            |
| 4    | not found (404)                                                     |
| 5    | validation rejected by the API (400/409/422), bad webhook signature |
| 6    | rate limited (429) — wait `Retry-After` seconds, retry              |
| 7    | network: DNS/TLS/connection/timeout — server not reached            |
| 8    | confirmation required: re-run with `--yes` (nothing was sent)       |

## Safety rules

- Need `--yes`: `domains delete`, `contacts delete`, `contacts bulk-delete`,
  `contact-books delete`, `campaigns delete`, `campaigns schedule`,
  `campaigns resume`, `campaigns create --send-now|--scheduled-at`, and
  `emails send`/`emails batch` reaching more than 10 recipients (to+cc+bcc).
  Without `--yes` the CLI prints what it would do and exits 8.
- Only add `--yes` when the user asked for that exact action.
- `--dry-run` (emails send/batch, domains create, contacts add/bulk-add,
  contact-books create, campaigns create/schedule) prints the request; no network, no key needed.
- Real email is irreversible. Prefer `--dry-run` first, and send test mail only to addresses the user named.

## Common workflows

```bash
# Send and confirm delivery
usesend emails send --from "Acme <hi@mail.acme.com>" --to user@example.com \
  --subject "Hi" --text "Hello" --idempotency-key signup-123 --json
usesend emails get <emailId> --json      # emailEvents[]: QUEUED → SENT → DELIVERED / BOUNCED ...
usesend emails list --limit 20

# Domains
usesend domains list
usesend domains dns mail.acme.com        # records to add (id or name)
usesend domains verify mail.acme.com --wait

# Contacts and campaigns
usesend contact-books list
usesend contacts add <bookId> --email a@b.com --first-name Ada
usesend campaigns create --name Launch --from hi@mail.acme.com --subject "We launched" \
  --contact-book <bookId> --html-file launch.html            # draft
usesend campaigns schedule <campaignId> --scheduled-at "tomorrow 9am" --yes

# Health
usesend analytics reputation
usesend doctor --json
```

Email status values: SCHEDULED, QUEUED, SENT, DELIVERY_DELAYED, DELIVERED,
OPENED, CLICKED, BOUNCED, REJECTED, RENDERING_FAILURE, COMPLAINED, FAILED,
CANCELLED, SUPPRESSED. Domain status: NOT_STARTED, PENDING, SUCCESS, FAILED,
TEMPORARY_FAILURE.

## Troubleshooting

- Exit 3 / `UNAUTHORIZED`: wrong key or wrong instance → `usesend auth status`,
  then `auth login` again. `FORBIDDEN` on send: the key is restricted to another
  domain, or `from` uses a domain that is not verified.
- Exit 7: wrong `--base-url` or instance down → `usesend doctor`. Retry later.
- Exit 5 with `VALIDATION_ERROR`: message lists `field: problem`. `NOT_UNIQUE`
  on send: same idempotency key reused with a different body.
- Email stuck in QUEUED/SENT: check `emails get` events later; `SUPPRESSED`
  means the recipient is on the suppression list (earlier bounce/complaint).
- `doctor` lists each domain; anything not SUCCESS → `skills get domains`.

## More skills

```bash
usesend skills get sending              # transactional mail, templates, idempotency, scheduling, batch
usesend skills get domains              # DNS records, verification, Yandex Cloud Postbox notes
usesend skills get contacts-campaigns   # contact books, contacts, campaigns
usesend skills get webhooks             # event types, signature verification
usesend skills get core --full          # + generated reference of every command and flag
```
