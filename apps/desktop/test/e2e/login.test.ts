import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { checkDeviceActivation, startDeviceActivation } from "../../src/bun/activation.js";
import { AgentBridge } from "../../src/bun/agent-bridge.js";
import { saveSession } from "../../src/bun/session.js";

const runE2E = process.env.HERMAN_RUN_E2E === "1";
const authUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

async function approveViaBrowser(code: { userCode: string }) {
  const email = `test-${Date.now()}@example.com`;
  const password = "password123";
  const name = "Integration Test";

  const signUp = await fetch(`${authUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: authUrl },
    credentials: "include",
    body: JSON.stringify({ email, password, name, rememberMe: true }),
  });
  const signUpBody = (await signUp.json()) as { token?: string };
  const token = signUpBody.token;
  if (!token) throw new Error("Sign up did not return token");

  const claim = await fetch(`${authUrl}/api/auth/device?user_code=${code.userCode}`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: "include",
  });
  if (!claim.ok) throw new Error(`Claim failed: ${claim.status}`);

  const approve = await fetch(`${authUrl}/api/auth/device/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    credentials: "include",
    body: JSON.stringify({ userCode: code.userCode }),
  });
  if (!approve.ok) throw new Error(`Approve failed: ${approve.status}`);
}

async function waitForAuthorization(deviceCode: string, attempts = 60): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const result = await checkDeviceActivation(deviceCode);
    if (result.status === "authorized" && result.accessToken) return result.accessToken;
    if (result.status === "error") throw new Error(result.error ?? "Activation error");
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Activation timed out");
}

describe.skipIf(!runE2E)("device login e2e", () => {
  let bridge: AgentBridge | undefined;

  afterAll(async () => {
    await bridge?.stop();
  });

  it("completes device activation and starts the agent bridge", async () => {
    const code = await startDeviceActivation();
    expect(code.userCode.length).toBeGreaterThan(0);

    await approveViaBrowser(code);
    const accessToken = await waitForAuthorization(code.deviceCode);
    expect(accessToken.length).toBeGreaterThan(0);

    const projectPath = join(import.meta.dir, "../../../..");
    await saveSession({ token: accessToken });

    bridge = new AgentBridge(
      "test-tab",
      () => {},
      () => {},
      () => {},
    );

    await bridge.start(projectPath);
    await new Promise((r) => setTimeout(r, 5000));

    expect(bridge.state).toBeDefined();
  }, 120_000);
});
