import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  maskKey,
  normalizeBaseUrl,
  readConfig,
  resolveSettings,
  writeConfig,
  type ConfigFile,
} from "../src/config";
import { tmpConfig } from "./helpers";

const config: ConfigFile = {
  defaultProfile: "prod",
  profiles: {
    prod: {
      apiKey: "us_prod_key_aaaaaaaa",
      baseUrl: "https://prod.example.com",
    },
    staging: {
      apiKey: "us_stage_key_bbbbbbbb",
      baseUrl: "https://staging.example.com/",
    },
  },
};

describe("resolveSettings precedence", () => {
  it("flags beat env beat config", () => {
    const s = resolveSettings(
      { apiKey: "us_flag_key_cccccccc", baseUrl: "https://flag.example.com" },
      {
        USESEND_API_KEY: "us_env_key_dddddddd",
        USESEND_BASE_URL: "https://env.example.com",
      },
      "/x",
      config,
    );
    expect(s.apiKey).toBe("us_flag_key_cccccccc");
    expect(s.apiKeySource).toBe("flag");
    expect(s.baseUrl).toBe("https://flag.example.com");
    expect(s.baseUrlSource).toBe("flag");
  });

  it("env beats config", () => {
    const s = resolveSettings(
      {},
      {
        USESEND_API_KEY: "us_env_key_dddddddd",
        USESEND_BASE_URL: "https://env.example.com",
      },
      "/x",
      config,
    );
    expect([s.apiKey, s.apiKeySource, s.baseUrl, s.baseUrlSource]).toEqual([
      "us_env_key_dddddddd",
      "env",
      "https://env.example.com",
      "env",
    ]);
  });

  it("falls back to the default profile from the config file", () => {
    const s = resolveSettings({}, {}, "/x", config);
    expect(s.profile).toBe("prod");
    expect(s.profileSource).toBe("config");
    expect(s.apiKey).toBe("us_prod_key_aaaaaaaa");
    expect(s.apiKeySource).toBe("config");
    expect(s.baseUrl).toBe("https://prod.example.com");
  });

  it("selects a profile by flag, then by env", () => {
    expect(
      resolveSettings(
        { profile: "staging" },
        { USESEND_PROFILE: "prod" },
        "/x",
        config,
      ).baseUrl,
    ).toBe("https://staging.example.com");
    const s = resolveSettings({}, { USESEND_PROFILE: "staging" }, "/x", config);
    expect([s.profile, s.profileSource, s.apiKey]).toEqual([
      "staging",
      "env",
      "us_stage_key_bbbbbbbb",
    ]);
  });

  it("uses defaults when nothing is configured", () => {
    const s = resolveSettings({}, {}, "/x", { profiles: {} });
    expect(s.profile).toBe("default");
    expect(s.apiKey).toBeUndefined();
    expect(s.apiKeySource).toBe("none");
    expect(s.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(s.baseUrlSource).toBe("default");
  });
});

describe("config helpers", () => {
  it("normalizes base URLs", () => {
    expect(normalizeBaseUrl("https://x.com/")).toBe("https://x.com");
    expect(normalizeBaseUrl("https://x.com/api/v1/")).toBe("https://x.com");
    expect(() => normalizeBaseUrl("x.com")).toThrow(/http/);
  });

  it.each([
    "http://",
    "https://x.com?key=secret",
    "https://u:p@x.com",
    "file:///tmp/x",
  ])("rejects unsafe base URL %s", (url) => {
    expect(() => normalizeBaseUrl(url)).toThrow(/Invalid base URL/);
  });

  it.each([null, [], { profiles: [] }, { profiles: { work: { apiKey: 1 } } }])(
    "rejects malformed config %j",
    (value) => {
      const file = tmpConfig();
      fs.writeFileSync(file, JSON.stringify(value));
      expect(() => readConfig(file)).toThrow(/Config file/);
    },
  );

  it("masks keys without revealing the secret", () => {
    const key = "us_abc123_supersecrettokenvalue9876";
    const masked = maskKey(key);
    expect(masked).toBe("us_****9876");
    expect(masked).not.toContain("supersecret");
    expect(maskKey(undefined)).toBe("(none)");
    expect(maskKey("short")).toBe("****");
  });

  it("writes the config with mode 0600 and reads it back", () => {
    const file = tmpConfig();
    writeConfig(file, config);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readConfig(file)).toEqual(config);
  });

  it("returns an empty config when the file is missing", () => {
    expect(readConfig(tmpConfig())).toEqual({ profiles: {} });
  });
});
