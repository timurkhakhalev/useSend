import { Command } from "commander";
import { ApiClient } from "../api";
import {
  DEFAULT_BASE_URL,
  DEFAULT_PROFILE,
  configPath,
  maskKey,
  normalizeBaseUrl,
  readConfig,
  resolveSettings,
  writeConfig,
} from "../config";
import { optsOf, timeoutMs, type Context } from "../context";
import { CliError, ExitCode, usageError } from "../errors";
import { renderKv, renderTable } from "../output";

export function registerAuth(program: Command, ctx: Context) {
  const auth = program
    .command("auth")
    .description("Store, inspect and remove API keys (named profiles)");

  auth
    .command("login")
    .description(
      "Save an API key. Reads it from stdin (piped) or prompts without echo — never from argv",
    )
    .option("--no-verify", "save without checking the key against the API")
    .option("--default", "make this profile the default")
    .addHelpText(
      "after",
      `
Examples:
  printf %s "$KEY" | usesend auth login --base-url https://usesend.example.com
  usesend auth login --profile staging        # prompts for the key
  pass show usesend | usesend auth login --profile prod --default`,
    )
    .action(async (_o, cmd: Command) => {
      const o = optsOf<{ verify: boolean; default?: boolean }>(cmd);
      if (o.apiKey) {
        throw usageError(
          "`auth login` does not accept --api-key (it would leak into shell history and process lists)",
          'Pipe the key on stdin: printf %s "$KEY" | usesend auth login',
        );
      }
      const file = configPath(ctx.env);
      const config = readConfig(file);
      const profile =
        o.profile ??
        ctx.env.USESEND_PROFILE ??
        config.defaultProfile ??
        DEFAULT_PROFILE;
      const baseUrl = normalizeBaseUrl(
        o.baseUrl ??
          ctx.env.USESEND_BASE_URL ??
          config.profiles[profile]?.baseUrl ??
          DEFAULT_BASE_URL,
      );

      let key: string;
      if (ctx.deps.stdin.isTTY) {
        if (!ctx.deps.promptSecret)
          throw usageError("No TTY prompt available; pipe the key on stdin");
        key = await ctx.deps.promptSecret(
          `API key for ${baseUrl} (input hidden): `,
        );
      } else {
        key = await ctx.readStdin();
      }
      key = key.trim();
      if (!key)
        throw usageError(
          "No API key received on stdin",
          'Pipe it: printf %s "$KEY" | usesend auth login',
        );
      if (/\s/.test(key))
        throw usageError("API key must not contain whitespace");

      let domains: number | undefined;
      if (o.verify) {
        const client = new ApiClient(
          baseUrl,
          key,
          ctx.deps.fetch,
          timeoutMs(o),
        );
        const list = await client.get<unknown[]>("/domains");
        domains = Array.isArray(list) ? list.length : undefined;
      }

      config.profiles[profile] = { apiKey: key, baseUrl };
      if (!config.defaultProfile || o.default) config.defaultProfile = profile;
      writeConfig(file, config);

      const data = {
        profile,
        baseUrl,
        apiKey: maskKey(key),
        configPath: file,
        default: config.defaultProfile === profile,
        verified: o.verify,
        domains,
      };
      ctx.out.result(data, (d) =>
        [
          `Saved profile "${d.profile}" → ${d.baseUrl} (key ${d.apiKey})`,
          d.verified
            ? `Key verified: ${d.domains} domain(s) visible.`
            : "Key NOT verified (--no-verify).",
          d.default
            ? "This is the default profile."
            : `Use it with --profile ${d.profile} or \`usesend auth use ${d.profile}\`.`,
        ].join("\n"),
      );
    });

  auth
    .command("status")
    .description(
      "Show the active profile, where each setting comes from, and the masked key",
    )
    .option("--check", "also call the API to confirm the key works")
    .action(async (_o, cmd: Command) => {
      const o = optsOf<{ check?: boolean }>(cmd);
      const s = resolveSettings(
        { apiKey: o.apiKey, baseUrl: o.baseUrl, profile: o.profile },
        ctx.env,
      );
      const config = readConfig(s.configPath);
      const profiles = Object.entries(config.profiles).map(([name, p]) => ({
        name,
        default: name === config.defaultProfile,
        baseUrl: p.baseUrl ?? DEFAULT_BASE_URL,
        apiKey: maskKey(p.apiKey),
      }));
      const data: Record<string, unknown> = {
        profile: s.profile,
        profileSource: s.profileSource,
        baseUrl: s.baseUrl,
        baseUrlSource: s.baseUrlSource,
        apiKey: maskKey(s.apiKey),
        apiKeySource: s.apiKeySource,
        configPath: s.configPath,
        profiles,
      };
      if (!s.apiKey) {
        throw new CliError(
          "NO_API_KEY",
          `No API key for profile "${s.profile}"`,
          ExitCode.AUTH,
          "Run `usesend auth login` (key on stdin) or set USESEND_API_KEY.",
          data,
        );
      }
      if (o.check) {
        const client = new ApiClient(
          s.baseUrl,
          s.apiKey,
          ctx.deps.fetch,
          timeoutMs(o),
        );
        const list = await client.get<unknown[]>("/domains");
        data.verified = true;
        data.domains = Array.isArray(list) ? list.length : undefined;
      }
      ctx.out.result(data, (d) => {
        const lines = [
          renderKv({
            profile: `${d.profile} (${d.profileSource})`,
            baseUrl: `${d.baseUrl} (${d.baseUrlSource})`,
            apiKey: `${d.apiKey} (${d.apiKeySource})`,
            config: d.configPath,
            ...(o.check ? { check: `ok, ${d.domains} domain(s) visible` } : {}),
          }),
        ];
        if (profiles.length) {
          lines.push(
            "",
            "Profiles:",
            renderTable(profiles, [
              ["name", "name"],
              ["default", "default"],
              ["baseUrl", "baseUrl"],
              ["apiKey", "apiKey"],
            ]),
          );
        }
        return lines.join("\n");
      });
    });

  auth
    .command("logout")
    .description("Remove the stored key of a profile (or --all)")
    .option("--all", "remove every profile")
    .action(async (_o, cmd: Command) => {
      const o = optsOf<{ all?: boolean }>(cmd);
      const file = configPath(ctx.env);
      const config = readConfig(file);
      let removed: string[];
      if (o.all) {
        removed = Object.keys(config.profiles);
        config.profiles = {};
        delete config.defaultProfile;
      } else {
        const profile =
          o.profile ??
          ctx.env.USESEND_PROFILE ??
          config.defaultProfile ??
          DEFAULT_PROFILE;
        if (!config.profiles[profile]) {
          throw new CliError(
            "NOT_FOUND",
            `No stored profile "${profile}"`,
            ExitCode.NOT_FOUND,
            "See `usesend auth status`.",
          );
        }
        delete config.profiles[profile];
        if (config.defaultProfile === profile) {
          const next = Object.keys(config.profiles)[0];
          if (next) config.defaultProfile = next;
          else delete config.defaultProfile;
        }
        removed = [profile];
      }
      writeConfig(file, config);
      const envNote = ctx.env.USESEND_API_KEY
        ? "USESEND_API_KEY is still set in the environment."
        : undefined;
      ctx.out.result(
        {
          removed,
          defaultProfile: config.defaultProfile ?? null,
          note: envNote,
        },
        (d) =>
          [`Removed: ${d.removed.join(", ") || "(nothing)"}`, envNote]
            .filter(Boolean)
            .join("\n"),
      );
    });

  auth
    .command("use <profile>")
    .description("Set the default profile")
    .action(async (profile: string) => {
      const file = configPath(ctx.env);
      const config = readConfig(file);
      if (!config.profiles[profile]) {
        throw new CliError(
          "NOT_FOUND",
          `No stored profile "${profile}"`,
          ExitCode.NOT_FOUND,
          `Known: ${Object.keys(config.profiles).join(", ") || "none"}`,
        );
      }
      config.defaultProfile = profile;
      writeConfig(file, config);
      ctx.out.result(
        { defaultProfile: profile },
        () => `Default profile: ${profile}`,
      );
    });
}
