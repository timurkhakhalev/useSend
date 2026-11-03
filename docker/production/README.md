# Production behind an existing Traefik

This Compose setup uses the external `traefik-public` network and the
`letsencrypt` certificate resolver. Only the app joins the public network;
Postgres and Redis have no published ports.

1. Copy `compose.yml`, `backup.sh` and `.env.example` to the deployment directory.
2. Copy `.env.example` to `.env`, set mode 0600, and fill the required values.
   Pin `USESEND_IMAGE` to the tested commit tag or image digest. Keep the same
   `NEXTAUTH_SECRET` when restoring an existing instance: it encrypts DKIM keys.
3. Pull the image with `docker compose pull`.
4. Start the data services with `docker compose up -d --wait postgres redis`.
   For a migration, restore the source Postgres dump before starting the app.
   Keep only one active Postbox event reader during the transfer.
5. Run `docker compose up -d usesend`. The entrypoint applies Prisma migrations.
6. Check `/api/health`, `/api/version`, login and an email delivery event.
7. Run `./backup.sh` and schedule it daily. It keeps local dumps for seven days.
   Copy backups off the server separately if protection against server loss is needed.

The web app uses the Postbox API for its own login emails. Consumers using SMTP
need a separate SMTP integration; the HTTPS app endpoint is not an SMTP server.
