export async function waitForSubprocessExit(
  exited: Promise<number>,
  timeoutMs: number,
): Promise<boolean> {
  const result = await Promise.race([
    exited.then(() => true as const),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  return result;
}
