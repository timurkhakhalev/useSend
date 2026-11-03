---
name: domains
description: Adding a sending domain with usesend, the DNS records it needs (DKIM, SPF, MAIL FROM MX, DMARC), verification and its statuses, and Yandex Cloud Postbox specifics.
---

# Domains

A domain must be verified before you can send `from` it.

```bash
usesend domains list                                  # id, name, status, dkim, spf
usesend domains create mail.acme.com --region us-east-1
usesend domains dns mail.acme.com                     # copy-friendly records (id or name)
usesend domains dns 3 --format bind                   # zone-file lines
usesend domains dns 3 --format table
usesend domains verify 3 --wait                       # re-check until done (default 300s)
usesend domains get 3 --json
usesend domains delete 3 --yes                        # destructive
```

`--region` must be a region enabled on that instance (cloud: SES regions such as
`us-east-1`, `eu-central-1`; self-hosted: whatever the admin configured).

## DNS records

`dns` prints each record with its relative `name` and the full `fqdn`; record
names are relative to the zone apex (the registrable domain), e.g. for
`mail.acme.com` the zone is `acme.com`:

| purpose             | type         | name (relative)               | value                                  |
| ------------------- | ------------ | ----------------------------- | -------------------------------------- |
| MAIL FROM           | MX (prio 10) | `mail.<sub>`                  | `feedback-smtp.<region>.amazonses.com` |
| DKIM                | TXT          | `<selector>._domainkey.<sub>` | `p=<public key>`                       |
| SPF                 | TXT          | `mail.<sub>`                  | `v=spf1 include:amazonses.com ~all`    |
| DMARC (recommended) | TXT          | `_dmarc`                      | `v=DMARC1; p=none;`                    |

`--json` returns `{domain, id, zone, status, records:[{type,name,fqdn,value,priority,ttl,status,purpose}]}`.
Each record has its own status; the domain is usable when `status` is `SUCCESS`.
In bind format, TXT values over 255 chars are split into several quoted strings.

## Verification

- Status: NOT_STARTED → PENDING → SUCCESS, or FAILED / TEMPORARY_FAILURE.
- `verify` sets `isVerifying`; the server re-checks DNS in the background.
  `--wait` polls every 5s and exits 0 on SUCCESS, 1 otherwise (with
  `dkimStatus`/`spfDetails` in `error.details`).
- DNS propagation can take minutes to hours; if it fails, compare with `dns`,
  fix records, run `verify` again.

## Yandex Cloud Postbox backend

Self-hosted instances can run on Yandex Cloud Postbox instead of AWS SES:

- Postbox only accepts the full DKIM TXT form `v=DKIM1;h=sha256;k=rsa;p=<key>`.
  `usesend domains dns <id> --postbox` prints the DKIM value in that form.
- Verification is slower and may need another `usesend domains verify <id>`
  after the records propagate. Re-run it rather than deleting/recreating the domain.
- The custom MAIL FROM (MX + SPF on `mail.*`) may be unsupported on Postbox; DKIM is what gates verification.
