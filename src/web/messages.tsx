import type { ThreadItem } from "@openai/codex-sdk";
import DOMPurify from "dompurify";
import {
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FilePen,
  Globe,
  ListTodo,
  LoaderCircle,
  Terminal,
  Wrench,
} from "lucide-react";
import { marked } from "marked";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { FileList } from "./files.tsx";
import { cn } from "./lib/utils.ts";
import { type Block, summarizeSteps } from "./timeline.ts";

// Links in what the agent wrote open in a new tab, and can't reach back into this one.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "A") return;
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer");
});

/** Markdown from the agent as HTML that is safe to insert. */
const renderMarkdown = (text: string) =>
  DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }));

function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={cn(
        "prose prose-neutral dark:prose-invert max-w-none break-words text-[0.9375rem] leading-relaxed",
        "prose-headings:font-semibold prose-a:underline-offset-4 prose-pre:rounded-lg prose-pre:border prose-pre:bg-muted prose-pre:text-foreground",
        "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-medium prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:prose-code:bg-transparent prose-pre:prose-code:p-0 prose-pre:prose-code:font-normal",
        "prose-table:block prose-table:overflow-x-auto",
        className,
      )}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Codex runs commands as `/bin/zsh -lc '<script>'`; the script is what matters. */
function script(command: string): string {
  const wrapped = /^\S*sh -l?c (.+)$/s.exec(command)?.[1];
  if (!wrapped) return command;
  const quoted = /^(['"])(.*)\1$/s.exec(wrapped);
  return quoted ? (quoted[2] ?? wrapped) : wrapped;
}

const baseName = (path: string) => path.split("/").pop() || path;

type StepState = "running" | "failed" | "done";

/** One thing Codex did, as a line that opens for the details. */
function Step({
  icon,
  title,
  details,
  state,
}: {
  icon: ReactNode;
  title: ReactNode;
  details?: string;
  state: StepState;
}) {
  const mark =
    state === "running" ? (
      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
    ) : state === "failed" ? (
      <CircleAlert className="size-3.5 shrink-0 text-destructive" />
    ) : null;
  const line = (
    <>
      <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {mark}
    </>
  );
  if (!details) return <div className="flex items-center gap-2 px-3 py-1.5">{line}</div>;
  return (
    <details className="group/step">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 transition-colors hover:bg-muted/60">
        {line}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/step:rotate-90" />
      </summary>
      <pre className="max-h-72 overflow-auto border-t bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
        {details}
      </pre>
    </details>
  );
}

const mono = "font-mono text-xs";

function Activity({ item, done }: { item: ThreadItem; done: boolean }) {
  const failed = "status" in item && item.status === "failed";
  const state: StepState = failed ? "failed" : done ? "done" : "running";
  switch (item.type) {
    case "command_execution":
      return (
        <Step
          icon={<Terminal />}
          title={<code className={mono}>{script(item.command)}</code>}
          details={
            `$ ${item.command}\n` +
            (item.aggregated_output || "(no output)") +
            (item.exit_code ? `\n(exit ${item.exit_code})` : "")
          }
          state={state}
        />
      );
    case "file_change":
      return (
        <Step
          icon={<FilePen />}
          title={
            item.changes.length === 1 ? (
              <>
                Edited <code className={mono}>{baseName(item.changes[0]?.path ?? "")}</code>
              </>
            ) : (
              `Edited ${item.changes.length} files`
            )
          }
          details={item.changes.map((c) => `${c.kind} ${c.path}`).join("\n")}
          state={state}
        />
      );
    case "mcp_tool_call":
      return (
        <Step
          icon={<Wrench />}
          title={
            <>
              Used <code className={mono}>{`${item.server}.${item.tool}`}</code>
            </>
          }
          details={JSON.stringify(
            { arguments: item.arguments, result: item.result, error: item.error },
            null,
            2,
          )}
          state={state}
        />
      );
    case "web_search":
      return <Step icon={<Globe />} title={`Searched for “${item.query}”`} state={state} />;
    case "todo_list":
      return (
        <Step
          icon={<ListTodo />}
          title={`Plan: ${item.items.filter((t) => t.completed).length}/${item.items.length} done`}
          details={item.items.map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("\n")}
          state={state}
        />
      );
    case "error":
      return <Step icon={<CircleAlert />} title={item.message} state="failed" />;
    case "reasoning":
      return (
        <div className="flex gap-2 px-3 py-1.5 text-muted-foreground">
          <Brain className="mt-1 size-3.5 shrink-0" />
          <Markdown text={item.text} className="text-sm text-muted-foreground italic" />
        </div>
      );
    case "agent_message":
      return (
        <div className="px-3 py-1.5">
          <Markdown text={item.text} className="text-sm text-muted-foreground" />
        </div>
      );
  }
}

/**
 * The steps Codex took in a row. Open while they are happening, so the work can be watched;
 * folded to a one-line summary once the turn has moved on, unless the reader chose otherwise.
 */
function Steps({ block }: { block: Extract<Block, { kind: "steps" }> }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? block.active;
  const failed = block.steps.some((s) => "status" in s.item && s.item.status === "failed");
  return (
    <div className="overflow-hidden rounded-xl border text-sm">
      <button
        type="button"
        onClick={() => setChosen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-muted/60"
      >
        {block.active ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
        ) : failed ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Check className="size-3.5 shrink-0 text-success" />
        )}
        <span className={cn("min-w-0 flex-1 truncate", block.active && "text-shimmer")}>
          {block.active ? "Working…" : summarizeSteps(block.steps)}
        </span>
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="divide-y border-t">
          {block.steps.map((step) => (
            <Activity key={step.key} item={step.item} done={step.done} />
          ))}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title="Copy"
      className="size-7 text-muted-foreground"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

const ENDED = { failed: "The turn failed", interrupted: "The turn was stopped" };

export function BlockView({ block, onChoice }: { block: Block; onChoice: (text: string) => void }) {
  switch (block.kind) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-2">
          <FileList files={block.files} className="max-w-[85%] justify-end sm:max-w-[75%]" />
          {block.text && (
            <div className="w-fit max-w-[85%] rounded-3xl rounded-br-lg bg-secondary px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap break-words sm:max-w-[75%]">
              {block.text}
            </div>
          )}
        </div>
      );
    case "steps":
      return <Steps block={block} />;
    case "reply":
      return (
        <div className="group/reply space-y-3">
          <Markdown text={block.text} />
          <FileList files={block.files} />
          {block.choices.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {block.choices.map((choice) => (
                <Button
                  key={choice}
                  variant="outline"
                  size="sm"
                  className="h-auto min-h-8 rounded-full py-1.5 whitespace-normal"
                  onClick={() => onChoice(choice)}
                >
                  {choice}
                </Button>
              ))}
            </div>
          )}
          <div className="-ml-1.5 opacity-0 transition-opacity group-hover/reply:opacity-100 focus-within:opacity-100 max-md:opacity-100">
            <CopyButton text={block.text} />
          </div>
        </div>
      );
    case "ended":
      return (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <div className="h-px flex-1 bg-border" />
          {ENDED[block.status]}
          <div className="h-px flex-1 bg-border" />
        </div>
      );
  }
}
