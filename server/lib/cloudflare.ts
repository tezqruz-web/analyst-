import crypto from "crypto";
import {
  decryptOnionSecret,
  encryptOnionSecret,
  hasPersistentEncryptionSecret,
  maskApiKey,
} from "./crypto.ts";

export type AiProvider = "google" | "deepseek";

export const ALLOWED_MODELS: Record<AiProvider, readonly string[]> = {
  google: ["gemini-4-hydrogen", "gemini-3.1-flash-lite", "gemini-managed-agent"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
} as const;

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  google: "gemini-4-hydrogen",
  deepseek: "deepseek-chat",
};

export interface StoredUserSettings {
  clientId: string;
  provider: AiProvider;
  model: string;
  googleApiKeyEnc: string | null;
  googleKeyHint: string | null;
  deepseekApiKeyEnc: string | null;
  deepseekKeyHint: string | null;
  updatedAt: string;
}

export interface PublicUserSettings {
  provider: AiProvider;
  model: string;
  hasGoogleKey: boolean;
  googleKeyHint: string | null;
  hasDeepseekKey: boolean;
  deepseekKeyHint: string | null;
  storage: CloudflareStatus;
}

export interface CloudflareStatus {
  d1: boolean;
  kv: boolean;
  r2: boolean;
  encryptionConfigured: boolean;
}

export interface AnalysisHistoryItem {
  id: string;
  clientId: string;
  provider: AiProvider;
  model: string;
  datasetName: string;
  question: string;
  r2Keys: string[];
  createdAt: string;
}

function getCfCoreConfig() {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const apiToken = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  const d1DatabaseId = (process.env.CLOUDFLARE_D1_DATABASE_ID || "").trim();
  const kvNamespaceId = (process.env.CLOUDFLARE_KV_NAMESPACE_ID || "").trim();
  return { accountId, apiToken, d1DatabaseId, kvNamespaceId };
}

function getCfR2Config() {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const bucketName = (process.env.CLOUDFLARE_R2_BUCKET_NAME || "").trim();
  const accessKeyId = (process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || "").trim();
  const explicitEndpoint = (process.env.CLOUDFLARE_R2_ENDPOINT || "").trim().replace(/\/+$/, "");
  const endpoint =
    explicitEndpoint ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

  const enabled = Boolean(bucketName && accessKeyId && secretAccessKey && endpoint);
  return { enabled, bucketName, accessKeyId, secretAccessKey, endpoint };
}

export function getCloudflareStatus(): CloudflareStatus {
  const { accountId, apiToken, d1DatabaseId, kvNamespaceId } = getCfCoreConfig();
  const r2 = getCfR2Config();
  return {
    d1: Boolean(accountId && apiToken && d1DatabaseId),
    kv: Boolean(accountId && apiToken && kvNamespaceId),
    r2: r2.enabled,
    encryptionConfigured: hasPersistentEncryptionSecret(),
  };
}

export function isValidProvider(val: unknown): val is AiProvider {
  return val === "google" || val === "deepseek";
}

export function normalizeModel(provider: AiProvider, model: unknown): string {
  if (typeof model === "string" && ALLOWED_MODELS[provider].includes(model)) {
    return model;
  }
  return DEFAULT_MODELS[provider];
}

/* ────────────────────────────────────────────────────────── */
/*  Cloudflare D1 REST Client (Parameterized SQL only)         */
/* ────────────────────────────────────────────────────────── */

let d1SchemaInitialized = false;

async function d1Query<T = Record<string, unknown>>(
  sql: string,
  params: Array<string | number | null> = [],
): Promise<T[] | null> {
  const { accountId, apiToken, d1DatabaseId } = getCfCoreConfig();
  if (!accountId || !apiToken || !d1DatabaseId) return null;

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(d1DatabaseId)}/query`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Cloudflare D1 HTTP ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data: any = await response.json();
  if (!data?.success) {
    const msg = data?.errors?.[0]?.message || "Unknown D1 error";
    throw new Error(`Cloudflare D1 error: ${msg}`);
  }

  const firstResult = Array.isArray(data.result) ? data.result[0] : data.result;
  return (firstResult?.results as T[]) ?? [];
}

async function ensureD1Schema(): Promise<void> {
  if (d1SchemaInitialized) return;
  const status = getCloudflareStatus();
  if (!status.d1) return;

  await d1Query(`
    CREATE TABLE IF NOT EXISTS user_ai_settings (
      client_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'google',
      model TEXT NOT NULL DEFAULT 'gemini-4-hydrogen',
      google_api_key_enc TEXT,
      google_key_hint TEXT,
      deepseek_api_key_enc TEXT,
      deepseek_key_hint TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  await d1Query(`
    CREATE TABLE IF NOT EXISTS analysis_history (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dataset_name TEXT NOT NULL,
      question TEXT NOT NULL,
      r2_keys_json TEXT,
      created_at TEXT NOT NULL
    )
  `);

  d1SchemaInitialized = true;
}

