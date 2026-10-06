import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ApiError, type BulkAction, type Thread } from "./api";
import { archiveAtom, selectionAtom, setStatusAtom, bulkAtom, viewAtom } from "./atoms";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { sender, statusOf, when } from "./format";

const Tick = ({ checked, onToggle }: { checked: boolean; onToggle: (event: MouseEvent) => void }) => (
  <button
    role="checkbox"
    aria-checked={checked}
    aria-label={checked ? "Deselect" : "Select"}
    onClick={onToggle}
    className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px] leading-none ${
      checked
        ? "border-sky-500 bg-sky-500 text-white"
        : "border-zinc-300 text-transparent hover:border-zinc-400 dark:border-zinc-600 dark:hover:border-zinc-500"
    }`}
  >
    ✓
  </button>
);

const Row = ({
  thread,
  active,
  checked,
  onToggle,
  onMenu,
}: {
  thread: Thread;
  active: boolean;
  checked: boolean;
  onToggle: (event: MouseEvent) => void;
  onMenu: (event: MouseEvent, thread: Thread) => void;
}) => {
  const status = statusOf(thread.status);
  const live = thread.status === "investigating";
  return (
    <div
      onContextMenu={(event) => onMenu(event, thread)}
      className={`flex gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800/70 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 ${
        checked ? "bg-sky-50 dark:bg-sky-950/40" : active ? "bg-zinc-100 dark:bg-zinc-800" : ""
      } ${thread.status === "ignored" ? "opacity-50" : ""}`}
    >
      <Tick checked={checked} onToggle={onToggle} />
      {/* The tick sits outside the link: a button nested in an anchor is
          invalid, and the click would navigate before it ever toggled. */}
      <a href={`#/t/${thread.short_id}`} className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0" title={status.label}>
            {status.icon}
          </span>
          <span className="flex-1 min-w-0 truncate font-medium text-[15px]">{thread.subject || "(no subject)"}</span>
          <span className="shrink-0 text-xs text-zinc-400">{when(thread.last_at ?? thread.updated_at)}</span>
        </div>
        <div className="mt-0.5 pl-6 flex items-center gap-2 text-xs text-zinc-500">
          <span className="truncate">{sender(thread.from_addr)}</span>
          {live && (
            <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-300">
              <span className="size-1.5 rounded-full bg-sky-500 animate-pulse" /> working
            </span>
          )}
          {thread.suspicious ? <span title="Email asks the reader to take action">⚠️</span> : null}
        </div>
        {thread.reason && <p className="mt-1 pl-6 text-xs text-zinc-500 line-clamp-2">{thread.reason}</p>}
      </a>
    </div>
  );
};

const BarButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button
    onClick={onClick}
    className="rounded px-2 py-0.5 hover:bg-white/70 dark:hover:bg-zinc-700 disabled:opacity-50"
  >
    {label}
  </button>
);

