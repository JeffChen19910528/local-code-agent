export function stripQuotes(rawPath) {
  return rawPath.replace(/^["']|["']$/g, "").trim();
}

export function formatAttachmentBlock(absolutePath, content) {
  return `<attached_file path="${absolutePath}">\n${content}\n</attached_file>`;
}

export function applyPendingAttachments(prompt, attachments) {
  if (!attachments || attachments.length === 0) {
    return prompt;
  }

  const blocks = attachments.map((attachment) => formatAttachmentBlock(attachment.path, attachment.content));
  return [...blocks, prompt].join("\n\n");
}
