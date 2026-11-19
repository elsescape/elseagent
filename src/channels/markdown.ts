/**
 * Split long Markdown into messages of at most `limit` characters, preferring paragraph, then line, boundaries.
 * A code block that has to be split is closed and reopened so each part renders.
 */
export function splitMarkdown(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    let part = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).trimStart();
    // An odd number of fences means we are inside a code block: close it here, reopen next.
    if ((part.match(/^```/gm)?.length ?? 0) % 2 === 1) {
      part += "\n```";
      rest = `\`\`\`\n${rest}`;
    }
    parts.push(part);
  }
  if (rest) parts.push(rest);
  return parts;
}

/** The text messages of a reply. Files alone need no text message. */
export function replyParts(markdown: string, hasFiles: boolean, limit: number): string[] {
  return markdown.trim() || !hasFiles ? splitMarkdown(markdown, limit) : [];
}