export const ThreadList = ({ result, selected }: { result: AsyncResult.AsyncResult<readonly Thread[], ApiError>; selected: string | null }) => {
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; thread: Thread } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const setStatus = useAtomSet(setStatusAtom, { mode: "promise" });
  const archive = useAtomSet(archiveAtom, { mode: "promise" });
  const runBulk = useAtomSet(bulkAtom, { mode: "promiseExit" });
  const [ticked, setTicked] = useAtom(selectionAtom);
  const view = useAtomValue(viewAtom);
  // Where the last tick landed, so shift-click has a range to fill.
  const anchor = useRef<number | null>(null);

  const threads = AsyncResult.value(result);
  const rows = threads._tag === "Some" ? threads.value : [];
  const visible = new Set(rows.map((thread) => thread.short_id));
  // Polling refreshes the list under the selection, so a row that has since
  // left the view must not keep voting on what an action applies to.
  const chosen = rows.filter((thread) => ticked.has(thread.short_id)).map((thread) => thread.short_id);
  const archiving = view === "archived" ? "unarchive" : "archive";

  const clear = () => setTicked(new Set<string>());

  // promiseExit rather than promise: a rejected promise here would be swallowed
  // as an unhandled rejection, and the rows would simply stay put with nothing
  // said. Losing a 40-row archive silently is the whole failure worth avoiding.
  const apply = async (action: BulkAction, ids: readonly string[] = chosen) => {
    if (ids.length === 0) return;
    const exit = await runBulk({ shortIds: ids, action });
    if (!Exit.isSuccess(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      setNotice(
        error._tag === "Some" && error.value instanceof ApiError && error.value.signedOut
          ? "Signed out — sign in again, then retry."
          : `Could not ${action} ${ids.length === 1 ? "that report" : `those ${ids.length} reports`}. Nothing changed.`,
      );
      return;
    }
    setNotice(
      exit.value.skipped > 0
        ? `${exit.value.changed} moved · ${exit.value.skipped} left alone, still investigating`
        : null,
    );
  };

  // Switching lists is a change of subject; carrying ticks across it would
  // leave an action pointed at rows that are no longer on screen.
  useEffect(() => clear(), [view]);

  useEffect(() => {
    if (ticked.size > 0 && [...ticked].every((id) => !visible.has(id))) clear();
  }, [rows.length]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable]")) return;
      if (event.key === "Escape") return clear();
      if (chosen.length === 0 || event.metaKey || event.ctrlKey || event.altKey) return;
      // Gmail's keys, because that is the muscle memory this list inherits.
      if (event.key === "e") void apply(archiving);
      if (event.key === "#") void apply("ignore");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [chosen.join(","), archiving]);

  if (threads._tag === "None") {
    return (
      <div className="flex-1 grid place-items-center text-sm text-zinc-400">
        {AsyncResult.isFailure(result) ? "Could not load threads." : "Loading…"}
      </div>
    );
  }

  const toggle = (index: number, event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const next = new Set(ticked);
    const from = event.shiftKey && anchor.current !== null ? anchor.current : index;
    const [lo, hi] = from <= index ? [from, index] : [index, from];
    // A shift-click extends rather than flips: every row in the range takes
    // the state the clicked row is heading to.
    const on = !ticked.has(rows[index]!.short_id);
    for (let i = lo; i <= hi; i++) {
      const id = rows[i]!.short_id;
      if (on) next.add(id);
      else next.delete(id);
    }
    anchor.current = index;
    setTicked(next);
  };

  const itemsFor = (thread: Thread): MenuItem[] => {
    const shortId = thread.short_id;
    // Right-clicking inside a selection acts on the selection; right-clicking
    // outside one is about the row under the cursor.
    if (chosen.length > 1 && ticked.has(shortId)) {
      return [
        { label: `${chosen.length} selected`, onSelect: () => {} },
        "separator",
        { label: view === "archived" ? "Unarchive all" : "Archive all", onSelect: () => void apply(archiving) },
        { label: "Investigate all", onSelect: () => void apply("queue") },
        { label: "Ignore all", onSelect: () => void apply("ignore") },
        "separator",
        { label: "Clear selection", onSelect: clear },
      ];
    }
    const link = `${window.location.origin}/#/t/${shortId}`;
    const busy = thread.status === "investigating";
    return [
      { label: "Open", onSelect: () => (window.location.hash = `#/t/${shortId}`) },
      ...(thread.pr_url ? [{ label: "Open PR ↗", onSelect: () => window.open(thread.pr_url!, "_blank") }] : []),
      { label: "Copy link", onSelect: () => void navigator.clipboard.writeText(link) },
      "separator",
      ...(!busy && thread.status !== "queued" ? [{ label: "Investigate", onSelect: () => void setStatus({ shortId, status: "queued" }) }] : []),
      ...(!busy && thread.status !== "ignored" ? [{ label: "Ignore", onSelect: () => void setStatus({ shortId, status: "ignored" }) }] : []),
      {
        label: thread.archived_at ? "Unarchive" : "Archive",
        onSelect: () => void archive({ shortId, archived: !thread.archived_at }),
      },
    ];
  };

  return (
    <>
      {chosen.length > 0 && (
        <div className="flex items-center gap-1 border-b border-zinc-200 bg-zinc-100 px-4 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-800/60">
          <span className="mr-1 font-medium">{chosen.length} selected</span>
          <BarButton label={view === "archived" ? "Unarchive" : "Archive"} onClick={() => void apply(archiving)} />
          {view !== "archived" && <BarButton label="Ignore" onClick={() => void apply("ignore")} />}
          <BarButton label="Investigate" onClick={() => void apply("queue")} />
          <span className="flex-1" />
          {chosen.length < rows.length && (
            <BarButton label="All" onClick={() => setTicked(new Set(rows.map((thread) => thread.short_id)))} />
          )}
          <BarButton label="Clear" onClick={clear} />
        </div>
      )}
      {notice && <div className="border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">{notice}</div>}
      <nav className="pane flex-1 overflow-y-auto">
        {rows.length === 0 && <div className="p-6 text-sm text-zinc-400">No reports yet.</div>}
        {rows.map((thread, index) => (
          <Row
            key={thread.short_id}
            thread={thread}
            active={thread.short_id === selected}
            checked={ticked.has(thread.short_id)}
            onToggle={(event) => toggle(index, event)}
            onMenu={(event, t) => {
              event.preventDefault();
              setMenu({ at: { x: event.clientX, y: event.clientY }, thread: t });
            }}
          />
        ))}
        {menu && <ContextMenu at={menu.at} items={itemsFor(menu.thread)} onClose={() => setMenu(null)} />}
      </nav>
    </>
  );
};
