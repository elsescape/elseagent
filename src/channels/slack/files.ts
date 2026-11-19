import type { Attachment, Fetch } from "../types.ts";

/** Slack serves private files from these hosts; the bot token is never sent anywhere else. */
const isSlackFileUrl = (url: string) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (hostname === "slack.com" || hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
};

/**
 * Download a private Slack file (its `url_private_download`) with the bot token. Needs the
 * `files:read` scope: without it Slack answers with its sign-in page instead of the file.
 */
export async function downloadSlackFile(
  token: string,
  file: Attachment,
  dest: string,
  signal?: AbortSignal,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  if (!isSlackFileUrl(file.ref)) throw new Error("not a Slack file URL");
  const res = await fetchImpl(file.ref, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) throw new Error(`Slack answered HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("text/html") && !file.mimetype?.startsWith("text/html")) {
    await res.body?.cancel();
    throw new Error("Slack refused the download: does the app have the files:read scope?");
  }
  await Bun.write(dest, res);
}
