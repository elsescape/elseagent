import { ArrowUp, Paperclip, Square } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./components/ui/button.tsx";
import { isUploading, type Pending, PendingFile } from "./files.tsx";
import { cn } from "./lib/utils.ts";

const MAX_HEIGHT = 200;

/**
 * Where messages are written, and files attached: with the paperclip, by pasting, or by
 * dropping them here. While the agent works, the send button stops it instead.
 */
export function Composer({
  busy,
  pending,
  onAttach,
  onRemove,
  onSend,
  onStop,
}: {
  busy: boolean;
  /** Files picked for the next message. */
  pending: Pending[];
  onAttach: (files: File[]) => void;
  onRemove: (key: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [dropping, setDropping] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const uploading = pending.some(isUploading);
  const ready = pending.some((p) => p.path);
  const canSend = (text.trim() !== "" || ready) && !uploading;
  const submit = () => {
    if (!canSend) return;
    onSend(text);
    setText("");
  };
  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "";
    if (text) el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, except while an input method is still composing (Chinese, Japanese…).
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length === 0) return; // plain text: paste it as usual
    e.preventDefault();
    onAttach(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    if (e.dataTransfer.files.length) onAttach([...e.dataTransfer.files]);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the paperclip does the same
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      className={cn(
        "rounded-3xl border bg-background p-2 shadow-sm transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 dark:bg-input/30",
        dropping && "border-ring ring-[3px] ring-ring/40",
      )}
    >
      {pending.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1 pt-1 pb-2">
          {pending.map((p) => (
            <PendingFile key={p.key} pending={p} onRemove={() => onRemove(p.key)} />
          ))}
        </div>
      )}
      <div className="flex items-end gap-1">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onAttach([...e.target.files]);
            e.target.value = ""; // picking the same file again should work
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground"
          title="Attach files"
          onClick={() => picker.current?.click()}
        >
          <Paperclip />
        </Button>
        <textarea
          ref={input}
          // biome-ignore lint/a11y/noAutofocus: the page is the chat; typing should just work
          autoFocus
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder="Message the agent…"
          // 16px on phones: anything smaller makes iOS zoom the page on focus.
          style={{ maxHeight: MAX_HEIGHT }}
          className="min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground md:text-[0.9375rem]"
        />
        {busy && !canSend ? (
          <Button size="icon" className="rounded-full" onClick={onStop} title="Stop">
            <Square className="size-3 fill-current" />
          </Button>
        ) : (
          <Button
            size="icon"
            className="rounded-full"
            onClick={submit}
            disabled={!canSend}
            title={uploading ? "Uploading…" : "Send (Enter)"}
          >
            <ArrowUp />
          </Button>
        )}
      </div>
    </div>
  );
}
