import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  collect,
  flatList,
  oneOrMany,
  optsOf,
  parseIntOption,
  parseStringRecord,
  printDryRun,
  requireYes,
  type Context,
} from "../context";
import { usageError } from "../errors";
import { renderKv, renderTable } from "../output";

/** Batch sends reaching more recipients than this need --yes. */
export const BATCH_CONFIRM_THRESHOLD = 10;
export const MAX_ATTACHMENTS = 10;

type EmailPayload = {
  to?: string | string[];
  from?: string;
  subject?: string;
  templateId?: string;
  variables?: Record<string, string>;
  replyTo?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    content: string;
    contentId?: string;
    contentType?: string;
  }>;
  scheduledAt?: string;
  inReplyToId?: string | null;
};

type SendOpts = {
  to?: string[];
  from?: string;
  subject?: string;
  html?: string;
  htmlFile?: string;
  text?: string;
  textFile?: string;
  templateId?: string;
  variables?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  header?: string[];
  attach?: string[];
  scheduledAt?: string;
  inReplyTo?: string;
  idempotencyKey?: string;
  file?: string;
  dryRun?: boolean;
  yes?: boolean;
};

export function countRecipients(e: EmailPayload): number {
  const n = (v: string | string[] | undefined) => flatList(v)?.length ?? 0;
  return n(e.to) + n(e.cc) + n(e.bcc);
}

export function normalizeScheduledAt(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw usageError(
      `--scheduled-at "${value}" is not a valid date`,
      "Use ISO 8601 with a timezone, e.g. 2026-11-04T09:00:00Z or 2026-11-04T12:00:00+03:00.",
    );
  }
  return d.toISOString();
}

function readAttachment(file: string) {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    throw usageError(
      `Cannot read attachment ${file}: ${(err as Error).message}`,
    );
  }
  return { filename: path.basename(file), content: buf.toString("base64") };
}

