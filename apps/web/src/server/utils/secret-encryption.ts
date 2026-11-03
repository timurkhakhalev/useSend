import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "crypto";
import { env } from "~/env";

/**
 * Encrypts small secrets at rest (e.g. DKIM private keys) with AES-256-GCM.
 *
 * The key is derived from NEXTAUTH_SECRET with HKDF and a per-purpose label,
 * so rotating NEXTAUTH_SECRET makes stored values unreadable: callers must
 * treat a failed decryption as "no stored secret".
 *
 * Format: `v1:<iv base64>:<auth tag base64>:<ciphertext base64>`.
 */

const VERSION = "v1";
const IV_LENGTH = 12;

function deriveKey(purpose: string, secret = env.NEXTAUTH_SECRET) {
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is required to encrypt secrets");
  }
  return Buffer.from(
    hkdfSync("sha256", secret, "usesend-secret-encryption", purpose, 32),
  );
}

export function encryptSecret(plaintext: string, purpose: string) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(purpose), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(value: string, purpose: string) {
  const [version, iv, tag, ciphertext] = value.split(":");
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error("Unsupported encrypted secret format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(purpose),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
