---
name: usesend
description: Email sending and delivery via the useSend CLI (`usesend`). Use when the user wants to send an email (transactional, template, scheduled or batch), check whether an email was delivered/bounced, add or verify a sending domain and its DNS records (DKIM/SPF/DMARC), manage contacts and contact books, create/schedule/pause email campaigns, look at bounce/complaint analytics, or verify useSend webhooks. Triggers include "send an email", "email the user", "did the email arrive", "verify my domain", "DNS records for email", "add contacts", "newsletter/campaign", "useSend" or "unsend".
allowed-tools: Bash(usesend:*), Bash(npx usesend-cli:*)
---

# usesend

Agent-friendly CLI for useSend (open-source email platform: cloud or self-hosted).

Local setup: build `packages/cli` and link `dist/index.js` into PATH (see the package README).
After publication: `npm i -g usesend-cli`.

## Start here

This file is a discovery stub, not the usage guide. Before running any
`usesend` command, load the actual workflow content from the CLI:

```bash
usesend skills get core             # start here — auth, JSON contract, exit codes, safety, workflows
usesend skills get core --full      # + generated reference of every command and flag
```

The CLI serves skill content that matches the installed version, so the
instructions never go stale.

## Specialized skills

```bash
usesend skills get sending              # transactional mail, templates, idempotency, scheduling, batch
usesend skills get domains              # DNS records, verification, Yandex Cloud Postbox notes
usesend skills get contacts-campaigns   # contact books, contacts, campaigns
usesend skills get webhooks             # event types and signature verification
```

Run `usesend skills list` to see everything on the installed version.

## Ground rules

- Never print or pass an API key on the command line; `usesend auth login` reads it from stdin.
- Destructive or mass actions need `--yes`; add it only when the user asked for that action.
- Use `--json` and branch on exit codes (`usesend --help` lists them).
