import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";

import { sshDir } from "../app-paths.js";

const logger = getLogger(["herman-desktop", "publishing", "ssh-keygen"]);

const DEFAULT_KEY_NAME = "herman_deploy_key";

export interface SshKeyPair {
  /** Absolute path to the private key file. */
  privateKeyPath: string;
  /** The public key text (ready to paste into Hetzner / authorized_keys). */
  publicKey: string;
}

/**
 * Generate an ED25519 SSH key pair for deployment.
 * Uses the system's `ssh-keygen` command so the keys are in standard format.
 * Idempotent: if the key already exists, returns the existing public key.
 *
 * Keys are stored under `sshDir()` (~/.herman/ssh) unless `baseDir` is given
 * (used by tests).
 */
export async function generateSshKey(keyName?: string, baseDir?: string): Promise<SshKeyPair> {
  const dir = baseDir ?? sshDir();
  const name = keyName ?? DEFAULT_KEY_NAME;
  const privateKeyPath = join(dir, name);
  const publicKeyPath = `${privateKeyPath}.pub`;

  // Idempotent: return existing key if already generated.
  if (existsSync(privateKeyPath) && existsSync(publicKeyPath)) {
    logger.info("SSH key already exists", { privateKeyPath });
    const publicKey = readFileSync(publicKeyPath, "utf-8").trim();
    return { privateKeyPath, publicKey };
  }

  mkdirSync(dir, { recursive: true });

  // Remove any partial remnants from a previous failed run.
  try {
    if (existsSync(privateKeyPath)) unlinkSync(privateKeyPath);
    if (existsSync(publicKeyPath)) unlinkSync(publicKeyPath);
  } catch {
    // best-effort cleanup
  }

  const proc = Bun.spawn(
    [
      "ssh-keygen",
      "-t",
      "ed25519",
      "-f",
      privateKeyPath,
      "-N",
      "", // no passphrase
      "-C",
      "herman-deploy",
      "-q", // quiet
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  if (exitCode !== 0) {
    const msg = stderr.trim() || `ssh-keygen exited with code ${exitCode}`;
    throw new Error(`Failed to generate SSH key: ${msg}`);
  }

  // Ensure private key has correct permissions.
  chmodSync(privateKeyPath, 0o600);

  const publicKey = readFileSync(publicKeyPath, "utf-8").trim();
  logger.info("Generated SSH key pair", { privateKeyPath });

  return { privateKeyPath, publicKey };
}

/**
 * Read an existing SSH public key from a file path.
 * Useful when the user wants to reuse their own key.
 */
export function readPublicKey(keyPath: string): string {
  const pubPath = keyPath.endsWith(".pub") ? keyPath : `${keyPath}.pub`;
  if (!existsSync(pubPath)) {
    throw new Error(`Public key not found at ${pubPath}`);
  }
  return readFileSync(pubPath, "utf-8").trim();
}

/**
 * Discover existing SSH keys in ~/.ssh that could be used for deployment.
 * Returns a list of { name, publicKey } for common key types.
 */
export function discoverSshKeys(): { name: string; path: string; publicKey: string }[] {
  const sshHome = join(homedir(), ".ssh");
  if (!existsSync(sshHome)) return [];

  const commonNames = ["id_ed25519", "id_rsa", "id_ecdsa"];

  const results: { name: string; path: string; publicKey: string }[] = [];
  for (const name of commonNames) {
    const pubPath = join(sshHome, `${name}.pub`);
    if (existsSync(pubPath)) {
      try {
        const publicKey = readFileSync(pubPath, "utf-8").trim();
        results.push({ name, path: join(sshHome, name), publicKey });
      } catch {
        // skip unreadable keys
      }
    }
  }
  return results;
}
