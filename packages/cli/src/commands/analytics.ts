import { Command } from "commander";
import { optsOf, type Context } from "../context";
import { usageError } from "../errors";
import { renderKv, renderTable } from "../output";

type Counts = {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
};

export function registerAnalytics(program: Command, ctx: Context) {
  const analytics = program
    .command("analytics")
    .description("Delivery analytics");

  analytics
    .command("time-series")
    .description(
      "Daily sent/delivered/opened/clicked/bounced/complained counts",
    )
    .option("--days <n>", "7 or 30", "7")
    .option("--domain-id <id>", "limit to one domain")
    .action(async (_o, cmd: Command) => {
      const o = optsOf<{ days: string; domainId?: string }>(cmd);
      if (!["7", "30"].includes(o.days))
        throw usageError("--days must be 7 or 30");
      const res = await ctx
        .client(o)
        .get<{ result: Array<Counts & { date: string }>; totalCounts: Counts }>(
          "/analytics/email-time-series",
          { query: { days: o.days, domainId: o.domainId } },
        );
      ctx.out.result(res, (r) =>
        [
          renderTable(r.result as unknown as Record<string, unknown>[], [
            ["date", "date"],
            ["sent", "sent"],
            ["delivered", "delivered"],
            ["opened", "opened"],
            ["clicked", "clicked"],
            ["bounced", "bounced"],
            ["complained", "complained"],
          ]),
          "",
          "Totals:",
          renderKv(r.totalCounts as unknown as Record<string, unknown>),
        ].join("\n"),
      );
    });

  analytics
    .command("reputation")
    .description("Bounce and complaint rates (deliverability health)")
    .option("--domain-id <id>", "limit to one domain")
    .action(async (_o, cmd: Command) => {
      const o = optsOf<{ domainId?: string }>(cmd);
      const res = await ctx
        .client(o)
        .get<Record<string, number>>("/analytics/reputation-metrics", {
          query: { domainId: o.domainId },
        });
      ctx.out.result(res, (r) => renderKv(r));
    });
}
