/** How Codex will authenticate. */
export type CodexAuth = "api-key" | "logged-in" | "not-logged-in";

export interface LoginOptions {
  codexPath: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Max device-code attempts (each code is valid for 15 minutes); default: until it works. */
  maxAttempts?: number;
}

// Strips terminal colors so the login instructions read cleanly in docker/kubectl logs.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** API key in the environment, an existing `codex login`, or neither. */
export async function codexAuthStatus(
  codexPath: string,
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
): Promise<CodexAuth> {
  signal?.throwIfAborted();
  if (env.CODEX_API_KEY) return "api-key";
  const status = Bun.spawn([codexPath, "login", "status"], {
    env,
    signal,
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await status.exited;
  signal?.throwIfAborted();
  return exitCode === 0 ? "logged-in" : "not-logged-in";
}

/**
 * Make sure Codex can authenticate before the agent starts taking work. Without an API key or
 * an existing login, run Codex's device-code login and wait: the link and one-time code are
 * logged for an operator to complete in a browser. Expired codes are replaced with new ones.
 */
export async function ensureCodexLogin({
  codexPath,
  env = process.env,
  signal,
  log = console.log,
  maxAttempts = Number.POSITIVE_INFINITY,
}: LoginOptions): Promise<CodexAuth> {
  const auth = await codexAuthStatus(codexPath, env, signal);
  if (auth !== "not-logged-in") return auth;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted();
    log(
      attempt === 1
        ? "codex: not logged in and no CODEX_API_KEY; starting device-code login"
        : "codex: login code expired or failed; starting a new one",
    );
    const login = Bun.spawn([codexPath, "login", "--device-auth"], {
      env,
      signal,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([pipeLines(login.stdout, log), pipeLines(login.stderr, log)]);
    const exitCode = await login.exited;
    signal?.throwIfAborted();
    if (exitCode === 0 && (await codexAuthStatus(codexPath, env, signal)) === "logged-in") {
      log("codex: logged in");
      return "logged-in";
    }
  }
  throw new Error(`codex: device-code login did not complete after ${maxAttempts} attempts`);
}

async function pipeLines(stream: ReadableStream<Uint8Array>, log: (line: string) => void) {
  let buffered = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) emit(line, log);
  }
  emit(buffered, log);
}

function emit(line: string, log: (line: string) => void) {
  const clean = line.replace(ANSI, "").trimEnd();
  if (clean) log(`  ${clean}`);
}
