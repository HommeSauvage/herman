import { join } from "node:path";
import { AgentBridge } from "../src/bun/agent-bridge.js";
import { startDeviceActivation, checkDeviceActivation } from "../src/bun/activation.js";
import { saveSession } from "../src/bun/session.js";

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

async function main() {
  console.log("1. Requesting device code...");
  const code = await startDeviceActivation();
  console.log("   user code:", code.userCode);

  console.log("2. Simulating browser approval...");
  await approveViaBrowser(code);

  console.log("3. Polling for authorization...");
  const accessToken = await waitForAuthorization(code.deviceCode);
  console.log("   access token acquired");

  console.log("4. Saving session and starting agent...");
  const projectPath = join(process.cwd(), "..", "..");
  await saveSession({ token: accessToken });

  const bridge = new AgentBridge(
    "test-tab",
    (_tabId, event) => console.log("[agent event]", event.type),
    (_tabId, state, stderr) => console.log("[agent status]", state, stderr ? stderr.slice(0, 200) : ""),
    (_tabId, event) => console.log("[agent event raw]", event.type),
  );

  await bridge.start(projectPath);

  console.log("5. Agent started. Waiting a few seconds...");
  await new Promise((r) => setTimeout(r, 5000));
  console.log("   agent state:", bridge.state);
  console.log("   stderr tail:", bridge.getStderr().slice(-500));

  await bridge.stop();
  console.log("Test complete.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
