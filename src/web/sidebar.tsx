import { LoaderCircle, Monitor, Moon, SquarePen, Sun } from "lucide-react";
import type { AgentStatus, Session } from "./client.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { THEMES, type Theme } from "./theme.ts";
import { groupByDay } from "./timeline.ts";

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };
const THEME_LABEL = { system: "System theme", light: "Light theme", dark: "Dark theme" };

function ThemeSwitch({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return (
    <div className="flex rounded-full border bg-background p-0.5">
      {THEMES.map((option) => {
        const Icon = THEME_ICON[option];
        return (
          <button
            type="button"
            key={option}
            title={THEME_LABEL[option]}
            aria-label={THEME_LABEL[option]}
            aria-pressed={theme === option}
            onClick={() => onChange(option)}
            className={cn(
              "flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground",
              theme === option && "bg-accent text-foreground",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}

/** The session list, with the agent's state and the theme switch under it. */
export function SidebarContent({
  sessions,
  activeId,
  status,
  theme,
  onTheme,
  onSelect,
}: {
  sessions: Session[];
  activeId: string | null;
  status: AgentStatus | null;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  /** A session was picked; null starts a new chat. */
  onSelect: (id: string | null) => void;
}) {
  const busy = status ? status.running.length + status.queued : 0;
  return (
    <>
      <div className="flex h-14 shrink-0 items-center justify-between px-3">
        <span className="flex items-center gap-2 px-1 font-semibold tracking-tight">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary font-mono text-xs text-primary-foreground">
            &gt;_
          </span>
          elseagent
        </span>
        <Button variant="ghost" size="icon-sm" title="New chat" onClick={() => onSelect(null)}>
          <SquarePen />
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="px-2.5 py-2 text-sm text-muted-foreground">No conversations yet.</p>
        )}
        {groupByDay(sessions).map((group) => (
          <div key={group.label} className="mb-3">
            <div className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
              {group.label}
            </div>
            {group.sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                onClick={() => onSelect(session.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent",
                  session.id === activeId && "bg-accent font-medium",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{session.title || "New chat"}</span>
                {session.status !== "idle" && (
                  <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="flex shrink-0 items-center gap-3 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                !status
                  ? "bg-muted-foreground/50"
                  : busy
                    ? "animate-pulse bg-amber-500"
                    : "bg-success",
              )}
            />
            <span className="truncate">
              {!status
                ? "Connecting…"
                : busy
                  ? `${status.running.length} running · ${status.queued} queued`
                  : "Idle"}
            </span>
          </div>
          {status && <div className="truncate pl-3">{status.model ?? "Codex default model"}</div>}
        </div>
        <ThemeSwitch theme={theme} onChange={onTheme} />
      </div>
    </>
  );
}
