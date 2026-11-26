import crypto from "crypto";

const AES_GCM = "aes-256-gcm";
const CHACHA_POLY = "chacha20-poly1305";
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface OnionContext {
  clientId: string;
  provider: "google" | "deepseek";
}

let ephemeralRootSecret: Buffer | null = null;

function getMasterRootSecret(): Buffer {
  const explicit = (process.env.ENCRYPTION_SECRET || "").trim();
  if (explicit.length >= 16) {
    return crypto.scryptSync(explicit, "onion3-master-root-v1", 32);
  }

  const cfToken = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  const cfAccount = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const cfD1 = (process.env.CLOUDFLARE_D1_DATABASE_ID || "").trim();
  if (cfToken && cfAccount && cfD1) {
    return Buffer.from(
      crypto.hkdfSync(
        "sha512",
        Buffer.from(`${cfToken}:${cfAccount}:${cfD1}`, "utf8"),
        Buffer.from("ai-analyst-cf-d1-root-v1", "utf8"),
        Buffer.from("master-root-key", "utf8"),
        32,
      ),
    );
  }

  if (!ephemeralRootSecret) {
    ephemeralRootSecret = crypto.randomBytes(32);
    console.warn(
      "[crypto] Cloudflare credentials not configured yet; using an ephemeral in-memory master key for this process.",
    );
  }
  return ephemeralRootSecret;
}

export function hasPersistentEncryptionSecret(): boolean {
  const explicit = (process.env.ENCRYPTION_SECRET || "").trim();
  if (explicit.length >= 16) return true;
  return Boolean(
    (process.env.CLOUDFLARE_API_TOKEN || "").trim() &&
      (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim() &&
      (process.env.CLOUDFLARE_D1_DATABASE_ID || "").trim(),
  );
}

function deriveLayerKey(masterRoot: Buffer, userSalt: Buffer, layerIndex: 1 | 2 | 3): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha512",
      masterRoot,
      userSalt,
      Buffer.from(`onion3-layer-${layerIndex}`, "utf8"),
      32,
    ),
  );
}

function buildLayerAad(ctx: OnionContext, layerIndex: 1 | 2 | 3): Buffer {
  return Buffer.from(`${ctx.clientId}:${ctx.provider}:layer${layerIndex}`, "utf8");
}

/**
 * Encrypts a plaintext API key using 3-layer Onion Encryption:
 *   Layer 1 (inner):  AES-256-GCM
 *   Layer 2 (middle): ChaCha20-Poly1305
 *   Layer 3 (outer):  AES-256-GCM
 * Every operation generates a fresh per-user 16-byte salt, fresh 12-byte IVs
 * per layer, independent HKDF-SHA512 subkeys, and per-user/provider AAD bindings.
 */
export function encryptOnionSecret(plaintext: string, ctx: OnionContext): string {
  const trimmed = plaintext.trim();
  if (!trimmed) return "";

  const masterRoot = getMasterRootSecret();
  const userSalt = crypto.randomBytes(SALT_LENGTH);

  const k1 = deriveLayerKey(masterRoot, userSalt, 1);
  const k2 = deriveLayerKey(masterRoot, userSalt, 2);
  const k3 = deriveLayerKey(masterRoot, userSalt, 3);

  // Layer 1: AES-256-GCM
  const iv1 = crypto.randomBytes(IV_LENGTH);
  const c1 = crypto.createCipheriv(AES_GCM, k1, iv1, { authTagLength: AUTH_TAG_LENGTH });
  c1.setAAD(buildLayerAad(ctx, 1));
  const ct1 = Buffer.concat([c1.update(trimmed, "utf8"), c1.final()]);
  const tag1 = c1.getAuthTag();

  // Layer 2: ChaCha20-Poly1305
  const iv2 = crypto.randomBytes(IV_LENGTH);
  const c2 = crypto.createCipheriv(CHACHA_POLY, k2, iv2, { authTagLength: AUTH_TAG_LENGTH });
  c2.setAAD(buildLayerAad(ctx, 2), { plaintextLength: ct1.length });
  const ct2 = Buffer.concat([c2.update(ct1), c2.final()]);
  const tag2 = c2.getAuthTag();

  // Layer 3: AES-256-GCM
  const iv3 = crypto.randomBytes(IV_LENGTH);
  const c3 = crypto.createCipheriv(AES_GCM, k3, iv3, { authTagLength: AUTH_TAG_LENGTH });
  c3.setAAD(buildLayerAad(ctx, 3));
  const ct3 = Buffer.concat([c3.update(ct2), c3.final()]);
  const tag3 = c3.getAuthTag();

  return [
    "onion3",
    userSalt.toString("base64"),
    iv1.toString("base64"),
    tag1.toString("base64"),
    iv2.toString("base64"),
    tag2.toString("base64"),
    iv3.toString("base64"),
    tag3.toString("base64"),
    ct3.toString("base64"),
  ].join(":");
}

