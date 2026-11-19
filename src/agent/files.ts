import { mkdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Attachment, OutgoingFile } from "../channels/types.ts";
import { formatSize } from "../util/text.ts";

/** Attachments larger than this are not downloaded. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** At most this many images per turn are shown to Codex as images (the rest as files). */
export const MAX_IMAGES = 8;
/** At most this many files are sent with one reply, each at most this large. */
export const MAX_REPLY_FILES = 10;
export const MAX_REPLY_FILE_BYTES = 100 * 1024 * 1024;

/** Image types Codex can look at. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Where a conversation's attachments are saved, under the workspace. */
export function attachmentsDir(workspace: string, conversationKey: string): string {
  return join(workspace, "attachments", conversationKey.replace(/[^A-Za-z0-9._-]/g, "-"));
}

/** A file name safe to create: no directories, control characters or leading dots. */
export function safeFileName(name: string): string {
  const cleaned = basename(name.replaceAll("\\", "/"))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f/:]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned) return "file";
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 120 - ext.length) + ext;
}

/** `name`, or `name-1.ext`, `name-2.ext`… whichever doesn't exist yet in `dir`. */
async function freePath(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 0; ; i++) {
    const path = join(dir, i === 0 ? name : `${stem}-${i}${ext}`);
    if (!(await Bun.file(path).exists())) return path;
  }
}

/** An attachment after the download attempt. */
export interface SavedFile {
  name: string;
  mimetype?: string;
  size?: number;
  /** Absolute path, when downloaded. */
  path?: string;
  /** Why it wasn't downloaded. */
  error?: string;
}

export type Download = (file: Attachment, dest: string) => Promise<void>;

/** Download attachments into `dir`. Failures are recorded on the file, never thrown. */
export async function saveAttachments(
  files: Attachment[],
  dir: string,
  download: Download,
): Promise<SavedFile[]> {
  if (files.length === 0) return [];
  await mkdir(dir, { recursive: true });
  const saved: SavedFile[] = [];
  for (const file of files) {
    const info = { name: file.name, mimetype: file.mimetype, size: file.size };
    if (file.size !== undefined && file.size > MAX_ATTACHMENT_BYTES) {
      saved.push({ ...info, error: `larger than ${formatSize(MAX_ATTACHMENT_BYTES)}` });
      continue;
    }
    const path = await freePath(dir, safeFileName(file.name));
    try {
      await download(file, path);
      saved.push({ ...info, size: Bun.file(path).size, path });
    } catch (err) {
      await Bun.file(path)
        .delete()
        .catch(() => {});
      saved.push({ ...info, error: (err as Error).message });
    }
  }
  return saved;
}

/** How attached files are listed under a message for Codex (paths relative to `workspace`). */
export function describeFiles(files: SavedFile[], workspace: string): string[] {
  return files.map((f) => {
    if (!f.path) return `[attached file ${f.name}: could not be downloaded (${f.error})]`;
    const details = [f.mimetype, f.size !== undefined && formatSize(f.size)].filter(Boolean);
    const where = relative(workspace, f.path);
    return `[attached file: ${where}${details.length ? ` (${details.join(", ")})` : ""}]`;
  });
}

export const isImage = (f: SavedFile) =>
  f.path !== undefined && f.mimetype !== undefined && IMAGE_TYPES.has(f.mimetype);

/**
 * The files a reply names, resolved against the workspace. Missing ones, directories and extra
 * files beyond the limit are returned as problems to mention instead.
 */
export async function resolveReplyFiles(
  paths: string[],
  workspace: string,
): Promise<{ files: OutgoingFile[]; problems: string[] }> {
  const files: OutgoingFile[] = [];
  const problems: string[] = [];
  for (const raw of [...new Set(paths.map((p) => p.trim()).filter(Boolean))]) {
    if (files.length >= MAX_REPLY_FILES) {
      problems.push(`\`${raw}\`: at most ${MAX_REPLY_FILES} files per message`);
      continue;
    }
    const path = isAbsolute(raw) ? raw : resolve(workspace, raw);
    const info = await stat(path).catch(() => null);
    if (!info) problems.push(`\`${raw}\`: not found`);
    else if (!info.isFile()) problems.push(`\`${raw}\`: not a file`);
    else if (info.size === 0) problems.push(`\`${raw}\`: empty`);
    else if (info.size > MAX_REPLY_FILE_BYTES) {
      problems.push(`\`${raw}\`: larger than ${formatSize(MAX_REPLY_FILE_BYTES)}`);
    } else files.push({ path, name: basename(path) });
  }
  return { files, problems };
}
