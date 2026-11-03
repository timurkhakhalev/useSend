import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ NEXTAUTH_SECRET: "secret-a" }));
vi.mock("~/env", () => ({ env }));

import { decryptSecret, encryptSecret } from "~/server/utils/secret-encryption";

describe("secret encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret("private-key", "purpose");
    const b = encryptSecret("private-key", "purpose");

    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toContain("private-key");
    expect(decryptSecret(a, "purpose")).toBe("private-key");
  });

  it("fails for another purpose, another secret or tampered data", () => {
    const value = encryptSecret("private-key", "purpose");

    expect(() => decryptSecret(value, "other")).toThrow();

    const [v, iv, tag, data] = value.split(":");
    const flipped = Buffer.from(data!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() =>
      decryptSecret(
        [v, iv, tag, flipped.toString("base64")].join(":"),
        "purpose",
      ),
    ).toThrow();

    env.NEXTAUTH_SECRET = "secret-b";
    expect(() => decryptSecret(value, "purpose")).toThrow();
    env.NEXTAUTH_SECRET = "secret-a";
  });

  it("rejects unknown formats", () => {
    expect(() => decryptSecret("plain", "purpose")).toThrow(
      "Unsupported encrypted secret format",
    );
  });
});
