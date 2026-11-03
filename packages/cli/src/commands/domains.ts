import { Command } from "commander";
import { optsOf, printDryRun, requireYes, type Context } from "../context";
import type { ApiClient } from "../api";
import { CliError, ExitCode, usageError } from "../errors";
import { renderKv, renderTable } from "../output";

export type DnsRecord = {
  type: string;
  name: string;
  value: string;
  ttl: string;
  priority?: string | null;
  status: string;
  recommended?: boolean;
};

export type Domain = {
  id: number;
  name: string;
  status: string;
  region: string;
  subdomain?: string | null;
  dkimStatus?: string | null;
  spfDetails?: string | null;
  dmarcAdded?: boolean;
  isVerifying?: boolean;
  verificationError?: string | null;
  errorMessage?: string | null;
  lastCheckedTime?: string | null;
  clickTracking?: boolean;
  openTracking?: boolean;
  createdAt?: string;
  dnsRecords?: DnsRecord[];
};

/** Zone apex: the DNS record names are relative to the registrable domain. */
export function zoneOf(d: Pick<Domain, "name" | "subdomain">): string {
  if (d.subdomain && d.name.startsWith(`${d.subdomain}.`))
    return d.name.slice(d.subdomain.length + 1);
  return d.name;
}

export function fqdn(record: DnsRecord, zone: string): string {
  return record.name === "@" || record.name === ""
    ? zone
    : `${record.name}.${zone}`;
}

/** Yandex Cloud Postbox only accepts the full DKIM TXT form. */
export function postboxDkimValue(value: string): string {
  if (value.startsWith("v=DKIM1")) return value;
  const key = value.replace(/^p=/, "");
  return `v=DKIM1;h=sha256;k=rsa;p=${key}`;
}

export function dnsRecordsFor(d: Domain, opts: { postbox?: boolean } = {}) {
  const zone = zoneOf(d);
  return (d.dnsRecords ?? []).map((r) => {
    const isDkim = r.type === "TXT" && r.name.includes("._domainkey");
    return {
      ...r,
      value: isDkim && opts.postbox ? postboxDkimValue(r.value) : r.value,
      fqdn: fqdn(r, zone),
      purpose: isDkim
        ? "DKIM"
        : r.type === "MX"
          ? "MAIL FROM (MX)"
          : r.name.startsWith("_dmarc")
            ? "DMARC"
            : "SPF",
    };
  });
}

/** TXT values longer than 255 bytes must be split into quoted strings in zone files. */
function zoneTxt(value: string): string {
  const parts = value.match(/.{1,255}/g) ?? [""];
  return parts.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(" ");
}

export function renderDns(d: Domain, format: string, postbox: boolean): string {
  const records = dnsRecordsFor(d, { postbox });
  if (format === "bind") {
    return records
      .map((r) =>
        r.type === "MX"
          ? `${r.fqdn}.\t300\tIN\tMX\t${r.priority ?? 10} ${r.value}.`
          : `${r.fqdn}.\t300\tIN\tTXT\t${zoneTxt(r.value)}`,
      )
      .join("\n");
  }
  if (format === "table") {
    return renderTable(
      records as unknown as Record<string, unknown>[],
      [
        ["type", "type"],
        ["name", "name"],
        ["priority", "prio"],
        ["status", "status"],
        ["value", "value"],
      ],
      400,
    );
  }
  const zone = zoneOf(d);
  const out = [
    `DNS records for ${d.name} — add them in the DNS zone of ${zone}`,
    "",
  ];
  records.forEach((r, i) => {
    out.push(
      `# ${i + 1}. ${r.purpose}${r.recommended ? " (recommended)" : ""} — status: ${r.status}`,
    );
    out.push(`Type:     ${r.type}`);
    out.push(`Name:     ${r.name}`);
    out.push(`FQDN:     ${r.fqdn}`);
    if (r.priority) out.push(`Priority: ${r.priority}`);
    out.push(`TTL:      ${r.ttl}`);
    out.push(`Value:    ${r.value}`);
    out.push("");
  });
  if (!postbox)
    out.push(
      "Using Yandex Cloud Postbox? Re-run with --postbox for the DKIM value it requires.",
    );
  out.push(`After adding the records: usesend domains verify ${d.id} --wait`);
  return out.join("\n");
}

