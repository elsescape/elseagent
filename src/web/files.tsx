import { CircleAlert, Download, FileText, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { EventFile } from "../api/events.ts";
import { api } from "./client.ts";
import { cn } from "./lib/utils.ts";

/** Pictures a browser shows safely as an image (an SVG can carry scripts). */
export const isPicture = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

/** The pictures of the session on screen, fetched once each; forgotten with the session. */
const pictures = new Map<string, Promise<string>>();
function pictureUrl(path: string): Promise<string> {
  let url = pictures.get(path);
  if (!url) {
    url = api.file(path).then((blob) => URL.createObjectURL(blob));
    pictures.set(path, url);
    url.catch(() => pictures.delete(path)); // try again next time
  }
  return url;
}

/** Let go of the pictures held for the session being left. */
export function forgetPictures(): void {
  for (const url of pictures.values()) url.then(URL.revokeObjectURL, () => {});
  pictures.clear();
}

/** Save a workspace file through the browser's own download; nothing of it is kept here. */
async function download(file: EventFile): Promise<void> {
  const url = URL.createObjectURL(await api.file(file.path));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  // The click has handed the URL to the browser's downloader by the next task.
  setTimeout(() => URL.revokeObjectURL(url));
}

/** A file of the conversation: a picture as a thumbnail, anything else as a chip. Click to save. */
function FileLink({ file }: { file: EventFile }) {
  const picture = isPicture(file.name);
  const [src, setSrc] = useState<string>();
  const [state, setState] = useState<"idle" | "busy" | "missing">("idle");
  useEffect(() => {
    if (!picture) return;
    let current = true;
    pictureUrl(file.path)
      .then((url) => current && setSrc(url))
      .catch(() => current && setState("missing"));
    return () => {
      current = false;
    };
  }, [file.path, picture]);

  const save = async () => {
    setState("busy");
    try {
      await download(file);
      setState("idle");
    } catch {
      setState("missing");
    }
  };
  const missing = state === "missing";
  const title = missing ? `${file.path} is not in the workspace any more` : `Download ${file.path}`;

  if (picture && src) {
    return (
      <button type="button" onClick={save} title={title} className="group/file relative block">
        <img
          src={src}
          alt={file.name}
          className="max-h-56 max-w-full rounded-xl border object-contain sm:max-w-sm"
        />
        <span className="absolute top-2 right-2 rounded-md bg-background/80 p-1 opacity-0 backdrop-blur transition-opacity group-hover/file:opacity-100">
          <Download className="size-3.5" />
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={save}
      disabled={missing || state === "busy"}
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-xs transition-colors hover:bg-accent disabled:pointer-events-none",
        missing && "text-muted-foreground line-through",
      )}
    >
      {state === "busy" ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
      ) : missing ? (
        <CircleAlert className="size-3.5 shrink-0" />
      ) : (
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate font-medium">{file.name}</span>
      {!missing && state === "idle" && (
        <Download className="size-3 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

export function FileList({ files, className }: { files: EventFile[]; className?: string }) {
  if (files.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {files.map((file) => (
        <FileLink key={file.path} file={file} />
      ))}
    </div>
  );
}

/** A file picked for the next message: uploading, uploaded (it has a path), or failed. */
export interface Pending {
  key: string;
  file: File;
  /** A local preview, for pictures. */
  preview?: string;
  /** Where the upload was saved, once it has been. */
  path?: string;
  error?: string;
}

/** Still on its way: not saved yet, and not failed. */
export const isUploading = (pending: Pending) => !pending.path && !pending.error;

export function PendingFile({ pending, onRemove }: { pending: Pending; onRemove: () => void }) {
  const uploading = isUploading(pending);
  return (
    <div
      title={pending.error ?? pending.file.name}
      className={cn(
        "group/pending relative flex h-14 items-center gap-2 overflow-hidden rounded-xl border bg-muted/40 text-xs",
        pending.preview ? "w-14" : "max-w-48 px-2.5",
        pending.error && "border-destructive/50 text-destructive",
      )}
    >
      {pending.preview ? (
        <img src={pending.preview} alt={pending.file.name} className="size-full object-cover" />
      ) : (
        <>
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{pending.error ?? pending.file.name}</span>
        </>
      )}
      {uploading && (
        <span className="absolute inset-0 flex items-center justify-center bg-background/60">
          <LoaderCircle className="size-4 animate-spin" />
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        className="absolute top-0.5 right-0.5 rounded-full bg-foreground/80 p-0.5 text-background opacity-0 transition-opacity group-hover/pending:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
