import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useEffect } from "react";
import { configAtom, routeAtom, threadsAtom, viewAtom } from "./atoms";
import type { InboxConfig } from "./api";
import { ThreadList } from "./ThreadList";
import { Thread } from "./Thread";

const useRoute = () => {
  const hash = useAtomValue(routeAtom);
  const refresh = useAtomRefresh(routeAtom);
  useEffect(() => {
    window.addEventListener("hashchange", refresh);
    return () => window.removeEventListener("hashchange", refresh);
  }, [refresh]);
  return hash.match(/^#\/t\/([0-9a-f]+)/)?.[1] ?? null;
};

/** Re-runs an atom on an interval while the component is mounted. */
export const usePolling = (refresh: () => void, ms: number) => {
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, ms);
    return () => clearInterval(timer);
  }, [refresh, ms]);
};

/** The inbox's config once it has loaded, or null before then (or if it cannot be read). */
export const useConfig = (): InboxConfig | null => {
  const config = AsyncResult.value(useAtomValue(configAtom));
  return config._tag === "Some" ? config.value : null;
};

const SignedOut = ({ config }: { config: InboxConfig | null }) => (
  <main className="h-full grid place-items-center p-6 text-center">
    <div className="max-w-sm space-y-3">
      <div className="text-4xl">🔒</div>
      <h1 className="text-lg font-semibold">Sign in to view this inbox</h1>
      <p className="text-sm text-zinc-500">The thread view uses your signed-in session. Sign in, then come back here.</p>
      {config?.signIn && (
        <a className="inline-block rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white dark:bg-white dark:text-zinc-900" href={config.signIn.url}>
          {config.signIn.label}
        </a>
      )}
    </div>
  </main>
);

export const App = () => {
  const selected = useRoute();
  const config = useConfig();
  const [view, setView] = useAtom(viewAtom);
  const threads = useAtomValue(threadsAtom);
  usePolling(useAtomRefresh(threadsAtom), 5_000);

  useEffect(() => {
    if (config) document.title = config.title;
  }, [config?.title]);

  const error = AsyncResult.error(threads);
  if (error._tag === "Some" && error.value.signedOut) return <SignedOut config={config} />;

  return (
    <div className="h-full flex overflow-hidden">
      <aside className={`${selected ? "hidden md:flex" : "flex"} w-full md:w-80 lg:w-96 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b]`}>
        <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <h1 className="mr-2 min-w-0 truncate font-semibold">{config?.title ?? "Inbox"}</h1>
          <div className="flex gap-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 p-0.5 text-xs">
            {(["inbox", "ignored", "archived"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded px-2 py-0.5 capitalize ${view === v ? "bg-white dark:bg-zinc-700 shadow-sm" : "text-zinc-500"}`}
              >
                {v}
              </button>
            ))}
          </div>
        </header>
        <ThreadList result={threads} selected={selected} />
      </aside>
      <section className={`${selected ? "flex" : "hidden md:flex"} flex-1 min-w-0 flex-col`}>
        {selected ? (
          <Thread key={selected} shortId={selected} />
        ) : (
          <div className="flex-1 grid place-items-center text-zinc-400 text-sm">Pick a report to open its thread.</div>
        )}
      </section>
    </div>
  );
};
