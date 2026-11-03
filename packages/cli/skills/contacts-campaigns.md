---
name: contacts-campaigns
description: Managing contact books and contacts with usesend (add, update, upsert, bulk import/delete) and running campaigns (create, schedule, pause, resume, delete, stats), including unsubscribe and personalization placeholders.
---

# Contacts and campaigns

## Contact books (audiences)

```bash
usesend contact-books list                       # id, name, contact count
usesend contact-books create "Newsletter" --emoji 📰 --variables company,plan
usesend contact-books get <bookId>
usesend contact-books update <bookId> --name "Weekly" --double-opt-in \
  --double-opt-in-from hi@mail.acme.com --double-opt-in-subject "Confirm"
usesend contact-books delete <bookId> --yes     # deletes all its contacts
```

`--variables` lists the custom properties allowed as campaign placeholders.

## Contacts

```bash
usesend contacts list <bookId> [--emails a@x.com,b@x.com] [--ids ...] [--page 1 --limit 100]
usesend contacts add <bookId> --email a@x.com --first-name Ada --properties '{"plan":"pro"}'
usesend contacts get <bookId> <contactId>
usesend contacts update <bookId> <contactId> --unsubscribed
usesend contacts upsert <bookId> <contactId> --email a@x.com --subscribed
usesend contacts delete <bookId> <contactId> --yes
usesend contacts bulk-add <bookId> --file contacts.json        # ≤1000, JSON array
usesend contacts bulk-delete <bookId> --ids id1,id2 --yes
```

Contact JSON: `{email, firstName?, lastName?, properties?: {string: string}, subscribed?}`.
`properties` values are strings. Unsubscribed contacts are skipped by campaigns.

## Campaigns

```bash
# 1. Create a draft (no email is sent)
usesend campaigns create --name "Nov launch" --from "Acme <hi@mail.acme.com>" \
  --subject "We launched" --contact-book <bookId> --html-file launch.html \
  [--preview-text "..."] [--reply-to support@acme.com] [--batch-size 500]

# 2. Inspect, then schedule (mass send → --yes)
usesend campaigns get <campaignId>
usesend campaigns schedule <campaignId> --scheduled-at "tomorrow 9am" --yes
usesend campaigns schedule <campaignId> --yes          # send now

# 3. Control and stats
usesend campaigns pause <campaignId>
usesend campaigns resume <campaignId> --yes
usesend campaigns list --status SCHEDULED
usesend campaigns get <campaignId> --json   # total, sent, delivered, opened, clicked, bounced, complained, unsubscribed
usesend campaigns delete <campaignId> --yes
```

- `create --send-now` or `create --scheduled-at` schedules immediately and needs `--yes`.
- `--scheduled-at` accepts ISO 8601 or natural language (`"next monday 10:30"`), parsed by the server.
- Status: DRAFT, SCHEDULED, RUNNING, PAUSED, SENT.
- The HTML **must contain an unsubscribe link** `{{usesend_unsubscribe_url}}`
  (or legacy `{{unsend_unsubscribe_url}}`), or scheduling fails with BAD_REQUEST.
- Personalization: `{{firstName}}`, `{{lastName}}`, `{{email}}`, and the
  book's allowed variables, optionally `{{contact.plan,fallback=free}}`.
- `--batch-size` (1..100000) emails per batch window to throttle sending.
