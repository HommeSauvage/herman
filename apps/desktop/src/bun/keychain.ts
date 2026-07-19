/**
 * OS keychain-backed storage for a single encryption key.
 *
 * Supported platforms:
 * - macOS: uses the `security` command-line tool.
 * - Windows: uses the Windows Runtime PasswordVault API via PowerShell.
 * - Linux: uses the `secret-tool` CLI from libsecret.
 *
 * Other platforms and the `HERMAN_DESKTOP_DISABLE_KEYCHAIN=1` environment
 * variable fall back to the encrypted-file backend in `credentials.ts`.
 */

const SERVICE = "com.clique.herman.desktop";
const ACCOUNT = "credential-encryption-key";
const TIMEOUT_MS = 10_000;

type SecurityResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
};

function isKeychainAvailable(): boolean {
  if (process.env.HERMAN_DESKTOP_DISABLE_KEYCHAIN === "1") return false;
  if (process.platform === "darwin") return true;
  if (process.platform === "win32") return true;
  if (process.platform === "linux") return true;
  return false;
}

function runSecurity(args: string[]): SecurityResult | undefined {
  try {
    return Bun.spawnSync(["security", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: TIMEOUT_MS,
    }) as SecurityResult;
  } catch {
    // `security` may be missing or the keychain may be locked; fall back.
    return undefined;
  }
}

function runPowershell(script: string): SecurityResult | undefined {
  try {
    return Bun.spawnSync(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: TIMEOUT_MS,
      },
    ) as SecurityResult;
  } catch {
    // PowerShell may be unavailable or the WinRT type may fail to load.
    return undefined;
  }
}

function runSecretTool(args: string[], stdin?: string): SecurityResult | undefined {
  try {
    return Bun.spawnSync(["secret-tool", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin ? Buffer.from(stdin, "utf8") : undefined,
      timeout: TIMEOUT_MS,
    }) as SecurityResult;
  } catch {
    // `secret-tool` may be missing or the secret service may be unavailable.
    return undefined;
  }
}

export async function storeKey(key: string): Promise<boolean> {
  if (!isKeychainAvailable()) return false;

  if (process.platform === "darwin") {
    // Use `-w` to supply the password directly. Passing via stdin would be
    // preferable, but macOS `security` reads the password from `/dev/tty` when
    // `-w` is omitted, which hangs in a non-interactive process. The password
    // is a random base64 key that is only visible in the process list for the
    // duration of the command.
    const result = runSecurity([
      "add-generic-password",
      "-s",
      SERVICE,
      "-a",
      ACCOUNT,
      "-w",
      key,
      "-U",
    ]);
    return result !== undefined && result.exitCode === 0;
  }

  if (process.platform === "win32") {
    const script = `
      $vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
      $existing = $null
      try { $existing = $vault.Retrieve('${SERVICE}', '${ACCOUNT}') } catch {}
      if ($existing -ne $null) { $vault.Remove($existing) }
      $cred = [Windows.Security.Credentials.PasswordCredential]::new('${SERVICE}', '${ACCOUNT}', '${key}')
      $vault.Add($cred)
    `;
    const result = runPowershell(script);
    return result !== undefined && result.exitCode === 0;
  }

  if (process.platform === "linux") {
    // libsecret may store duplicate items; clear any existing entry first.
    runSecretTool(["clear", "service", SERVICE, "account", ACCOUNT]);
    const result = runSecretTool(
      [
        "store",
        "--label=Herman Desktop credential encryption key",
        "service",
        SERVICE,
        "account",
        ACCOUNT,
      ],
      key,
    );
    return result !== undefined && result.exitCode === 0;
  }

  return false;
}

export async function retrieveKey(): Promise<string | undefined> {
  if (!isKeychainAvailable()) return undefined;

  if (process.platform === "darwin") {
    const result = runSecurity(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
    if (result?.exitCode !== 0) return undefined;
    return result.stdout.toString().trim();
  }

  if (process.platform === "win32") {
    const script = `
      $vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
      $cred = $vault.Retrieve('${SERVICE}', '${ACCOUNT}')
      $cred.Password
    `;
    const result = runPowershell(script);
    if (result?.exitCode !== 0) return undefined;
    return result.stdout.toString().trim();
  }

  if (process.platform === "linux") {
    const result = runSecretTool(["lookup", "service", SERVICE, "account", ACCOUNT]);
    if (result?.exitCode !== 0) return undefined;
    return result.stdout.toString().trim();
  }

  return undefined;
}

export async function removeKey(): Promise<void> {
  if (!isKeychainAvailable()) return;

  if (process.platform === "darwin") {
    runSecurity(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
    return;
  }

  if (process.platform === "win32") {
    const script = `
      $vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
      $cred = $vault.Retrieve('${SERVICE}', '${ACCOUNT}')
      $vault.Remove($cred)
    `;
    runPowershell(script);
    return;
  }

  if (process.platform === "linux") {
    runSecretTool(["clear", "service", SERVICE, "account", ACCOUNT]);
  }
}
