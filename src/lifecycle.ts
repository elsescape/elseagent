export interface AppLifecycle {
  signal: AbortSignal;
  defer(name: string, close: () => unknown): void;
}

/** Own resources from startup through shutdown, closing them in reverse order. */
export async function runWithLifecycle(start: (lifecycle: AppLifecycle) => Promise<void>) {
  const stop = new AbortController();
  const cleanups: { name: string; close: () => unknown }[] = [];
  function onSignal(signal: NodeJS.Signals) {
    if (stop.signal.aborted) process.exit(signal === "SIGINT" ? 130 : 143);
    console.log(`${signal} received, stopping`);
    stop.abort();
  }
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await start({
      signal: stop.signal,
      defer(name, close) {
        cleanups.push({ name, close });
      },
    });
    if (!stop.signal.aborted) {
      await new Promise<void>((resolve) =>
        stop.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
    }
  } catch (err) {
    if (err !== stop.signal.reason || !stop.signal.aborted) throw err;
  } finally {
    const stopping = stop.signal.aborted;
    stop.abort();
    for (const { name, close } of cleanups.reverse()) {
      try {
        await close();
      } catch (err) {
        console.warn(`could not stop ${name}: ${err}`);
        if (stopping) process.exitCode = 1;
      }
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
