import { Command } from "commander";
import {
  collect,
  flatList,
  oneOrMany,
  optsOf,
  parseIntOption,
  printDryRun,
  requireYes,
  type Context,
} from "../context";
import { usageError } from "../errors";
import { renderKv, renderTable } from "../output";

export const CAMPAIGN_STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "RUNNING",
  "PAUSED",
  "SENT",
];

type Campaign = Record<string, unknown> & {
  id: string;
  name: string;
  status: string;
  contactBookId?: string | null;
};

const cPath = (id: string) => `/campaigns/${encodeURIComponent(id)}`;

function campaignSummary(c: Campaign) {
  return renderKv(c, [
    "id",
    "name",
    "status",
    "from",
    "subject",
    "previewText",
    "contactBookId",
    "scheduledAt",
    "batchSize",
    "batchWindowMinutes",
    "total",
    "sent",
    "delivered",
    "opened",
    "clicked",
    "bounced",
    "hardBounced",
    "complained",
    "unsubscribed",
    "createdAt",
    "updatedAt",
  ]);
}

export function registerCampaigns(program: Command, ctx: Context) {
  const campaigns = program
    .command("campaigns")
    .description("Create and run marketing campaigns");

  campaigns
    .command("list")
    .description("List campaigns")
    .option("--page <n>", "page number")
    .option("--status <status>", `filter: ${CAMPAIGN_STATUSES.join(" | ")}`)
    .option("--search <text>", "search by name or subject")
    .action(async (_o, cmd: Command) => {
      const o = optsOf<{ page?: string; status?: string; search?: string }>(
        cmd,
      );
      const status = o.status?.toUpperCase();
      if (status && !CAMPAIGN_STATUSES.includes(status))
        throw usageError(
          `--status must be one of ${CAMPAIGN_STATUSES.join(", ")}`,
        );
      const res = await ctx
        .client(o)
        .get<{ campaigns: Campaign[]; totalPage: number }>("/campaigns", {
          query: {
            page: parseIntOption("--page", o.page),
            status,
            search: o.search,
          },
        });
      ctx.out.result(res, (r) =>
        [
          renderTable(r.campaigns, [
            ["id", "id"],
            ["name", "name"],
            ["status", "status"],
            ["subject", "subject"],
            ["scheduledAt", "scheduled"],
            ["total", "total"],
            ["sent", "sent"],
            ["delivered", "delivered"],
          ]),
          `\npages: ${r.totalPage}`,
        ].join("\n"),
      );
    });

  campaigns
    .command("get <campaignId>")
    .description("Show a campaign with delivery counters")
    .action(async (id: string, _o, cmd: Command) => {
      const c = await ctx.client(optsOf(cmd)).get<Campaign>(cPath(id));
      ctx.out.result(c, campaignSummary);
    });

  campaigns
    .command("create")
    .description(
      "Create a campaign (draft by default; --send-now/--scheduled-at need --yes)",
    )
    .requiredOption("--name <name>", "internal name")
    .requiredOption("--from <address>", "sender address on a verified domain")
    .requiredOption("--subject <text>", "subject line")
    .requiredOption("--contact-book <id>", "contact book id (audience)")
    .option("--html <html>", "HTML body")
    .option("--html-file <path>", "read HTML body from a file ('-' = stdin)")
    .option(
      "--content-file <path>",
      "editor JSON content from a file (alternative to HTML)",
    )
    .option("--preview-text <text>", "inbox preview text")
    .option("--reply-to <email>", "reply-to (repeatable)", collect)
    .option("--cc <email>", "cc (repeatable)", collect)
    .option("--bcc <email>", "bcc (repeatable)", collect)
    .option("--batch-size <n>", "emails per batch window (1..100000)")
    .option("--send-now", "start sending immediately")
    .option(
      "--scheduled-at <when>",
      "ISO 8601 or natural language, e.g. 'tomorrow 9am'",
    )
    .option("--dry-run", "print the request instead of sending")
    .option("-y, --yes", "confirm scheduling/sending to the whole contact book")
    .action(async (_o, cmd: Command) => {
      const o = optsOf<{
        name: string;
        from: string;
        subject: string;
        contactBook: string;
        html?: string;
        htmlFile?: string;
        contentFile?: string;
        previewText?: string;
        replyTo?: string[];
        cc?: string[];
        bcc?: string[];
        batchSize?: string;
        sendNow?: boolean;
        scheduledAt?: string;
        dryRun?: boolean;
        yes?: boolean;
      }>(cmd);
      if (o.html !== undefined && o.htmlFile)
        throw usageError("Use either --html or --html-file");
      if (o.sendNow && o.scheduledAt)
        throw usageError("Use either --send-now or --scheduled-at");
      const body: Record<string, unknown> = {
        name: o.name,
        from: o.from,
        subject: o.subject,
        contactBookId: o.contactBook,
      };
      if (o.html !== undefined) body.html = o.html;
      if (o.htmlFile) body.html = await ctx.readText(o.htmlFile, "HTML file");
      if (o.contentFile)
        body.content = await ctx.readText(o.contentFile, "content file");
      if (!body.html && !body.content)
        throw usageError("Pass --html, --html-file or --content-file");
      if (o.previewText) body.previewText = o.previewText;
      const replyTo = oneOrMany(flatList(o.replyTo));
      if (replyTo) body.replyTo = replyTo;
      const cc = oneOrMany(flatList(o.cc));
      if (cc) body.cc = cc;
      const bcc = oneOrMany(flatList(o.bcc));
      if (bcc) body.bcc = bcc;
      const batchSize = parseIntOption("--batch-size", o.batchSize);
      if (batchSize) body.batchSize = batchSize;
      if (o.sendNow) body.sendNow = true;
      if (o.scheduledAt) body.scheduledAt = o.scheduledAt;

      if (o.dryRun)
        return printDryRun(ctx, { method: "POST", path: "/campaigns", body });
      if (o.sendNow || o.scheduledAt) {
        requireYes(
          o,
          `Create campaign "${o.name}" and ${o.sendNow ? "send it now" : `schedule it for ${o.scheduledAt}`} to every subscribed contact in book ${o.contactBook}`,
          {
            method: "POST",
            path: "/campaigns",
            body: { ...body, html: body.html ? "<html…>" : undefined },
          },
        );
      }
      const c = await ctx.client(o).post<Campaign>("/campaigns", body);
      ctx.out.result(
        c,
        (x) =>
          `Created campaign ${x.id} (${x.status})\n\n${campaignSummary(x)}`,
      );
    });

  campaigns
    .command("schedule <campaignId>")
    .description(
      "Schedule (or start) sending a campaign to its contact book (requires --yes)",
    )
    .option(
      "--scheduled-at <when>",
      "ISO 8601 or natural language; omit to send now",
    )
    .option("--batch-size <n>", "emails per batch window")
    .option("--dry-run", "print the request instead of sending")
    .option("-y, --yes", "confirm")
    .action(async (id: string, _o, cmd: Command) => {
      const o = optsOf<{
        scheduledAt?: string;
        batchSize?: string;
        dryRun?: boolean;
        yes?: boolean;
      }>(cmd);
      const body: Record<string, unknown> = {};
      if (o.scheduledAt) body.scheduledAt = o.scheduledAt;
      const batchSize = parseIntOption("--batch-size", o.batchSize);
      if (batchSize) body.batchSize = batchSize;
      const path = `${cPath(id)}/schedule`;
      if (o.dryRun) return printDryRun(ctx, { method: "POST", path, body });
      const client = ctx.client(o);
      if (!o.yes) {
        const c = await client.get<Campaign>(cPath(id));
        requireYes(
          o,
          `Schedule campaign ${c.id} "${c.name}" (${c.status}) ${o.scheduledAt ? `for ${o.scheduledAt}` : "to send now"} to contact book ${c.contactBookId}`,
          {
            method: "POST",
            path,
            body,
          },
        );
      }
      const res = await client.post<{ success: boolean }>(path, body);
      ctx.out.result(
        res,
        () =>
          `Campaign ${id} scheduled${o.scheduledAt ? ` for ${o.scheduledAt}` : " (sending now)"}`,
      );
    });

  campaigns
    .command("pause <campaignId>")
    .description("Pause a scheduled or running campaign")
    .action(async (id: string, _o, cmd: Command) => {
      const res = await ctx
        .client(optsOf(cmd))
        .post<{ success: boolean }>(`${cPath(id)}/pause`, {});
      ctx.out.result(res, () => `Campaign ${id} paused`);
    });

  campaigns
    .command("resume <campaignId>")
    .description(
      "Resume a paused campaign — sending continues (requires --yes)",
    )
    .option("-y, --yes", "confirm")
    .action(async (id: string, _o, cmd: Command) => {
      const o = optsOf<{ yes?: boolean }>(cmd);
      requireYes(
        o,
        `Resume campaign ${id}; remaining recipients will be emailed`,
        { method: "POST", path: `${cPath(id)}/resume` },
      );
      const res = await ctx
        .client(o)
        .post<{ success: boolean }>(`${cPath(id)}/resume`, {});
      ctx.out.result(res, () => `Campaign ${id} resumed`);
    });

  campaigns
    .command("delete <campaignId>")
    .description("Delete a campaign (requires --yes)")
    .option("-y, --yes", "confirm")
    .action(async (id: string, _o, cmd: Command) => {
      const o = optsOf<{ yes?: boolean }>(cmd);
      requireYes(o, `Delete campaign ${id}`, {
        method: "DELETE",
        path: cPath(id),
      });
      const res = await ctx.client(o).delete<Campaign>(cPath(id));
      ctx.out.result(res, () => `Deleted campaign ${id}`);
    });
}
