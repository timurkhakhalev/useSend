import { Command } from "commander";
import {
  Webhooks,
  WebhookVerificationError,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "usesend-js";
import { optsOf, type Context } from "../context";
import { CliError, ExitCode, usageError } from "../errors";

// Mirrors packages/lib/src/webhook/webhook-events.ts
export const WEBHOOK_EVENTS = {
  email: [
    "email.queued",
    "email.sent",
    "email.delivery_delayed",
    "email.delivered",
    "email.bounced",
    "email.rejected",
    "email.rendering_failure",
    "email.complained",
    "email.failed",
    "email.cancelled",
    "email.suppressed",
    "email.opened",
    "email.clicked",
  ],
  domain: [
    "domain.created",
    "domain.verified",
    "domain.updated",
    "domain.deleted",
  ],
  contact: ["contact.created", "contact.updated", "contact.deleted"],
  test: ["webhook.test"],
} as const;

export function registerWebhooks(program: Command, ctx: Context) {
  const webhooks = program
    .command("webhooks")
    .description("Webhook helpers (endpoints are configured in the dashboard)");

  webhooks
    .command("events")
    .description("List webhook event types")
    .action(() => {
      ctx.out.result(WEBHOOK_EVENTS, (e) =>
        Object.entries(e)
          .map(
            ([group, list]) =>
              `${group}:\n${list.map((x) => `  ${x}`).join("\n")}`,
          )
          .join("\n"),
      );
    });

  webhooks
    .command("verify")
    .description(
      "Verify a received webhook signature locally (same check as usesend-js)",
    )
    .requiredOption(
      "--body-file <path>",
      "raw request body exactly as received ('-' = stdin)",
    )
    .requiredOption(
      "--signature <value>",
      `${WEBHOOK_SIGNATURE_HEADER} header (v1=<hex>)`,
    )
    .requiredOption(
      "--timestamp <ms>",
      `${WEBHOOK_TIMESTAMP_HEADER} header (ms since epoch)`,
    )
    .option(
      "--secret-env <name>",
      "env var holding the signing secret",
      "USESEND_WEBHOOK_SECRET",
    )
    .option(
      "--tolerance <seconds>",
      "allowed clock skew; -1 disables the check",
      "300",
    )
    .action(async (_o, cmd: Command) => {
      const o = optsOf<{
        bodyFile: string;
        signature: string;
        timestamp: string;
        secretEnv: string;
        tolerance: string;
      }>(cmd);
      const secret = ctx.env[o.secretEnv];
      if (!secret)
        throw usageError(
          `Signing secret not found in $${o.secretEnv}`,
          "Export it first; secrets are never taken as argv.",
        );
      const tol = Number(o.tolerance);
      if (!Number.isFinite(tol))
        throw usageError("--tolerance must be a number");
      const body = await ctx.readText(o.bodyFile, "body file");
      try {
        const event = new Webhooks(secret).constructEvent(body, {
          headers: {
            [WEBHOOK_SIGNATURE_HEADER]: o.signature,
            [WEBHOOK_TIMESTAMP_HEADER]: o.timestamp,
          },
          tolerance: tol < 0 ? -1 : tol * 1000,
        });
        ctx.out.result(
          { valid: true, type: event.type, id: event.id },
          (d) => `Signature valid: ${d.type} (${d.id})`,
        );
      } catch (err) {
        if (err instanceof WebhookVerificationError) {
          throw new CliError(err.code, err.message, ExitCode.VALIDATION);
        }
        throw err;
      }
    });
}
