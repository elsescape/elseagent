import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.tsx";

const MAX_HEIGHT = 200;

/** Where messages are written. While the agent works, the send button stops it instead. */
export function Composer({
  busy,
  onSend,
  onStop,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const submit = () => {
    if (!text.trim()) return;
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
  return (
    <div className="flex items-end gap-2 rounded-3xl border bg-background p-2 pl-3 shadow-sm transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 dark:bg-input/30">
      <textarea
        ref={input}
        // biome-ignore lint/a11y/noAutofocus: the page is the chat; typing should just work
        autoFocus
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Message the agent…"
        // 16px on phones: anything smaller makes iOS zoom the page on focus.
        className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground md:text-[0.9375rem]"
      />
      {busy && !text.trim() ? (
        <Button size="icon" className="rounded-full" onClick={onStop} title="Stop">
          <Square className="size-3 fill-current" />
        </Button>
      ) : (
        <Button
          size="icon"
          className="rounded-full"
          onClick={submit}
          disabled={!text.trim()}
          title="Send (Enter)"
        >
          <ArrowUp />
        </Button>
      )}
    </div>
  );
}
