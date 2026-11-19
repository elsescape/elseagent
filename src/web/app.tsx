import { ArrowDown, Menu, Pencil, SquarePen, Trash2 } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  NotFound,
  type Session,
  saveToken,
  Unauthorized,
} from "./client.ts";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  SheetContent,
} from "./components/ui/dialog.tsx";
import { Composer } from "./composer.tsx";
import { isPicture, type Pending } from "./files.tsx";
import { BlockView } from "./messages.tsx";
import { SidebarContent } from "./sidebar.tsx";
import { useTheme } from "./theme.ts";
import { buildTimeline, groupSteps } from "./timeline.ts";

const REFRESH_MS = 4000;
const RECONNECT_MS = 1500;
/** Closer to the bottom than this, the view follows new messages. */
const FOLLOW_PX = 120;

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
        <div className="space-y-1.5">
          <h1 className="font-semibold">elseagent</h1>
          <p className="text-sm text-muted-foreground">
            This agent's API needs its token (<code className="font-mono text-xs">api.token</code>{" "}
            in the config). It is kept in this browser.
          </p>
        </div>
        <input
          type="password"
          // biome-ignore lint/a11y/noAutofocus: the only thing to do on this screen
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="API token"
          className="h-9 w-full rounded-md border bg-transparent px-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
        />
        <Button type="submit" className="w-full" disabled={!token.trim()}>
          Continue
        </Button>
      </form>
    </div>
  );
}

/** The session's title; the pencil turns it into a field. */
function Title({ session, onRename }: { session: Session; onRename: (title: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft !== null && draft.trim() !== session.title) onRename(draft.trim());
    setDraft(null);
  };
  if (draft === null) {
    return (
      <>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
          {session.title || "New chat"}
        </h1>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Rename"
          onClick={() => setDraft(session.title)}
        >
          <Pencil />
        </Button>
      </>
    );
  }
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: opened by the user to type in
      autoFocus
      value={draft}
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") setDraft(null);
      }}
      className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
    />
  );
}

const sessionFromUrl = () => location.hash.slice(1) || null;
const showSession = (id: string | null) =>
  history.replaceState(null, "", id ? `#${id}` : location.pathname);