/** Accept a numeric id or a domain name. */
export async function resolveDomain(
  client: ApiClient,
  ref: string,
): Promise<Domain> {
  if (/^\d+$/.test(ref)) return client.get<Domain>(`/domains/${ref}`);
  const list = await client.get<Domain[]>("/domains");
  const match = list.find((d) => d.name.toLowerCase() === ref.toLowerCase());
  if (!match) {
    throw new CliError(
      "NOT_FOUND",
      `No domain named "${ref}"`,
      ExitCode.NOT_FOUND,
      `Known domains: ${list.map((d) => `${d.name} (#${d.id})`).join(", ") || "none"}`,
    );
  }
  return client.get<Domain>(`/domains/${match.id}`);
}

function domainSummary(d: Domain): string {
  return renderKv(d as unknown as Record<string, unknown>, [
    "id",
    "name",
    "status",
    "region",
    "dkimStatus",
    "spfDetails",
    "dmarcAdded",
    "isVerifying",
    "verificationError",
    "errorMessage",
    "lastCheckedTime",
    "clickTracking",
    "openTracking",
    "createdAt",
  ]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerDomains(program: Command, ctx: Context) {
  const domains = program
    .command("domains")
    .description("Manage sending domains and their DNS");

  domains
    .command("list")
    .description("List domains with verification status")
    .action(async (_o, cmd: Command) => {
      const list = await ctx.client(optsOf(cmd)).get<Domain[]>("/domains");
      ctx.out.result(list, (l) =>
        renderTable(l as unknown as Record<string, unknown>[], [
          ["id", "id"],
          ["name", "name"],
          ["status", "status"],
          ["region", "region"],
          ["dkimStatus", "dkim"],
          ["spfDetails", "spf"],
          ["isVerifying", "verifying"],
        ]),
      );
    });

  domains
    .command("get <domain>")
    .description("Show a domain (id or name) including DNS record status")
    .action(async (ref: string, _o, cmd: Command) => {
      const d = await resolveDomain(ctx.client(optsOf(cmd)), ref);
      ctx.out.result(
        d,
        (x) => `${domainSummary(x)}\n\n${renderDns(x, "table", false)}`,
      );
    });

  domains
    .command("dns <domain>")
    .description("Print the DNS records to add, in a copy-friendly form")
    .option(
      "--format <format>",
      "blocks | table | bind (zone-file lines)",
      "blocks",
    )
    .option(
      "--postbox",
      "Yandex Cloud Postbox: DKIM TXT as v=DKIM1;h=sha256;k=rsa;p=...",
    )
    .action(async (ref: string, _o, cmd: Command) => {
      const o = optsOf<{ format: string; postbox?: boolean }>(cmd);
      if (!["blocks", "table", "bind"].includes(o.format))
        throw usageError("--format must be blocks, table or bind");
      const d = await resolveDomain(ctx.client(o), ref);
      ctx.out.result(
        {
          domain: d.name,
          id: d.id,
          zone: zoneOf(d),
          status: d.status,
          records: dnsRecordsFor(d, { postbox: o.postbox }),
        },
        () => renderDns(d, o.format, !!o.postbox),
      );
    });

  domains
    .command("create <name>")
    .description("Add a sending domain (e.g. mail.example.com)")
    .requiredOption(
      "--region <region>",
      "provider region, e.g. us-east-1 (must be enabled on the instance)",
    )
    .option("--dry-run", "print the request instead of sending")
    .action(async (name: string, _o, cmd: Command) => {
      const o = optsOf<{ region: string; dryRun?: boolean }>(cmd);
      const body = { name, region: o.region };
      if (o.dryRun)
        return printDryRun(ctx, { method: "POST", path: "/domains", body });
      const d = await ctx.client(o).post<Domain>("/domains", body);
      ctx.out.result(
        d,
        (x) =>
          `Created domain #${x.id} ${x.name}\n\n${renderDns(x, "blocks", false)}`,
      );
    });

  domains
    .command("verify <domain>")
    .description("Start (re-)verification; --wait polls until it finishes")
    .option("--wait", "poll until the domain is verified or failed")
    .option("--wait-timeout <seconds>", "max seconds to wait", "300")
    .action(async (ref: string, _o, cmd: Command) => {
      const o = optsOf<{ wait?: boolean; waitTimeout: string }>(cmd);
      const waitSeconds = Number(o.waitTimeout);
      if (!Number.isFinite(waitSeconds) || waitSeconds <= 0)
        throw usageError("--wait-timeout must be positive seconds");
      const client = ctx.client(o);
      const d = await resolveDomain(client, ref);
      const res = await client.put<{ message: string }>(
        `/domains/${d.id}/verify`,
        {},
      );
      if (!o.wait) {
        return ctx.out.result(
          { id: d.id, name: d.name, ...res },
          () =>
            `${res.message} for ${d.name}. Check: usesend domains get ${d.id} (or re-run with --wait)`,
        );
      }
      const deadline = Date.now() + waitSeconds * 1000;
      let cur = d;
      ctx.out.note(`Verifying ${d.name}…`);
      do {
        await sleep(5000);
        cur = await client.get<Domain>(`/domains/${d.id}`);
        ctx.out.note(
          `  status=${cur.status} dkim=${cur.dkimStatus ?? "-"} spf=${cur.spfDetails ?? "-"} verifying=${cur.isVerifying}`,
        );
      } while (cur.isVerifying && Date.now() < deadline);
      const done = !cur.isVerifying;
      if (cur.status !== "SUCCESS") {
        throw new CliError(
          done ? "DOMAIN_NOT_VERIFIED" : "VERIFY_TIMEOUT",
          done
            ? `${cur.name} is ${cur.status}${cur.verificationError ? `: ${cur.verificationError}` : ""}`
            : `${cur.name} still verifying after ${o.waitTimeout}s (status ${cur.status})`,
          ExitCode.GENERAL,
          `Compare DNS with \`usesend domains dns ${cur.id}\`; DNS can take time to propagate — run verify again later.`,
          {
            id: cur.id,
            status: cur.status,
            dkimStatus: cur.dkimStatus,
            spfDetails: cur.spfDetails,
          },
        );
      }
      ctx.out.result(
        cur,
        (x) => `${x.name} is verified.\n\n${domainSummary(x)}`,
      );
    });

  domains
    .command("delete <domain>")
    .description("Delete a domain (requires --yes)")
    .option("-y, --yes", "confirm deletion")
    .action(async (ref: string, _o, cmd: Command) => {
      const o = optsOf<{ yes?: boolean }>(cmd);
      const client = ctx.client(o);
      const d = await resolveDomain(client, ref);
      requireYes(
        o,
        `Delete domain #${d.id} ${d.name} (status ${d.status}); sending from it will stop`,
        {
          method: "DELETE",
          path: `/domains/${d.id}`,
        },
      );
      const res = await client.delete<{
        id: number;
        success: boolean;
        message: string;
      }>(`/domains/${d.id}`);
      ctx.out.result(res, (x) => `${x.message} (#${x.id})`);
    });
}
