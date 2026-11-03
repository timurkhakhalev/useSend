import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, ExitCode } from "./errors";

export const DEFAULT_BASE_URL = "https://app.usesend.com";
export const DEFAULT_PROFILE = "default";

export type Profile = {
  apiKey?: string;
  baseUrl?: string;
};

export type ConfigFile = {
  defaultProfile?: string;
  profiles: Record<string, Profile>;
};

export type Source = "flag" | "env" | "config" | "default" | "none";

export type ResolvedSettings = {
  profile: string;
  profileSource: Source;
  apiKey?: string;
  apiKeySource: Source;
  baseUrl: string;
  baseUrlSource: Source;
  configPath: string;
};

export type GlobalFlags = {
  apiKey?: string;
  baseUrl?: string;
  profile?: string;
};

export type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env): string {
  if (env.USESEND_CONFIG) return env.USESEND_CONFIG;
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : path.join(env.HOME ?? os.homedir(), ".config");
  return path.join(base, "usesend", "cli.json");
}

export function readConfig(file: string): ConfigFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { profiles: Object.create(null) as Record<string, Profile> };
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ConfigFile>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed.defaultProfile !== undefined &&
        typeof parsed.defaultProfile !== "string") ||
      (parsed.profiles !== undefined &&
        (!parsed.profiles ||
          typeof parsed.profiles !== "object" ||
          Array.isArray(parsed.profiles)))
    ) {
      throw new Error("Invalid config shape");
    }
    for (const profile of Object.values(parsed.profiles ?? {})) {
      if (
        !profile ||
        typeof profile !== "object" ||
        Array.isArray(profile) ||
        (profile.apiKey !== undefined && typeof profile.apiKey !== "string") ||
        (profile.baseUrl !== undefined && typeof profile.baseUrl !== "string")
      ) {
        throw new Error("Invalid profile");
      }
    }
    return {
      defaultProfile: parsed.defaultProfile,
      profiles: Object.assign(Object.create(null), parsed.profiles ?? {}),
    };
  } catch {
    throw new CliError(
      "CONFIG_INVALID",
      `Config file ${file} must be valid JSON with a profiles object containing string apiKey/baseUrl values`,
      ExitCode.USAGE,
      "Fix or delete the file, then run `usesend auth login` again.",
    );
  }
}

/** Write the config atomically with owner-only permissions (0600). */
export function writeConfig(file: string, config: ConfigFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  // Accept URLs copied with the API prefix, e.g. https://host/api/v1
  u = u.replace(/\/api\/v1$/, "").replace(/\/api$/, "");
  let parsed: URL | undefined;
  try {
    parsed = new URL(u);
  } catch {
    /* reported below */
  }
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new CliError(
      "USAGE",
      "Invalid base URL: use an http:// or https:// URL without credentials, query or fragment",
      ExitCode.USAGE,
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * Precedence: flags > environment > config file profile > defaults.
 */
export function resolveSettings(
  flags: GlobalFlags,
  env: Env = process.env,
  file: string = configPath(env),
  config: ConfigFile = readConfig(file),
): ResolvedSettings {
  let profile: string;
  let profileSource: Source;
  if (flags.profile) {
    profile = flags.profile;
    profileSource = "flag";
  } else if (env.USESEND_PROFILE) {
    profile = env.USESEND_PROFILE;
    profileSource = "env";
  } else if (config.defaultProfile) {
    profile = config.defaultProfile;
    profileSource = "config";
  } else {
    profile = DEFAULT_PROFILE;
    profileSource = "default";
  }

  const stored = config.profiles[profile] ?? {};

  let apiKey: string | undefined;
  let apiKeySource: Source = "none";
  if (flags.apiKey) {
    apiKey = flags.apiKey;
    apiKeySource = "flag";
  } else if (env.USESEND_API_KEY) {
    apiKey = env.USESEND_API_KEY;
    apiKeySource = "env";
  } else if (stored.apiKey) {
    apiKey = stored.apiKey;
    apiKeySource = "config";
  }

  let baseUrl: string;
  let baseUrlSource: Source;
  if (flags.baseUrl) {
    baseUrl = flags.baseUrl;
    baseUrlSource = "flag";
  } else if (env.USESEND_BASE_URL) {
    baseUrl = env.USESEND_BASE_URL;
    baseUrlSource = "env";
  } else if (stored.baseUrl) {
    baseUrl = stored.baseUrl;
    baseUrlSource = "config";
  } else {
    baseUrl = DEFAULT_BASE_URL;
    baseUrlSource = "default";
  }

  return {
    profile,
    profileSource,
    apiKey: apiKey?.trim() || undefined,
    apiKeySource,
    baseUrl: normalizeBaseUrl(baseUrl),
    baseUrlSource,
    configPath: file,
  };
}

/** Show enough of the key to recognise it, never enough to use it. */
export function maskKey(key: string | undefined): string {
  if (!key) return "(none)";
  if (key.length <= 8) return "****";
  const prefix = key.startsWith("us_") ? "us_" : key.slice(0, 2);
  return `${prefix}****${key.slice(-4)}`;
}

export function configPermissionsOk(file: string): boolean | undefined {
  try {
    const st = fs.statSync(file);
    if (process.platform === "win32") return true;
    return (st.mode & 0o077) === 0;
  } catch {
    return undefined;
  }
}
