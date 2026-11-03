# usesend-cli

An agent-friendly CLI for the useSend public HTTP API. Works with cloud and
self-hosted instances; it does not access the application database or internal
RPC endpoints. Node.js 20+ is required for the installed binary.

## Build and install locally

From this pnpm workspace (use the repository's Node/pnpm versions):

```sh
pnpm install
pnpm --filter usesend-cli build
mkdir -p ~/.local/bin
chmod +x packages/cli/dist/index.js
ln -s "$PWD/packages/cli/dist/index.js" ~/.local/bin/usesend
usesend skills install --link
usesend skills get core
```

Ensure `~/.local/bin` is in PATH. The binary symlink and linked skill depend on
this checkout remaining available. `usesend skills install` without `--link`
copies the discovery stub instead. For another agent's skill directory, pass
`--dir /path/to/skills`. Package publication is a separate manual step.

The build bundles `usesend-js` and Commander into one executable ESM file.
The SDK's injectable fetch transport lets the CLI keep HTTP status,
`Retry-After`, timeouts and test isolation. No SDK build is needed first.
Markdown skills and the discovery stub ship alongside the executable.

## Authentication

Create an API key in Developer Settings in the dashboard, then:

```sh
# Hidden interactive prompt
usesend auth login --base-url https://usesend.example.com --profile work

# Or stdin from your secret manager (the CLI never prints the full key)
pass show usesend/work | usesend auth login --profile work
usesend auth status --check
usesend auth use work
usesend auth logout --profile work
```

`auth login` accepts the key only on stdin or through its hidden prompt and
verifies it with `GET /api/v1/domains` before saving. `--no-verify` skips that
check. `--default` makes the selected profile the default. Logout removes local
credentials; it does not revoke the key on the server. Environment overrides
remain active after logout.

Precedence for each setting: flags `--api-key` / `--base-url` / `--profile`, then
`USESEND_API_KEY` / `USESEND_BASE_URL` / `USESEND_PROFILE`, then the selected
profile in `~/.config/usesend/cli.json`. The file is written atomically with mode
0600; its directory is created with mode 0700. `XDG_CONFIG_HOME` changes the
config root; `USESEND_CONFIG` selects an explicit file. `auth status` reports
the source of each setting and masked keys. Avoid `--api-key` for routine use:
argv can be visible in process lists and shell history, and `auth login`
rejects that flag.

The default instance is `https://app.usesend.com`. Pass an instance URL, not an
API route; copied `/api/v1` suffixes are normalized. `--timeout <seconds>` sets
the per-request timeout (default 30). `USESEND_FROM` supplies a default sender.

## Commands

| Group           | Commands                                                                      |
| --------------- | ----------------------------------------------------------------------------- |
| `auth`          | `login`, `status [--check]`, `logout [--all]`, `use <profile>`                |
| `emails`        | `send`, `batch`, `get`, `list`, `update`, `cancel`                            |
| `domains`       | `list`, `get`, `create`, `verify [--wait]`, `delete`, `dns`                   |
| `contacts`      | `list`, `get`, `add`, `update`, `upsert`, `delete`, `bulk-add`, `bulk-delete` |
| `contact-books` | `list`, `get`, `create`, `update`, `delete`                                   |
| `campaigns`     | `list`, `get`, `create`, `schedule`, `pause`, `resume`, `delete`              |
| `analytics`     | `time-series`, `reputation`                                                   |
| `webhooks`      | `events`, `verify` (local SDK signature verification)                         |
| `skills`        | `list`, `get <name> [--full]`, `install`                                      |
| `doctor`        | Config permissions, reachability, authentication and domain verification      |

Use `<group> <command> --help` for flags, or `usesend skills get core --full`
for the generated reference. Domains accept an ID or name. Contacts take a
contact-book ID first.

```sh
usesend emails send --from 'Acme <hello@mail.example.com>' --to user@example.com \
  --subject Receipt --html-file receipt.html --text-file receipt.txt \
  --attach receipt.pdf --idempotency-key order-123 --dry-run --json
usesend emails send --from hello@mail.example.com --to user@example.com \
  --template-id TEMPLATE_ID --variables '{"name":"Ada"}' --dry-run
usesend emails batch --file batch.json --from hello@mail.example.com --dry-run
usesend emails get EMAIL_ID --json
usesend domains dns mail.example.com --format bind
usesend doctor --json
```

`send --file payload.json` reads an API-shaped JSON object; flags override its
fields. `--html-file`, `--text-file` and `--file` accept `-` for stdin (use only
one stdin source per invocation). Attachments are base64-encoded by the CLI.
Templates are managed in the dashboard. The CLI supplies placeholder HTML for
template-only sends because the API requires a body before rendering.

`--scheduled-at` on emails accepts a date normalized to UTC; prefer ISO 8601
with an explicit timezone. `emails update` reschedules and `cancel` cancels a
scheduled email. Campaign scheduling also accepts server-supported natural
language. Idempotency keys apply to send/batch, expire after 24 hours, and must
be reused only with the same payload when retrying an uncertain send.

## Safety and output

Destructive deletes, campaign schedule/resume, campaign creation with
`--send-now` or `--scheduled-at`, and sending to **more than 10 total recipients**
(to + cc + bcc across the request) require `--yes`. Without it, the CLI describes
the action and exits 8 without performing the mutation. Domain deletion and
campaign scheduling may make read requests to describe the target.

`--dry-run` works for email send/batch, domain create, contact add/bulk-add,
contact-book create and campaign create/schedule. It validates local input and
prints a request preview without network access or credentials. Attachment
contents and long HTML are shortened in previews. Other mutations still need
care: adding contacts to a double opt-in book can send confirmation mail.

Human output is the default. `--json` emits one result document on stdout
(help and version remain text):

```json
{ "ok": true, "data": { "emailId": "..." } }
```

```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Domain not found",
    "hint": "List domains first"
  }
}
```

Errors can also carry `error.details` (confirmation plans, doctor checks, HTTP
status). Successful `data` follows the API response, except `emails batch`
returns the email-ID array. Delivery events are available in
`emails get` → `data.emailEvents`; a queued send is not proof of delivery.

| Exit | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | Success                                                              |
| 1    | General/server error or unsuccessful domain verification             |
| 2    | Usage, input file/JSON or config error                               |
| 3    | Missing credentials, HTTP 401/403                                    |
| 4    | Not found, HTTP 404                                                  |
| 5    | API validation/conflict, HTTP 400/409/422, invalid webhook signature |
| 6    | Rate limit, HTTP 429 (check Retry-After hint)                        |
| 7    | Network/timeout                                                      |
| 8    | Confirmation required (`--yes`)                                      |

## Skills

The discovery stub (`skill/SKILL.md`) directs agents to version-matched content
served by the installed CLI:

- `core`: workflows, JSON contract, exit codes, safety, troubleshooting.
- `sending`: transactional email, templates, attachments, retries, scheduling, batches.
- `domains`: DNS and verification, including Yandex Cloud Postbox DKIM format
  `v=DKIM1;h=sha256;k=rsa;p=...` and retrying verification after DNS propagation.
- `contacts-campaigns`: contact books, contacts and campaign workflows.
- `webhooks`: events, payloads and raw-body HMAC verification with `usesend-js`.

## Development checks

```sh
pnpm --filter usesend-cli test
pnpm --filter usesend-cli typecheck
pnpm --filter usesend-cli lint
pnpm --filter usesend-cli build
pnpm exec turbo run typecheck --filter=usesend-cli
```

Vitest uses mocked HTTP requests: no test sends email, changes DNS or needs a
live API key. Live smoke testing must use an explicitly allowed instance and
recipient and keep an external send ledger across agent continuations.