/* ────────────────────────────────────────────────────────── */
/*  Cloudflare KV REST Client                                  */
/* ────────────────────────────────────────────────────────── */

export async function kvGet<T = unknown>(key: string): Promise<T | null> {
  const { accountId, apiToken, kvNamespaceId } = getCfCoreConfig();
  if (!accountId || !apiToken || !kvNamespaceId) return null;

  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(kvNamespaceId)}/values/${encodeURIComponent(key)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (response.status === 404 || !response.ok) return null;
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch (err) {
    console.warn(`[cloudflare-kv] Failed to read key "${key}":`, err);
    return null;
  }
}

export async function kvPut(
  key: string,
  value: unknown,
  expirationTtlSeconds = 86400,
): Promise<boolean> {
  const { accountId, apiToken, kvNamespaceId } = getCfCoreConfig();
  if (!accountId || !apiToken || !kvNamespaceId) return false;

  try {
    const ttl = Math.max(60, Math.floor(expirationTtlSeconds));
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(kvNamespaceId)}/values/${encodeURIComponent(key)}?expiration_ttl=${ttl}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
    return response.ok;
  } catch (err) {
    console.warn(`[cloudflare-kv] Failed to write key "${key}":`, err);
    return false;
  }
}

export async function kvDelete(key: string): Promise<boolean> {
  const { accountId, apiToken, kvNamespaceId } = getCfCoreConfig();
  if (!accountId || !apiToken || !kvNamespaceId) return false;

  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(kvNamespaceId)}/values/${encodeURIComponent(key)}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    return response.ok;
  } catch (err) {
    console.warn(`[cloudflare-kv] Failed to delete key "${key}":`, err);
    return false;
  }
}

/* ────────────────────────────────────────────────────────── */
/*  Cloudflare R2 S3-Compatible Client (AWS SigV4)             */
/* ────────────────────────────────────────────────────────── */

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function encodeR2Path(objectKey: string): string {
  return objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function signedR2Fetch(
  method: "PUT" | "GET" | "DELETE",
  objectKey: string,
  body?: Buffer,
  contentType = "application/octet-stream",
): Promise<Response | null> {
  const cfg = getCfR2Config();
  if (!cfg.enabled) return null;

  const parsedEndpoint = new URL(cfg.endpoint);
  if (parsedEndpoint.protocol !== "https:" && parsedEndpoint.protocol !== "http:") {
    throw new Error("Invalid CLOUDFLARE_R2_ENDPOINT protocol.");
  }

  const canonicalUri = `/${encodeURIComponent(cfg.bucketName)}/${encodeR2Path(objectKey)}`;
  const targetUrl = `${parsedEndpoint.origin}${canonicalUri}`;
  const host = parsedEndpoint.host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";

  const payloadHash = sha256Hex(body ?? "");
  const headersToSign: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (method === "PUT") {
    headersToSign["content-type"] = contentType;
  }

  const sortedHeaderKeys = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${headersToSign[k]}\n`)
    .join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const fetchHeaders: Record<string, string> = {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    Authorization: authorization,
  };
  if (method === "PUT") {
    fetchHeaders["Content-Type"] = contentType;
  }

  return fetch(targetUrl, {
    method,
    headers: fetchHeaders,
    body: body ? new Uint8Array(body) : undefined,
    redirect: "error",
  });
}

export async function r2PutObject(
  objectKey: string,
  buffer: Buffer,
  contentType = "application/octet-stream",
): Promise<string | null> {
  try {
    const res = await signedR2Fetch("PUT", objectKey, buffer, contentType);
    if (!res) return null;
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[cloudflare-r2] PUT ${objectKey} failed (${res.status}): ${errText.slice(0, 200)}`);
      return null;
    }
    return objectKey;
  } catch (err) {
    console.warn(`[cloudflare-r2] PUT error for ${objectKey}:`, err);
    return null;
  }
}

