import type { ThreadItem } from "@openai/codex-sdk";
import DOMPurify from "dompurify";
import {
  ArrowUp,
  Bot,
  Brain,
  ChevronRight,
  CircleAlert,
  FilePen,
  Globe,
  ListTodo,
  LoaderCircle,
  Paperclip,
  Pencil,
  Square,
  SquarePen,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { marked } from "marked";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type { SessionEvent } from "../api/events.ts";
import {
  type AgentStatus,
  api,
  followEvents,
  type Session,
  saveToken,
  Unauthorized,
} from "./client.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { buildTimeline, type Entry } from "./timeline.ts";

const REFRESH_MS = 4000;

/** Markdown from the agent as HTML that is safe to insert. */
const renderMarkdown = (text: string) =>
  DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }));

function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={cn(
        "prose prose-sm prose-neutral dark:prose-invert max-w-none break-words prose-pre:bg-muted prose-pre:text-foreground prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-medium prose-code:before:content-none prose-code:after:content-none prose-pre:prose-code:bg-transparent prose-pre:prose-code:p-0",
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
  state: "running" | "failed" | "done";
}) {
  const mark =
    state === "running" ? (
      <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
    ) : state === "failed" ? (
      <CircleAlert className="size-3.5 text-destructive" />
    ) : null;
  const line = (
    <>
      <span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {mark}
    </>
  );
  if (!details) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
        {line}
      </div>
    );
  }
  return (
    <details className="group rounded-lg border bg-muted/40 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5">
        {line}
        <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <pre className="max-h-80 overflow-auto border-t px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
        {details}
      </pre>
    </details>
  );
}

function Activity({ item, done }: { item: ThreadItem; done: boolean }) {
  const failed = "status" in item && item.status === "failed";
  const state = failed ? "failed" : done ? "done" : "running";
  switch (item.type) {
    case "command_execution":
      return (
        <Step
          icon={<Terminal />}
          title={<code className="font-mono text-xs">{script(item.command)}</code>}
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
          title={`Edited ${item.changes.length} file${item.changes.length === 1 ? "" : "s"}`}
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
              Used <code className="font-mono text-xs">{`${item.server}.${item.tool}`}</code>
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
        <div className="flex gap-2 text-muted-foreground">
          <Brain className="mt-1 size-3.5 shrink-0" />
          <Markdown text={item.text} className="text-muted-foreground italic" />
        </div>
      );
    case "agent_message":
      return <Markdown text={item.text} className="text-muted-foreground" />;
  }
}

const ENDED = { failed: "The turn failed", interrupted: "The turn was stopped" };

function EntryView({ entry, onChoice }: { entry: Entry; onChoice: (text: string) => void }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="ml-auto w-fit max-w-[80%] rounded-2xl bg-secondary px-4 py-2 text-sm whitespace-pre-wrap break-words">
          {entry.text}
        </div>
      );
    case "item":
      return <Activity item={entry.item} done={entry.done} />;
    case "reply":
      return (
        <div className="space-y-3">
          <Markdown text={entry.text} />
          {entry.files.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {entry.files.map((file) => (
                <span
                  key={file}
                  title={file}
                  className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs text-muted-foreground"
                >
                  <Paperclip className="size-3" />
                  {baseName(file)}
                </span>
              ))}
            </div>
          )}
          {entry.choices.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {entry.choices.map((choice) => (
                <Button key={choice} variant="outline" size="sm" onClick={() => onChoice(choice)}>
                  {choice}
                </Button>
              ))}
            </div>
          )}
        </div>
      );
    case "ended":
      return (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <div className="h-px flex-1 bg-border" />
          {ENDED[entry.status]}
          <div className="h-px flex-1 bg-border" />
        </div>
      );
  }
}

function Composer({
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
    if (text) el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, except while an input method is still composing (Chinese, Japanese…).
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };
  return (
    <div className="flex items-end gap-2 rounded-2xl border bg-background p-2 shadow-sm focus-within:ring-[3px] focus-within:ring-ring/30 dark:bg-input/30">
      <textarea
        ref={input}
        // biome-ignore lint/a11y/noAutofocus: the page is the chat; typing should just work
        autoFocus
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Message the agent…"
        className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
      />
      {busy && !text.trim() ? (
        <Button size="icon-sm" className="rounded-full" onClick={onStop} title="Stop">
          <Square className="size-3 fill-current" />
        </Button>
      ) : (
        <Button
          size="icon-sm"
          className="rounded-full"
          onClick={submit}
          disabled={!text.trim()}
          title="Send"
        >
          <ArrowUp />
        </Button>
      )}
    </div>
  );
}

function TokenForm({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveToken(token.trim());
    onSaved();
  };
  return (
    <div className="flex h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="font-semibold">elseagent</h1>
          <p className="text-sm text-muted-foreground">
            This agent's API needs its token (<code>api.token</code> in the config).
          </p>
        </div>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="API token"
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button type="submit" className="w-full" disabled={!token.trim()}>
          Continue
        </Button>
      </form>
    </div>
  );
}