/**
 * Peels and authenticates all 3 Onion Encryption layers (Layer 3 -> Layer 2 -> Layer 1)
 * using the bound per-user salt and AAD context.
 */
export function decryptOnionSecret(
  payload: string | null | undefined,
  ctx: OnionContext,
): string | null {
  if (!payload || typeof payload !== "string") return null;
  const parts = payload.split(":");
  if (parts.length !== 9 || parts[0] !== "onion3") return null;

  try {
    const userSalt = Buffer.from(parts[1], "base64");
    const iv1 = Buffer.from(parts[2], "base64");
    const tag1 = Buffer.from(parts[3], "base64");
    const iv2 = Buffer.from(parts[4], "base64");
    const tag2 = Buffer.from(parts[5], "base64");
    const iv3 = Buffer.from(parts[6], "base64");
    const tag3 = Buffer.from(parts[7], "base64");
    const ct3 = Buffer.from(parts[8], "base64");

    if (
      userSalt.length !== SALT_LENGTH ||
      iv1.length !== IV_LENGTH ||
      iv2.length !== IV_LENGTH ||
      iv3.length !== IV_LENGTH ||
      tag1.length !== AUTH_TAG_LENGTH ||
      tag2.length !== AUTH_TAG_LENGTH ||
      tag3.length !== AUTH_TAG_LENGTH
    ) {
      return null;
    }

    const masterRoot = getMasterRootSecret();
    const k1 = deriveLayerKey(masterRoot, userSalt, 1);
    const k2 = deriveLayerKey(masterRoot, userSalt, 2);
    const k3 = deriveLayerKey(masterRoot, userSalt, 3);

    // Peel Layer 3 (AES-256-GCM)
    const d3 = crypto.createDecipheriv(AES_GCM, k3, iv3, { authTagLength: AUTH_TAG_LENGTH });
    d3.setAAD(buildLayerAad(ctx, 3));
    d3.setAuthTag(tag3);
    const ct2 = Buffer.concat([d3.update(ct3), d3.final()]);

    // Peel Layer 2 (ChaCha20-Poly1305)
    const d2 = crypto.createDecipheriv(CHACHA_POLY, k2, iv2, { authTagLength: AUTH_TAG_LENGTH });
    d2.setAAD(buildLayerAad(ctx, 2), { plaintextLength: ct2.length });
    d2.setAuthTag(tag2);
    const ct1 = Buffer.concat([d2.update(ct2), d2.final()]);

    // Peel Layer 1 (AES-256-GCM)
    const d1 = crypto.createDecipheriv(AES_GCM, k1, iv1, { authTagLength: AUTH_TAG_LENGTH });
    d1.setAAD(buildLayerAad(ctx, 1));
    d1.setAuthTag(tag1);
    const plaintext = Buffer.concat([d1.update(ct1), d1.final()]);

    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Returns a safe, non-sensitive display hint for an API key (e.g. `sk-••••9f2a`).
 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "••••••••";
  const prefix = trimmed.slice(0, 4);
  const suffix = trimmed.slice(-4);
  return `${prefix}••••${suffix}`;
}
