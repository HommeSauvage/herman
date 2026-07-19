import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";

import { getLogger } from "@logtape/logtape";

import type { ProviderCredential } from "../shared/rpc.js";
import { credentialsPath as appCredentialsPath, appDir } from "./app-paths.js";
import { ensureDir, writeFileAtomically } from "./fs-utils.js";
import { removeKey, retrieveKey, storeKey } from "./keychain.js";
import { refreshOAuthToken } from "./oauth.js";

const logger = getLogger(["herman-desktop", "credentials"]);

function credentialsDir() {
  return appDir();
}

function credentialsPath() {
  return appCredentialsPath();
}

type EncryptedCredentials = {
  iv: string;
  authTag: string;
  encrypted: string;
};

let credentialStoreError: string | undefined;

export function getCredentialStoreError(): string | undefined {
  return credentialStoreError;
}

function machineKey(): Buffer {
  // Fallback key derived from hostname + user data path. This is not
  // portable across machines, but it preserves access to credentials when
  // the OS keychain is unavailable.
  const stable = `${hostname()}:${credentialsDir()}`;
  return createHash("sha256").update(stable).digest();
}

function encrypt(text: string, key: Buffer): EncryptedCredentials {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    encrypted: encrypted.toString("base64"),
  };
}

function decrypt(payload: EncryptedCredentials, key: Buffer): string {
  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  const encrypted = Buffer.from(payload.encrypted, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

let cachedEncryptionKey: { key: Buffer; fromKeychain: boolean } | undefined;

async function getEncryptionKey(): Promise<{ key: Buffer; fromKeychain: boolean }> {
  if (cachedEncryptionKey) return cachedEncryptionKey;

  const keychainKey = await retrieveKey();
  if (keychainKey) {
    cachedEncryptionKey = { key: Buffer.from(keychainKey, "base64"), fromKeychain: true };
    return cachedEncryptionKey;
  }

  const newKey = randomBytes(32).toString("base64");
  const stored = await storeKey(newKey);
  if (stored) {
    cachedEncryptionKey = { key: Buffer.from(newKey, "base64"), fromKeychain: true };
    return cachedEncryptionKey;
  }

  logger.info("OS keychain unavailable; using machine-derived encryption key fallback");
  return { key: machineKey(), fromKeychain: false };
}

async function tryDecrypt(payload: EncryptedCredentials): Promise<{
  json: string;
  usedMachineKeyFallback: boolean;
}> {
  const { key, fromKeychain } = await getEncryptionKey();
  try {
    return { json: decrypt(payload, key), usedMachineKeyFallback: false };
  } catch (error) {
    // If the keychain key is available, the file may still be encrypted with
    // the older machine-derived key. Decrypt with the fallback so we can
    // re-encrypt under the keychain key on the next save.
    if (fromKeychain) {
      try {
        return { json: decrypt(payload, machineKey()), usedMachineKeyFallback: true };
      } catch {
        // fall through to throw the original error
      }
    }
    throw error;
  }
}

// Serialize concurrent credential mutations through a simple async queue.
// This prevents race conditions where two concurrent saves could read the
// same old state, apply divergent changes, and overwrite each other.
let credentialQueue: Promise<unknown> = Promise.resolve();

function withCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = credentialQueue.then(() => fn());
  credentialQueue = next.catch(() => undefined);
  return next;
}

export async function loadCredentials(): Promise<Record<string, ProviderCredential>> {
  ensureDir(credentialsDir());
  credentialStoreError = undefined;
  const path = credentialsPath();
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  try {
    const payload = (await file.json()) as EncryptedCredentials;
    const { json, usedMachineKeyFallback } = await tryDecrypt(payload);
    const credentials = JSON.parse(json) as Record<string, ProviderCredential>;
    if (usedMachineKeyFallback) {
      // Migrate to keychain-backed encryption on first successful read.
      await saveCredentials(credentials);
    }
    return credentials;
  } catch (error) {
    if (await file.exists()) {
      credentialStoreError =
        error instanceof Error ? error.message : "Failed to decrypt credentials store";
      logger.warning("Failed to decrypt credentials store", { error: credentialStoreError });
    }
    return {};
  }
}

async function saveCredentials(credentials: Record<string, ProviderCredential>): Promise<void> {
  ensureDir(credentialsDir());
  const { key } = await getEncryptionKey();
  const payload = encrypt(JSON.stringify(credentials, null, 2), key);
  const data = JSON.stringify(payload, null, 2);
  writeFileAtomically(credentialsPath(), data);
  credentialStoreError = undefined;
}

export async function getCredential(providerId: string): Promise<ProviderCredential | undefined> {
  logger.debug("Loading provider credential", { providerId });
  const credentials = await loadCredentials();
  return credentials[providerId];
}

const OAUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export async function getRefreshedCredential(
  providerId: string,
): Promise<ProviderCredential | undefined> {
  return withCredentialLock(async () => {
    const credentials = await loadCredentials();
    const credential = credentials[providerId];
    if (!credential) return undefined;
    if (credential.type !== "oauth") return credential;
    if (!credential.expiresAt || credential.expiresAt > Date.now() + OAUTH_REFRESH_BUFFER_MS) {
      return credential;
    }
    const refreshed = await refreshOAuthToken(providerId, credential);
    credentials[providerId] = refreshed;
    await saveCredentials(credentials);
    return refreshed;
  });
}

export async function refreshAllOAuthCredentials(): Promise<void> {
  await withCredentialLock(async () => {
    const credentials = await loadCredentials();
    let changed = false;
    for (const [providerId, credential] of Object.entries(credentials)) {
      if (credential.type !== "oauth") continue;
      if (!credential.expiresAt || credential.expiresAt > Date.now() + OAUTH_REFRESH_BUFFER_MS)
        continue;
      try {
        credentials[providerId] = await refreshOAuthToken(providerId, credential);
        changed = true;
      } catch (error) {
        logger.warning("Failed to refresh OAuth token", {
          providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (changed) await saveCredentials(credentials);
  });
}

export async function setCredential(
  providerId: string,
  credential: ProviderCredential,
): Promise<void> {
  logger.debug("Saving provider credential", { providerId, type: credential.type });
  await withCredentialLock(async () => {
    const credentials = await loadCredentials();
    credentials[providerId] = credential;
    await saveCredentials(credentials);
  });
}

export async function removeCredential(providerId: string): Promise<void> {
  logger.debug("Removing provider credential", { providerId });
  await withCredentialLock(async () => {
    const credentials = await loadCredentials();
    delete credentials[providerId];
    await saveCredentials(credentials);
  });
}

export async function clearCredentialStore(): Promise<void> {
  await removeKey();
  cachedEncryptionKey = undefined;
  credentialStoreError = undefined;
}