function parseHeaders(
  values: string[] | undefined,
): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const out: Record<string, string> = {};
  for (const h of values) {
    const idx = h.indexOf(":") > 0 ? h.indexOf(":") : h.indexOf("=");
    if (idx <= 0)
      throw usageError(`--header "${h}" must look like "Name: value"`);
    out[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return out;
}

export async function buildSendPayload(
  ctx: Context,
  o: SendOpts,
): Promise<EmailPayload> {
  const base: EmailPayload = o.file
    ? await ctx.readJson<EmailPayload>(o.file, "payload file")
    : {};
  if (base === null || typeof base !== "object" || Array.isArray(base)) {
    throw usageError(
      "--file must contain a single JSON object (use `emails batch` for arrays)",
    );
  }
  const p: EmailPayload = { ...base };

  const to = flatList(o.to);
  if (to) p.to = oneOrMany(to);
  const from = o.from ?? ctx.env.USESEND_FROM;
  if (from && (o.from || !p.from)) p.from = from;
  if (o.subject !== undefined) p.subject = o.subject;
  if (o.templateId) p.templateId = o.templateId;
  const vars = parseStringRecord("--variables", o.variables);
  if (vars) p.variables = vars;
  const cc = flatList(o.cc);
  if (cc) p.cc = oneOrMany(cc);
  const bcc = flatList(o.bcc);
  if (bcc) p.bcc = oneOrMany(bcc);
  const replyTo = flatList(o.replyTo);
  if (replyTo) p.replyTo = oneOrMany(replyTo);

  if (o.html !== undefined && o.htmlFile)
    throw usageError("Use either --html or --html-file, not both");
  if (o.text !== undefined && o.textFile)
    throw usageError("Use either --text or --text-file, not both");
  if (o.html !== undefined) p.html = o.html;
  if (o.htmlFile) p.html = await ctx.readText(o.htmlFile, "HTML file");
  if (o.text !== undefined) p.text = o.text;
  if (o.textFile) p.text = await ctx.readText(o.textFile, "text file");

  const headers = parseHeaders(o.header);
  if (headers) p.headers = { ...p.headers, ...headers };
  if (o.attach?.length) {
    p.attachments = [...(p.attachments ?? []), ...o.attach.map(readAttachment)];
  }
  if (o.scheduledAt) p.scheduledAt = normalizeScheduledAt(o.scheduledAt);
  if (o.inReplyTo) p.inReplyToId = o.inReplyTo;

  withTemplatePlaceholder(p);
  validateEmail(p, "");
  return p;
}

/**
 * The public API schema demands `html` or `text` even when `templateId` is
 * set, although the server then replaces `html` with the rendered template.
 * Fill a placeholder so template-only sends pass validation.
 */
export const TEMPLATE_HTML_PLACEHOLDER = "<!-- rendered from template -->";
export function withTemplatePlaceholder(p: EmailPayload) {
  if (p.templateId && !p.html && !p.text) p.html = TEMPLATE_HTML_PLACEHOLDER;
}

export function validateEmail(p: EmailPayload, where: string) {
  const at = where ? ` (${where})` : "";
  for (const field of ["to", "cc", "bcc", "replyTo"] as const) {
    const v = p[field];
    if (
      v !== undefined &&
      !(typeof v === "string" && v.trim()) &&
      !(
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((x) => typeof x === "string" && x.trim())
      )
    ) {
      throw usageError(
        `${field}${at} must be a non-empty string or array of non-empty strings`,
      );
    }
  }
  if (!p.to || (Array.isArray(p.to) && p.to.length === 0))
    throw usageError(`Missing recipient${at}: --to`);
  if (typeof p.from !== "string" || !p.from.trim())
    throw usageError(
      `Missing sender${at}: --from`,
      "Pass --from 'Name <you@verified-domain>' or set USESEND_FROM.",
    );
  if (!p.subject && !p.templateId)
    throw usageError(
      `Missing --subject${at} (required unless --template-id is used)`,
    );
  if (!p.html && !p.text && !p.templateId)
    throw usageError(
      `Missing body${at}: pass --html/--html-file or --text/--text-file`,
    );
  if ((p.attachments?.length ?? 0) > MAX_ATTACHMENTS)
    throw usageError(`Too many attachments${at}: max ${MAX_ATTACHMENTS}`);
}

type EmailEvent = { status: string; createdAt: string; data?: unknown };
type EmailDetails = Record<string, unknown> & { emailEvents?: EmailEvent[] };

export function registerEmails(program: Command, ctx: Context) {
  const emails = program
    .command("emails")
    .description("Send and inspect emails");

  emails
    .command("send")
    .description(
      "Send one email (transactional). Body via --html/--text, files, or a template",
    )
    .option(
      "--to <email>",
      "recipient; repeat or comma-separate for several",
      collect,
    )
    .option(
      "--from <address>",
      'sender, e.g. "Acme <hi@mail.acme.com>" (default: $USESEND_FROM)',
    )
    .option("--subject <text>", "subject (optional with --template-id)")
    .option("--html <html>", "HTML body")
    .option("--html-file <path>", "read HTML body from a file ('-' = stdin)")
    .option("--text <text>", "plain-text body")
    .option(
      "--text-file <path>",
      "read plain-text body from a file ('-' = stdin)",
    )
    .option("--template-id <id>", "dashboard template id")
    .option(
      "--variables <json>",
      'template variables as a JSON object, e.g. \'{"name":"Ada"}\'',
    )
    .option("--cc <email>", "cc recipient (repeatable)", collect)
    .option("--bcc <email>", "bcc recipient (repeatable)", collect)
    .option("--reply-to <email>", "reply-to address (repeatable)", collect)
    .option(
      "--header <header>",
      'custom header "Name: value" (repeatable)',
      collect,
    )
    .option(
      "--attach <path>",
      "attach a file, base64-encoded (repeatable, max 10)",
      collect,
    )
    .option(
      "--scheduled-at <iso>",
      "schedule for later (ISO 8601, e.g. 2026-11-04T09:00:00Z)",
    )
    .option(
      "--in-reply-to <emailId>",
      "thread as a reply to a previous email id",
    )
    .option(
      "--idempotency-key <key>",
      "safe retries: same key + same body returns the original email id",
    )
    .option(
      "--file <path>",
      "base payload JSON (API shape); flags override its fields ('-' = stdin)",
    )
    .option("--dry-run", "print the request instead of sending")
    .option(
      "-y, --yes",
      `confirm sending to more than ${BATCH_CONFIRM_THRESHOLD} recipients`,
    )
    .action(async (_o, cmd: Command) => {
      const o = optsOf<SendOpts>(cmd);
      const payload = await buildSendPayload(ctx, o);
      const headers = o.idempotencyKey
        ? { "Idempotency-Key": o.idempotencyKey }
        : undefined;
      if (o.dryRun)
        return printDryRun(ctx, {
          method: "POST",
          path: "/emails",
          body: payload,
          headers,
        });
      if (countRecipients(payload) > BATCH_CONFIRM_THRESHOLD) {
        requireYes(o, `Send email to ${countRecipients(payload)} recipients`, {
          method: "POST",
          path: "/emails",
          recipients: countRecipients(payload),
        });
      }
      const res = await ctx
        .client(o)
        .post<{ emailId?: string }>("/emails", payload, { headers });
      ctx.out.result(res, (d) =>
        payload.scheduledAt
          ? `Scheduled ${d.emailId} for ${payload.scheduledAt}`
          : `Queued ${d.emailId}\nCheck delivery: usesend emails get ${d.emailId}`,
      );
    });

  emails
    .command("batch")
    .description(
      `Send up to 100 emails in one request (JSON array file). >${BATCH_CONFIRM_THRESHOLD} recipients needs --yes`,
    )
    .requiredOption(
      "--file <path>",
      "JSON array of email payloads ('-' = stdin)",
    )
    .option(
      "--from <address>",
      "default sender for entries without `from` (default: $USESEND_FROM)",
    )
    .option("--idempotency-key <key>", "idempotency key for the whole batch")
    .option("--dry-run", "print the request instead of sending")
    .option("-y, --yes", "confirm sending")
    .action(async (_o, cmd: Command) => {
      const o = optsOf<{
        file: string;
        from?: string;
        idempotencyKey?: string;
        dryRun?: boolean;
        yes?: boolean;
      }>(cmd);
      const list = await ctx.readJson<EmailPayload[]>(o.file, "batch file");
      if (!Array.isArray(list))
        throw usageError(
          "Batch file must contain a JSON array of email payloads",
        );
      if (list.length === 0) throw usageError("Batch file is empty");
      if (list.length > 100)
        throw usageError(
          `Batch has ${list.length} emails; the API accepts at most 100 per request`,
        );
      const from = o.from ?? ctx.env.USESEND_FROM;
      const payload = list.map((e, i) => {
        if (!e || typeof e !== "object" || Array.isArray(e))
          throw usageError(`Batch item ${i} must be an email object`);
        const item = { ...e, from: e.from ?? from };
        if (item.scheduledAt)
          item.scheduledAt = normalizeScheduledAt(item.scheduledAt);
        withTemplatePlaceholder(item);
        validateEmail(item, `item ${i}`);
        return item;
      });
      const recipients = payload.reduce((n, e) => n + countRecipients(e), 0);
      const headers = o.idempotencyKey
        ? { "Idempotency-Key": o.idempotencyKey }
        : undefined;
      if (o.dryRun)
        return printDryRun(ctx, {
          method: "POST",
          path: "/emails/batch",
          body: payload,
          headers,
        });
      if (recipients > BATCH_CONFIRM_THRESHOLD) {
        requireYes(
          o,
          `Batch send of ${payload.length} emails to ${recipients} recipients`,
          {
            method: "POST",
            path: "/emails/batch",
            emails: payload.length,
            recipients,
            subjects: Array.from(
              new Set(
                payload.map((e) => e.subject ?? `template:${e.templateId}`),
              ),
            ).slice(0, 5),
          },
        );
      }
      const res = await ctx
        .client(o)
        .post<{ data: Array<{ emailId: string }> }>("/emails/batch", payload, {
          headers,
        });
      const data = res.data ?? [];
      ctx.out.result(
        data,
        (d) =>
          `Queued ${d.length} emails:\n${d.map((x) => x.emailId).join("\n")}`,
      );
    });

  emails
    .command("get <emailId>")
    .description("Show an email with its delivery events (status timeline)")
    .option("--body", "also print the html/text body")
    .action(async (id: string, _o, cmd: Command) => {
      const o = optsOf<{ body?: boolean }>(cmd);
      const email = await ctx
        .client(o)
        .get<EmailDetails>(`/emails/${encodeURIComponent(id)}`);
      ctx.out.result(email, (e) => {
        const events = [...(e.emailEvents ?? [])].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        const latest = events.at(-1)?.status ?? "-";
        const parts = [
          renderKv({ ...e, status: latest }, [
            "id",
            "status",
            "from",
            "to",
            "cc",
            "bcc",
            "replyTo",
            "subject",
            "scheduledAt",
            "createdAt",
          ]),
          "",
          "Events:",
          renderTable(
            events as unknown as Record<string, unknown>[],
            [
              ["createdAt", "at"],
              ["status", "status"],
              ["data", "data"],
            ],
            100,
          ),
        ];
        if (o.body)
          parts.push(
            "",
            "HTML:",
            String(e.html ?? "-"),
            "",
            "Text:",
            String(e.text ?? "-"),
          );
        return parts.join("\n");
      });
    });

  emails
    .command("list")
    .description("List recent emails (newest first)")
    .option("--page <n>", "page number (1-based)")
    .option("--limit <n>", "page size (max 100)")
    .option("--start-date <iso>", "only emails created at/after this time")
    .option("--end-date <iso>", "only emails created at/before this time")
    .option("--domain-id <id>", "filter by domain id (repeatable)", collect)
    .action(async (_o, cmd: Command) => {
      const o = optsOf<{
        page?: string;
        limit?: string;
        startDate?: string;
        endDate?: string;
        domainId?: string[];
      }>(cmd);
      const res = await ctx
        .client(o)
        .get<{ data: Record<string, unknown>[]; count: number }>("/emails", {
          query: {
            page: parseIntOption("--page", o.page),
            limit: parseIntOption("--limit", o.limit),
            startDate: normalizeScheduledAt(o.startDate),
            endDate: normalizeScheduledAt(o.endDate),
            domainId: flatList(o.domainId),
          },
        });
      ctx.out.result(res, (d) =>
        [
          renderTable(d.data, [
            ["id", "id"],
            ["latestStatus", "status"],
            ["to", "to"],
            ["subject", "subject"],
            ["createdAt", "created"],
            ["scheduledAt", "scheduled"],
          ]),
          `\n${d.data.length} shown, ${d.count} total`,
        ].join("\n"),
      );
    });

  emails
    .command("update <emailId>")
    .description("Reschedule a scheduled email")
    .requiredOption("--scheduled-at <iso>", "new send time (ISO 8601)")
    .action(async (id: string, _o, cmd: Command) => {
      const o = optsOf<{ scheduledAt: string }>(cmd);
      const scheduledAt = normalizeScheduledAt(o.scheduledAt);
      const res = await ctx
        .client(o)
        .patch<{ emailId?: string }>(`/emails/${encodeURIComponent(id)}`, {
          scheduledAt,
        });
      ctx.out.result(res, () => `Rescheduled ${id} to ${scheduledAt}`);
    });

  emails
    .command("cancel <emailId>")
    .description("Cancel a scheduled email")
    .action(async (id: string, _o, cmd: Command) => {
      const o = optsOf(cmd);
      const res = await ctx
        .client(o)
        .post<{ emailId?: string }>(
          `/emails/${encodeURIComponent(id)}/cancel`,
          {},
        );
      ctx.out.result(res, () => `Cancelled ${id}`);
    });
}