export async function r2GetObject(objectKey: string): Promise<Buffer | null> {
  try {
    const res = await signedR2Fetch("GET", objectKey);
    if (!res || !res.ok) return null;
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } catch (err) {
    console.warn(`[cloudflare-r2] GET error for ${objectKey}:`, err);
    return null;
  }
}

export async function r2DeleteObject(objectKey: string): Promise<boolean> {
  try {
    const res = await signedR2Fetch("DELETE", objectKey);
    return Boolean(res && (res.ok || res.status === 404));
  } catch (err) {
    console.warn(`[cloudflare-r2] DELETE error for ${objectKey}:`, err);
    return false;
  }
}

/* ────────────────────────────────────────────────────────── */
/*  Local Encrypted Fallback Store (when D1 isn't set yet)     */
/* ────────────────────────────────────────────────────────── */

const memorySettings = new Map<string, StoredUserSettings>();
const memoryHistory = new Map<string, AnalysisHistoryItem[]>();

function makeDefaultSettings(clientId: string): StoredUserSettings {
  return {
    clientId,
    provider: "google",
    model: DEFAULT_MODELS.google,
    googleApiKeyEnc: null,
    googleKeyHint: null,
    deepseekApiKeyEnc: null,
    deepseekKeyHint: null,
    updatedAt: new Date().toISOString(),
  };
}

export function toPublicSettings(stored: StoredUserSettings): PublicUserSettings {
  return {
    provider: stored.provider,
    model: stored.model,
    hasGoogleKey: Boolean(stored.googleApiKeyEnc),
    googleKeyHint: stored.googleKeyHint,
    hasDeepseekKey: Boolean(stored.deepseekApiKeyEnc),
    deepseekKeyHint: stored.deepseekKeyHint,
    storage: getCloudflareStatus(),
  };
}

/**
 * Loads user AI provider settings (KV cache -> D1 encrypted DB -> in-memory fallback).
 */
export async function getUserSettings(clientId: string): Promise<StoredUserSettings> {
  const status = getCloudflareStatus();
  const kvKey = `settings:${clientId}`;

  // 1. Check in-memory warm cache first if D1 is not configured
  if (!status.d1) {
    return memorySettings.get(clientId) ?? makeDefaultSettings(clientId);
  }

  // 2. Check Cloudflare KV cache for fast read (non-blocking fallback to D1)
  if (status.kv) {
    const cached = await kvGet<StoredUserSettings>(kvKey);
    if (cached && cached.clientId === clientId) {
      return cached;
    }
  }

  // 3. Query Cloudflare D1
  try {
    await ensureD1Schema();
    const rows = await d1Query<{
      client_id: string;
      provider: string;
      model: string;
      google_api_key_enc: string | null;
      google_key_hint: string | null;
      deepseek_api_key_enc: string | null;
      deepseek_key_hint: string | null;
      updated_at: string;
    }>(
      `SELECT client_id, provider, model, google_api_key_enc, google_key_hint,
              deepseek_api_key_enc, deepseek_key_hint, updated_at
         FROM user_ai_settings
        WHERE client_id = ?`,
      [clientId],
    );

    if (rows && rows.length > 0) {
      const row = rows[0];
      const provider: AiProvider = isValidProvider(row.provider) ? row.provider : "google";
      const settings: StoredUserSettings = {
        clientId: row.client_id,
        provider,
        model: normalizeModel(provider, row.model),
        googleApiKeyEnc: row.google_api_key_enc || null,
        googleKeyHint: row.google_key_hint || null,
        deepseekApiKeyEnc: row.deepseek_api_key_enc || null,
        deepseekKeyHint: row.deepseek_key_hint || null,
        updatedAt: row.updated_at || new Date().toISOString(),
      };
      if (status.kv) {
        kvPut(kvKey, settings, 3600).catch(() => {});
      }
      return settings;
    }
  } catch (err) {
    console.error("[cloudflare-d1] Failed to load user settings, using fallback:", err);
    return memorySettings.get(clientId) ?? makeDefaultSettings(clientId);
  }

  return makeDefaultSettings(clientId);
}

export interface UpdateSettingsInput {
  provider?: AiProvider;
  model?: string;
  googleApiKey?: string | null; // undefined = keep existing, "" or null = clear, non-empty = encrypt & save
  deepseekApiKey?: string | null;
}

