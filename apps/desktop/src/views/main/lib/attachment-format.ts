import type { PendingAttachment } from "../../../shared/rpc.js";

/** Build the prompt text that gets sent to pi-agent when the user
 *  submits a message with pending attachments.
 *
 *  pi-agent understands file references by path, so the cleanest way to
 *  ship attachments is to append a small "attachment N: <path>" block
 *  below the user's message.  Each path is on its own line and prefixed
 *  with a 1-based index that matches the order in which the files
 *  were attached.
 *
 *  The format is intentionally simple and human-readable so the agent
 *  can quote it back if it needs to ask the user to clarify which file
 *  it should look at.
 */
export function formatAttachmentsForPrompt(
  text: string,
  attachments: PendingAttachment[],
): string {
  if (attachments.length === 0) return text;

  const trimmedText = text.trimEnd();
  const lines = attachments.map((attachment, index) =>
    `attachment ${index + 1}: ${attachment.path}`,
  );
  const block = lines.join("\n");

  if (trimmedText.length === 0) {
    return block;
  }
  return `${trimmedText}\n\n${block}`;
}
