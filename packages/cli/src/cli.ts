import { Command, CommanderError, Option } from "commander";
import { Context, type Deps } from "./context";
import { ExitCode, usageError } from "./errors";
import { registerAnalytics } from "./commands/analytics";
import { registerAuth } from "./commands/auth";
import { registerCampaigns } from "./commands/campaigns";
import { registerContactBooks, registerContacts } from "./commands/contacts";
import { registerDoctor } from "./commands/doctor";
import { registerDomains } from "./commands/domains";
import { registerEmails } from "./commands/emails";
import { registerSkills } from "./commands/skills";
import { registerWebhooks } from "./commands/webhooks";

declare const __VERSION__: string | undefined;
export const VERSION =
  typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev";

export function buildProgram(ctx: Context): Command {
  const program = new Command("usesend");
  program
    .description(
      "useSend CLI — send email, manage domains, contacts and campaigns. Agents: run `usesend skills get core`.",
    )
    .version(VERSION, "-v, --version")
    .option("--json", "machine-readable output: {ok,data} | {ok:false,error}")
    .option("--profile <name>", "config profile (env: USESEND_PROFILE)")
    .option(
      "--base-url <url>",
      "instance URL, e.g. https://app.usesend.com (env: USESEND_BASE_URL)",
    )
    .addOption(
      new Option(
        "--api-key <key>",
        "API key (prefer `auth login` or USESEND_API_KEY; argv is visible to other processes)",
      ),
    )
    .option("--timeout <seconds>", "HTTP timeout in seconds (default 30)")
    .showHelpAfterError("(run with --help for usage)")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.deps.stdout(s),
      // Commander's own error text is replaced by our formatted error.
      writeErr: (s) => {
        if (!s.startsWith("error:") && !s.startsWith("(run with"))
          ctx.deps.stderr(s);
      },
    });

  registerEmails(program, ctx);
  registerDomains(program, ctx);
  registerContacts(program, ctx);
  registerContactBooks(program, ctx);
  registerCampaigns(program, ctx);
  registerAnalytics(program, ctx);
  registerAuth(program, ctx);
  registerDoctor(program, ctx);
  registerSkills(program, ctx);
  registerWebhooks(program, ctx);

  program.addHelpText(
    "after",
    `
Exit codes: 0 ok, 1 general/server, 2 usage, 3 auth, 4 not found, 5 validation,
            6 rate limited, 7 network, 8 confirmation required (--yes)
Docs for agents: usesend skills list | usesend skills get core`,
  );
  return program;
}

/** Run the CLI and return the process exit code (never calls process.exit). */
export async function run(argv: string[], deps: Deps): Promise<number> {
  const json = argv.includes("--json");
  const ctx = new Context(deps, json);
  const program = buildProgram(ctx);
  try {
    await program.parseAsync(argv, { from: "user" });
    return ExitCode.OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.version" ||
        err.code === "commander.help"
      ) {
        return ExitCode.OK;
      }
      if (err.code === "commander.executeSubCommandAsync")
        return ExitCode.GENERAL;
      // Bare `usesend emails` etc.: help was printed to stderr.
      const message = err.message.replace(/^error:\s*/, "");
      if (
        err.code === "commander.missingMandatoryOptionValue" ||
        err.code === "commander.unknownCommand" ||
        err.code === "commander.unknownOption" ||
        err.code === "commander.missingArgument" ||
        err.code === "commander.excessArguments" ||
        err.code === "commander.optionMissingArgument" ||
        err.code === "commander.invalidArgument" ||
        err.code === "commander.conflictingOption"
      ) {
        return ctx.out.error(usageError(message, "Run with --help for usage."));
      }
      return err.exitCode === 0
        ? ExitCode.OK
        : ctx.out.error(
            usageError(
              message || "Missing command",
              "Run with --help for usage.",
            ),
          );
    }
    return ctx.out.error(err);
  }
}
