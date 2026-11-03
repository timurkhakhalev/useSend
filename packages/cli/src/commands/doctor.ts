import fs from "node:fs";
import { Command } from "commander";
import { ApiClient } from "../api";
import { configPermissionsOk, maskKey } from "../config";
import { optsOf, timeoutMs, type Context } from "../context";
import { CliError, ExitCode, type ExitCodeValue } from "../errors";
import type { Domain } from "./domains";

export type Check = {
  name: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  hint?: string;
};

const ICON = { ok: "✓", warn: "!", fail: "✗", skip: "-" } as const;

export function registerDoctor(program: Command, ctx: Context) {
  program
    .command("doctor")
    .description("Check config, reachability, auth and domain verification")
    .action(async (_o, cmd: Command) => {
      const o = optsOf(cmd);
      const checks: Check[] = [];
      let failExit: ExitCodeValue | undefined;
      const fail = (c: Omit<Check, "status">, exit: ExitCodeValue) => {
        checks.push({ ...c, status: "fail" });
        failExit ??= exit;
      };

      const s = ctx.settings(o);
      const exists = fs.existsSync(s.configPath);
      const perms = configPermissionsOk(s.configPath);
      if (!exists) {
        checks.push({
          name: "config",
          status: "warn",
          detail: `${s.configPath} does not exist`,
          hint: "Run `usesend auth login` to create it.",
        });
      } else if (perms === false) {
        checks.push({
          name: "config",
          status: "warn",
          detail: `${s.configPath} is readable by others`,
          hint: `chmod 600 ${s.configPath}`,
        });
      } else {
        checks.push({
          name: "config",
          status: "ok",
          detail: `${s.configPath} (profile "${s.profile}", from ${s.profileSource})`,
        });
      }

      if (s.apiKey) {
        checks.push({
          name: "api-key",
          status: "ok",
          detail: `${maskKey(s.apiKey)} (from ${s.apiKeySource})`,
        });
      } else {
        fail(
          {
            name: "api-key",
            detail: "no API key found",
            hint: "Run `usesend auth login` or set USESEND_API_KEY.",
          },
          ExitCode.AUTH,
        );
      }

      const client = new ApiClient(
        s.baseUrl,
        s.apiKey,
        ctx.deps.fetch,
        timeoutMs(o),
      );
      let reachable = false;
      try {
        await client.get("/api/health", { raw: true, noAuth: true });
        reachable = true;
        checks.push({
          name: "reachability",
          status: "ok",
          detail: `${s.baseUrl} is up (from ${s.baseUrlSource})`,
        });
      } catch (err) {
        const e = err as CliError;
        fail(
          { name: "reachability", detail: e.message, hint: e.hint },
          e.exitCode,
        );
      }

      let domains: Domain[] | undefined;
      if (reachable && s.apiKey) {
        try {
          domains = await client.get<Domain[]>("/domains");
          checks.push({
            name: "auth",
            status: "ok",
            detail: `key accepted, ${domains.length} domain(s) visible`,
          });
        } catch (err) {
          const e = err as CliError;
          fail(
            { name: "auth", detail: `${e.code}: ${e.message}`, hint: e.hint },
            e.exitCode,
          );
        }
      } else {
        checks.push({ name: "auth", status: "skip", detail: "skipped" });
      }

      if (domains) {
        if (domains.length === 0) {
          checks.push({
            name: "domains",
            status: "warn",
            detail: "no domains",
            hint: "usesend domains create <name> --region <region>",
          });
        }
        for (const d of domains) {
          const ok = d.status === "SUCCESS";
          checks.push({
            name: `domain ${d.name}`,
            status: ok ? "ok" : "warn",
            detail: `#${d.id} ${d.status} (dkim ${d.dkimStatus ?? "-"}, spf ${d.spfDetails ?? "-"}${d.isVerifying ? ", verifying" : ""})`,
            hint: ok
              ? undefined
              : `usesend domains dns ${d.id} ; then usesend domains verify ${d.id} --wait`,
          });
        }
      }

      const summary = {
        baseUrl: s.baseUrl,
        profile: s.profile,
        ok: failExit === undefined,
        failures: checks.filter((c) => c.status === "fail").length,
        warnings: checks.filter((c) => c.status === "warn").length,
      };
      if (failExit !== undefined) {
        if (!ctx.out.json) printChecks(ctx, checks);
        const first = checks.find((c) => c.status === "fail")!;
        throw new CliError(
          "DOCTOR_FAILED",
          `${first.name}: ${first.detail}`,
          failExit,
          first.hint,
          { checks, summary },
        );
      }
      ctx.out.result({ checks, summary }, () => {
        printChecks(ctx, checks);
        return `\nAll good${summary.warnings ? ` (${summary.warnings} warning(s))` : ""}.`;
      });
    });
}

function printChecks(ctx: Context, checks: Check[]) {
  const lines = checks.map(
    (c) =>
      `${ICON[c.status]} ${c.name.padEnd(14)} ${c.detail}${c.hint ? `\n    → ${c.hint}` : ""}`,
  );
  ctx.deps.stdout(lines.join("\n") + "\n");
}