function App() {
  const [theme, setTheme] = useTheme();
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(sessionFromUrl);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [following, setFollowing] = useState(true);
  const [pending, setPending] = useState<Pending[]>([]);
  const scroller = useRef<HTMLDivElement>(null);

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

  // The address names the session, so a link, the back button or an edited address opens it.
  useEffect(() => {
    const onHash = () => setActiveId(sessionFromUrl());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // Show the session: what Codex remembers of it, then whatever happens from here on. When
  // the stream drops (the agent restarted, the network went) the session is loaded again.
  useEffect(() => {
    setEvents([]);
    setFollowing(true);
    showSession(activeId);
    if (!activeId || locked) return;
    const stop = new AbortController();
    void (async () => {
      while (!stop.signal.aborted) {
        try {
          const view = await api.session(activeId);
          if (stop.signal.aborted) return;
          setError("");
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
        } catch (err) {
          if (stop.signal.aborted) return;
          if (err instanceof Unauthorized) return setLocked(true);
          if (err instanceof NotFound) return setActiveId(null);
          setError("Lost the connection to the agent. Reconnecting…");
        }
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
      }
    })();
    return () => stop.abort();
  }, [activeId, locked, refresh]);

  const timeline = useMemo(() => buildTimeline(events), [events]);
  const blocks = useMemo(() => groupSteps(timeline.entries, timeline.busy), [timeline]);
  const active = sessions.find((s) => s.id === activeId);

  // Follow the conversation as it grows, unless the reader has scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when there is more to show
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [events, following]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX);
  };

  const clearPending = () =>
    setPending((files) => {
      for (const p of files) if (p.preview) URL.revokeObjectURL(p.preview);
      return [];
    });

  const select = (id: string | null) => {
    setActiveId(id);
    setMenuOpen(false);
    clearPending(); // they were uploaded to the session being left
  };

  /** The session messages go to: the open one, or a new one for a first message. */
  const ensureSession = async () => {
    const id = activeId ?? (await attempt(api.create))?.id;
    if (id) setActiveId(id);
    return id;
  };

  /** Upload files as soon as they are picked, so sending the message doesn't wait for them. */
  const attach = async (files: File[]) => {
    const picked = files.map(
      (file): Pending => ({
        key: crypto.randomUUID(),
        file,
        preview: isPicture(file.name) ? URL.createObjectURL(file) : undefined,
      }),
    );
    setPending((now) => [...now, ...picked]);
    const update = (key: string, change: Partial<Pending>) =>
      setPending((now) => now.map((p) => (p.key === key ? { ...p, ...change } : p)));
    const id = await ensureSession();
    for (const { key, file } of picked) {
      try {
        if (!id) throw new Error("no session to upload to");
        const [saved] = await api.upload(id, [file]);
        update(key, saved ? { path: saved.path } : { error: "The upload was not saved" });
      } catch (err) {
        if (err instanceof Unauthorized) return setLocked(true);
        update(key, { error: (err as Error).message });
      }
    }
  };

  const send = async (text: string, files = pending) => {
    const paths = files.flatMap((p) => (p.path ? [p.path] : []));
    if (!text.trim() && paths.length === 0) return;
    const id = await ensureSession();
    if (!id) return;
    setFollowing(true);
    clearPending();
    await attempt(() => api.send(id, text.trim(), paths));
    void refresh();
  };

  const remove = async () => {
    setDeleting(false);
    if (!activeId) return;
    await attempt(() => api.remove(activeId));
    setActiveId(null);
    void refresh();
  };

  const rename = async (title: string) => {
    if (!activeId) return;
    await attempt(() => api.rename(activeId, title));
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

  const sidebar = (
    <SidebarContent
      sessions={sessions}
      activeId={activeId}
      status={status}
      theme={theme}
      onTheme={setTheme}
      onSelect={select}
    />
  );
  const composer = (
    <Composer
      busy={timeline.busy}
      pending={pending}
      onAttach={attach}
      onRemove={(key) => setPending((now) => now.filter((p) => p.key !== key))}
      onSend={send}
      onStop={() => activeId && void attempt(() => api.stop(activeId))}
    />
  );
  const empty = blocks.length === 0 && !timeline.busy;

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-sidebar md:flex lg:w-72">
        {sidebar}
      </aside>
      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent aria-describedby={undefined}>
          <DialogTitle className="sr-only">Conversations</DialogTitle>
          {sidebar}
        </SheetContent>
      </Dialog>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-1 px-2 md:px-4">
          <Button
            variant="ghost"
            size="icon-sm"
            title="Conversations"
            className="md:hidden"
            onClick={() => setMenuOpen(true)}
          >
            <Menu />
          </Button>
          {active ? (
            <>
              <Title key={active.id} session={active} onRename={rename} />
              <Button
                variant="ghost"
                size="icon-sm"
                title="Delete"
                onClick={() => setDeleting(true)}
                disabled={timeline.busy}
              >
                <Trash2 />
              </Button>
            </>
          ) : (
            <span className="flex-1 px-1 text-sm font-medium md:hidden">elseagent</span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            title="New chat"
            className="md:hidden"
            onClick={() => select(null)}
          >
            <SquarePen />
          </Button>
        </header>
        {error && (
          <div className="border-y bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {empty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pb-[12vh]">
            <div className="space-y-2 text-center">
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                What can I do for you?
              </h2>
              <p className="text-sm text-muted-foreground">
                The agent works in its workspace and shows each step as it goes.
              </p>
            </div>
            <div className="w-full max-w-2xl">{composer}</div>
          </div>
        ) : (
          <>
            <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl space-y-5 px-4 pt-2 pb-8">
                {blocks.map((block) => (
                  <BlockView
                    key={block.key}
                    block={block}
                    onChoice={(choice) => send(choice, [])}
                  />
                ))}
                {timeline.busy && (
                  <div className="text-sm">
                    <span className="text-shimmer">
                      Agent {timeline.status || "is waiting for a turn…"}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <div className="relative mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 md:pb-4">
              {!following && (
                <Button
                  variant="outline"
                  size="icon-sm"
                  title="Jump to the latest"
                  className="absolute -top-11 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-md dark:bg-popover"
                  onClick={() => setFollowing(true)}
                >
                  <ArrowDown />
                </Button>
              )}
              {composer}
            </div>
          </>
        )}
      </main>

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <div className="space-y-2">
            <DialogTitle>Delete this conversation?</DialogTitle>
            <DialogDescription>
              “{active?.title || "New chat"}” is removed from the list and the agent forgets it.
              Files it made in the workspace stay.
            </DialogDescription>
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={remove}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