export async function saveUserSettings(
  clientId: string,
  input: UpdateSettingsInput,
): Promise<StoredUserSettings> {
  const existing = await getUserSettings(clientId);
  const nextProvider: AiProvider = isValidProvider(input.provider)
    ? input.provider
    : existing.provider;
  const nextModel = normalizeModel(
    nextProvider,
    input.model !== undefined ? input.model : existing.model,
  );

  let googleApiKeyEnc = existing.googleApiKeyEnc;
  let googleKeyHint = existing.googleKeyHint;
  if (input.googleApiKey !== undefined) {
    const trimmed = typeof input.googleApiKey === "string" ? input.googleApiKey.trim() : "";
    if (!trimmed) {
      googleApiKeyEnc = null;
      googleKeyHint = null;
    } else {
      googleApiKeyEnc = encryptOnionSecret(trimmed, { clientId, provider: "google" });
      googleKeyHint = maskApiKey(trimmed);
    }
  }

  let deepseekApiKeyEnc = existing.deepseekApiKeyEnc;
  let deepseekKeyHint = existing.deepseekKeyHint;
  if (input.deepseekApiKey !== undefined) {
    const trimmed = typeof input.deepseekApiKey === "string" ? input.deepseekApiKey.trim() : "";
    if (!trimmed) {
      deepseekApiKeyEnc = null;
      deepseekKeyHint = null;
    } else {
      deepseekApiKeyEnc = encryptOnionSecret(trimmed, { clientId, provider: "deepseek" });
      deepseekKeyHint = maskApiKey(trimmed);
    }
  }

  const updated: StoredUserSettings = {
    clientId,
    provider: nextProvider,
    model: nextModel,
    googleApiKeyEnc,
    googleKeyHint,
    deepseekApiKeyEnc,
    deepseekKeyHint,
    updatedAt: new Date().toISOString(),
  };

  memorySettings.set(clientId, updated);
  if (memorySettings.size > 1000) {
    const oldest = memorySettings.keys().next().value;
    if (oldest) memorySettings.delete(oldest);
  }

  const status = getCloudflareStatus();
  if (status.d1) {
    await ensureD1Schema();
    await d1Query(
      `INSERT INTO user_ai_settings (
          client_id, provider, model,
          google_api_key_enc, google_key_hint,
          deepseek_api_key_enc, deepseek_key_hint,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_id) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          google_api_key_enc = excluded.google_api_key_enc,
          google_key_hint = excluded.google_key_hint,
          deepseek_api_key_enc = excluded.deepseek_api_key_enc,
          deepseek_key_hint = excluded.deepseek_key_hint,
          updated_at = excluded.updated_at`,
      [
        updated.clientId,
        updated.provider,
        updated.model,
        updated.googleApiKeyEnc,
        updated.googleKeyHint,
        updated.deepseekApiKeyEnc,
        updated.deepseekKeyHint,
        updated.updatedAt,
      ],
    );
  }

  if (status.kv) {
    await kvPut(`settings:${clientId}`, updated, 3600);
  }

  return updated;
}

/**
 * Resolves the effective decrypted API key for the requested provider.
 * Strictly uses the user's own Onion-encrypted key stored in Cloudflare D1/cache.
 */
export async function resolveProviderApiKey(
  clientId: string,
  provider: AiProvider,
): Promise<{ apiKey: string | null; source: "user" | "none" }> {
  const settings = await getUserSettings(clientId);

  if (provider === "google") {
    const userKey = decryptOnionSecret(settings.googleApiKeyEnc, {
      clientId,
      provider: "google",
    });
    if (userKey) return { apiKey: userKey, source: "user" };
    return { apiKey: null, source: "none" };
  }

  const userKey = decryptOnionSecret(settings.deepseekApiKeyEnc, {
    clientId,
    provider: "deepseek",
  });
  if (userKey) return { apiKey: userKey, source: "user" };
  return { apiKey: null, source: "none" };
}

/**
 * Records an analysis run in Cloudflare D1 (or memory fallback) for audit/history.
 */
export async function recordAnalysisHistory(item: AnalysisHistoryItem): Promise<void> {
  const existing = memoryHistory.get(item.clientId) ?? [];
  memoryHistory.set(item.clientId, [item, ...existing].slice(0, 30));

  const status = getCloudflareStatus();
  if (!status.d1) return;

  try {
    await ensureD1Schema();
    await d1Query(
      `INSERT INTO analysis_history (
          id, client_id, provider, model, dataset_name, question, r2_keys_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.clientId,
        item.provider,
        item.model,
        item.datasetName.slice(0, 200),
        item.question.slice(0, 2000),
        JSON.stringify(item.r2Keys),
        item.createdAt,
      ],
    );
  } catch (err) {
    console.warn("[cloudflare-d1] Failed to record analysis history:", err);
  }
}