const sessionFromUrl = () => location.hash.slice(1) || null;
const showSession = (id: string | null) =>
  history.replaceState(null, "", id ? `#${id}` : location.pathname);

function App() {
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(sessionFromUrl);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  /** Run an API call; a missing token asks for one, anything else is shown. */
  const attempt = useCallback(async <T,>(call: () => Promise<T>): Promise<T | undefined> => {
    try {
      const result = await call();
      setError("");
      return result;
    } catch (err) {
      if (err instanceof Unauthorized) setLocked(true);
      else setError((err as Error).message);
    }
  }, []);

  const refresh = useCallback(async () => {
    const [list, agent] = await Promise.all([attempt(api.sessions), attempt(api.status)]);
    if (list) setSessions(list);
    if (agent) setStatus(agent);
  }, [attempt]);

  useEffect(() => {
    if (locked) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [locked, refresh]);

  // Show the session: what Codex remembers of it, then whatever happens from here on.
  useEffect(() => {
    setEvents([]);
    showSession(activeId);
    if (!activeId || locked) return;
    const stop = new AbortController();
    void (async () => {
      const view = await attempt(() => api.session(activeId));
      if (stop.signal.aborted) return;
      if (!view) return setActiveId(null); // deleted, or another agent's
      setEvents([...view.history, ...view.live]);
      await followEvents(
        activeId,
        view.cursor,
        (event) => {
          setEvents((seen) => [...seen, event]);
          if (event.type === "turn_ended" || event.type === "turn_started") void refresh();
        },
        stop.signal,
      );
    })();
    return () => stop.abort();
  }, [activeId, locked, attempt, refresh]);

  const timeline = useMemo(() => buildTimeline(events), [events]);
  const active = sessions.find((s) => s.id === activeId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the conversation as it grows
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [timeline.entries.length, timeline.status]);

  const send = async (text: string) => {
    if (!text.trim()) return;
    const id = activeId ?? (await attempt(api.create))?.id;
    if (!id) return;
    setActiveId(id);
    await attempt(() => api.send(id, text.trim()));
    void refresh();
  };

  const remove = async () => {
    if (!activeId || !confirm("Delete this session?")) return;
    await attempt(() => api.remove(activeId));
    setActiveId(null);
    void refresh();
  };

  const rename = async () => {
    if (!active) return;
    const title = prompt("Session title", active.title);
    if (title === null) return;
    await attempt(() => api.rename(active.id, title));
    void refresh();
  };

  if (locked) {
    return (
      <TokenForm
        onSaved={() => {
          setLocked(false);
          setError("");
        }}
      />
    );
  }

  const composer = (
    <Composer
      busy={timeline.busy}
      onSend={send}
      onStop={() => activeId && void attempt(() => api.stop(activeId))}
    />
  );
  const empty = timeline.entries.length === 0 && !timeline.busy;

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex h-12 items-center justify-between px-3">
          <span className="flex items-center gap-2 px-1 text-sm font-semibold">
            <Bot className="size-4" />
            elseagent
          </span>
          <Button variant="ghost" size="icon-sm" title="New chat" onClick={() => setActiveId(null)}>
            <SquarePen />
          </Button>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {sessions.map((session) => (
            <button
              type="button"
              key={session.id}
              onClick={() => setActiveId(session.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent",
                session.id === activeId && "bg-accent font-medium",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{session.title || "New chat"}</span>
              {session.status !== "idle" && (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              )}
            </button>
          ))}
        </nav>
        <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
          {status ? (
            <>
              <div className="truncate">{status.model ?? "Codex default model"}</div>
              <div>
                {status.running.length} running · {status.queued} queued
              </div>
            </>
          ) : (
            "Connecting…"
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {activeId && (
          <header className="flex h-12 shrink-0 items-center gap-1 border-b px-4">
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
              {active?.title || "New chat"}
            </h1>
            <Button variant="ghost" size="icon-sm" title="Rename" onClick={rename}>
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Delete"
              onClick={remove}
              disabled={timeline.busy}
            >
              <Trash2 />
            </Button>
          </header>
        )}
        {empty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
            <h2 className="text-2xl font-semibold tracking-tight">What can I do for you?</h2>
            <div className="w-full max-w-2xl">{composer}</div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
                {timeline.entries.map((entry) => (
                  <EntryView key={entry.key} entry={entry} onChoice={send} />
                ))}
                {timeline.busy && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-3.5 animate-spin" />
                    Agent {timeline.status || "is waiting for a turn…"}
                  </div>
                )}
                <div ref={bottom} />
              </div>
            </div>
            <div className="mx-auto w-full max-w-3xl px-4 pb-4">{composer}</div>
          </>
        )}
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
