import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useEffect, useRef, useState } from "react";
import { useConfig, usePolling } from "./App";
import { attachmentUrl, parseAttachments, parseDigest, parseJson as parse, parseStatusBody, type Attachment, type Event, type Report } from "./api";
import { archiveAtom, relatedAtom, setStatusAtom, threadAtom } from "./atoms";
import { Composer } from "./Composer";
import { OUTCOME, sender, statusOf, when } from "./format";

const Files = ({ files, shortId }: { files: Attachment[]; shortId: string }) =>
  files.length === 0 ? null : (
    <div className="mt-2 flex flex-wrap gap-2">
      {files.map((file) => {
        const url = attachmentUrl(shortId, file.key);
        return file.mimeType.startsWith("image/") ? (
          <a key={file.key} href={url} target="_blank" rel="noreferrer" className="block">
            <img src={url} alt={file.filename} className="max-h-56 max-w-full rounded-lg border border-zinc-200 dark:border-zinc-700" loading="lazy" />
          </a>
        ) : (
          <a key={file.key} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs">
            📎 {file.filename}
          </a>
        );
      })}
    </div>
  );

const Time = ({ iso }: { iso: string }) => <span className="text-[11px] text-zinc-400 tabular-nums">{when(iso)}</span>;

/** Left column: the client, the agent, the system. */
const Left = ({ children, time, icon }: { children: React.ReactNode; time: string; icon?: string }) => (
  <div className="flex gap-3 max-w-3xl">
    <div className="mt-1 size-7 shrink-0 grid place-items-center rounded-full bg-zinc-200 dark:bg-zinc-700 text-sm">{icon ?? "🤖"}</div>
    <div className="min-w-0 flex-1">
      {children}
      <div className="mt-1">
        <Time iso={time} />
      </div>
    </div>
  </div>
);

/** Right column: the owner. */
const Right = ({ children, time, who }: { children: React.ReactNode; time: string; who?: string | undefined }) => (
  <div className="flex flex-col items-end">
    <div title={who} className="max-w-2xl rounded-2xl rounded-br-sm bg-sky-600 text-white px-3.5 py-2 text-[15px] whitespace-pre-wrap">{children}</div>
    <div className="mt-1 mr-1">
      <Time iso={time} />
    </div>
  </div>
);

const Card = ({ children, tone = "" }: { children: React.ReactNode; tone?: string }) => (
  <div className={`rounded-2xl rounded-tl-sm border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-[#1c1c1f] px-3.5 py-2.5 text-[15px] ${tone}`}>{children}</div>
);

/** The email as a fixed template, with the untouched original a click away. */
const Email = ({ report }: { report: Report }) => {
  const digest = parseDigest(report.digest);
  const [original, setOriginal] = useState(digest === null);
  const [whole, setWhole] = useState(report.body.length < 1_200);
  const body = whole ? report.body : `${report.body.slice(0, 1_200)}…`;
  const files = parseAttachments(report.attachments);

  return (
    <Left time={report.received_at} icon="✉️">
      <Card>
        <div className="text-xs text-zinc-500 mb-1">
          {digest?.reporter || sender(report.from_addr)}
          {report.suspicious ? <span className="ml-2 text-amber-600">⚠️ asks the reader to take action</span> : null}
        </div>
        <div className="font-semibold">{report.subject}</div>

        {digest && !original && (
          <div className="mt-2 space-y-2.5 text-[14px] leading-relaxed">
            <p className="text-zinc-800 dark:text-zinc-200">{digest.request}</p>
            {digest.expected && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-400">Wants</div>
                <p>{digest.expected}</p>
              </div>
            )}
            {digest.details.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-400">Details</div>
                <ul className="list-disc pl-5 space-y-0.5">
                  {digest.details.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              </div>
            )}
            {digest.asks.length > 0 && (
              <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1.5">
                <div className="text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-300">Asks of the reader</div>
                <ul className="list-disc pl-5 space-y-0.5">
                  {digest.asks.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        {(original || !digest) && (
          <>
            <pre className="mt-1.5 whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-[inherit] text-[14px] leading-relaxed text-zinc-700 dark:text-zinc-300">{body}</pre>
            {report.body.length >= 1_200 && (
              <button className="mt-1 text-xs text-sky-600" onClick={() => setWhole(!whole)}>
                {whole ? "Show less" : "Show the whole email"}
              </button>
            )}
          </>
        )}

        {digest && (
          <button className="mt-2 block text-xs text-sky-600" onClick={() => setOriginal(!original)}>
            {original ? "Show the summary" : "Show the original email"}
          </button>
        )}
        <Files files={files} shortId={report.short_id} />
      </Card>
    </Left>
  );
};

/** A later email that landed on this thread. */
const FollowUpMail = ({ event, shortId }: { event: Event; shortId: string }) => {
  const body = parse(event.body);
  const [whole, setWhole] = useState(String(body.body ?? "").length < 800);
  const text = String(body.body ?? "");
  return (
    <Left time={event.created_at} icon="↩️">
      <Card>
        <div className="text-xs text-zinc-500 mb-1">{sender(body.from ?? "")} · follow-up</div>
        <pre className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-[inherit] text-[14px] leading-relaxed text-zinc-700 dark:text-zinc-300">
          {whole ? text : `${text.slice(0, 800)}…`}
        </pre>
        {text.length >= 800 && (
          <button className="mt-1 text-xs text-sky-600" onClick={() => setWhole(!whole)}>
            {whole ? "Show less" : "Show the whole email"}
          </button>
        )}
        <Files files={body.attachments ?? []} shortId={shortId} />
      </Card>
    </Left>
  );
};

/** Earlier reports the agent is told about; the same list, for you. */
const RelatedList = ({ shortId }: { shortId: string }) => {
  const result = useAtomValue(relatedAtom(shortId));
  const value = AsyncResult.value(result);
  if (value._tag === "None" || value.value.length === 0) return null;
  return (
    <div className="ml-10 max-w-3xl text-xs text-zinc-500">
      <span className="uppercase tracking-wide text-[11px]">Related</span>
      <ul className="mt-1 space-y-0.5">
        {value.value.map((r) => (
          <li key={r.short_id} className="flex items-baseline gap-2">
            <span>{statusOf(r.status).icon}</span>
            <a href={`#/t/${r.short_id}`} className="truncate text-zinc-700 dark:text-zinc-300 hover:underline">{r.subject}</a>
            <span className="shrink-0">{when(r.received_at)}</span>
            {r.outcome && <span className="shrink-0">· {OUTCOME[r.outcome]?.label ?? r.outcome}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
};

/** The triage model behind a status event, by the name it is stored under. */
const TRIAGE_MODELS: Record<string, string> = { jev: "Jev", clef: "Clef", "clef-flash": "Clef-flash", open: "Qwen" };

const Status = ({ event, report }: { event: Event; report: Report }) => {
  const body = parseStatusBody(event.body);
  const status = statusOf(body.status);
  const model = typeof body.by === "string" ? TRIAGE_MODELS[body.by] : undefined;
  const by = model ? `by ${model}` : body.by === "telegram" ? "from Telegram" : body.by === "web" ? "from here" : undefined;

  if (body.status === "done") {
    const outcome = OUTCOME[body.outcome] ?? { label: body.outcome ?? "Done", icon: "•" };
    return (
      <Left time={event.created_at} icon={outcome.icon}>
        <Card tone="border-emerald-300 dark:border-emerald-800">
          <div className="font-semibold">{outcome.label}</div>
          {body.findings && <pre className="mt-1.5 whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-[inherit] text-[14px] leading-relaxed">{body.findings}</pre>}
          {body.pr_url && (
            <a href={body.pr_url} target="_blank" rel="noreferrer" className="mt-2 inline-block rounded-md bg-emerald-600 px-2.5 py-1 text-sm text-white">
              {body.outcome === "pr_opened" ? "Review draft PR" : "Open PR"} ↗
            </a>
          )}
          {!body.pr_url && body.branch && <div className="mt-1 text-xs text-zinc-500">branch {body.branch}</div>}
        </Card>
      </Left>
    );
  }
  if (body.status === "error") {
    return (
      <Left time={event.created_at} icon="💥">
        <Card tone="border-red-300 dark:border-red-900">
          <div className="font-semibold">Investigation failed</div>
          <pre className="mt-1 whitespace-pre-wrap font-[inherit] text-[13px] text-zinc-600 dark:text-zinc-400">{body.findings}</pre>
        </Card>
      </Left>
    );
  }
  if (body.status === "archived" || body.status === "unarchived") {
    return (
      <div className="text-center text-xs text-zinc-400">
        {body.status === "archived" ? "Archived" : "Back in the inbox"} · {when(event.created_at)}
      </div>
    );
  }
  const reason = body.reason ?? (body.status === "ignored" || body.status === "needs_owner" || body.status === "queued" ? report.reason : null);
  return (
    <Left time={event.created_at} icon={status.icon}>
      <Card>
        <span className="font-semibold">{status.label}</span>
        {by && <span className="ml-2 text-xs text-zinc-400">{by}</span>}
        {body.category && body.category !== "unknown" && <span className="ml-2 text-xs rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5">{body.category}</span>}
        {body.severity && <span className="ml-1 text-xs rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5">{body.severity}</span>}
        {reason && (body.by === "agent" || model) && <div className="mt-1 text-[14px] text-zinc-600 dark:text-zinc-300">{reason}</div>}
      </Card>
    </Left>
  );
};

const Note = ({ event, shortId }: { event: Event; shortId: string }) => {
  const body = parse(event.body);
  const files: Attachment[] = body.attachments ?? [];
  const owner = useConfig()?.owner;
  return (
    <Right time={event.created_at} who={owner}>
      {body.text}
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {files.map((file) =>
            file.mimeType.startsWith("image/") ? (
              <a key={file.key} href={attachmentUrl(shortId, file.key)} target="_blank" rel="noreferrer">
                <img src={attachmentUrl(shortId, file.key)} alt={file.filename} className="max-h-48 rounded-lg" />
              </a>
            ) : (
              <a key={file.key} href={attachmentUrl(shortId, file.key)} target="_blank" rel="noreferrer" className="underline text-sm">
                📎 {file.filename}
              </a>
            ),
          )}
        </div>
      )}
    </Right>
  );
};

const TOOL_ICON: Record<string, string> = { bash: "$", read: "📄", edit: "✏️", write: "✏️", grep: "🔍", glob: "🔍", list: "📁", webfetch: "🌐", search_knowledge: "📚" };

/** A run of consecutive agent steps, folded so the thread stays readable. */
const Steps = ({ events, live }: { events: readonly Event[]; live: boolean }) => {
  const [open, setOpen] = useState(live);
  const steps = events.map((event) => ({ event, body: parse(event.body) }));
  const tools = steps.filter((s) => s.body.type === "tool");
  const texts = steps.filter((s) => s.body.type === "text" && !String(s.body.text).trim().startsWith("{"));
  const last = steps[steps.length - 1]!;
  const summary = `${tools.length} tool call${tools.length === 1 ? "" : "s"}${texts.length ? `, ${texts.length} note${texts.length === 1 ? "" : "s"}` : ""}`;

  return (
    <Left time={last.event.created_at} icon="🔎">
      <div className="rounded-2xl rounded-tl-sm border border-dashed border-zinc-300 dark:border-zinc-700 px-3.5 py-2 text-[14px]">
        <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)}>
          {live && <span className="size-2 rounded-full bg-sky-500 animate-pulse" />}
          <span className="font-medium">{live ? "Working" : "Worked"}</span>
          <span className="text-zinc-500">· {summary}</span>
          <span className="ml-auto text-zinc-400">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <ol className="mt-2 space-y-1.5 border-t border-zinc-200 dark:border-zinc-800 pt-2">
            {steps.map(({ event, body }) => (
              <li key={event.id} className="text-[13px]">
                {body.type === "tool" ? (
                  <details className="group">
                    <summary className="cursor-pointer list-none flex gap-2 text-zinc-700 dark:text-zinc-300">
                      <span className="w-5 text-center text-zinc-400">{TOOL_ICON[body.tool] ?? "⚙️"}</span>
                      <span className="truncate">{body.title ?? body.tool}</span>
                      {body.status === "error" && <span className="text-red-500">failed</span>}
                    </summary>
                    {(body.input || body.output) && (
                      <pre className="mt-1 ml-7 max-h-64 overflow-auto rounded bg-zinc-100 dark:bg-zinc-900 p-2 text-[12px] whitespace-pre-wrap">
                        {body.input ? `› ${body.input}\n` : ""}
                        {body.output ?? ""}
                      </pre>
                    )}
                  </details>
                ) : body.type === "text" ? (
                  <div className="ml-7 whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{String(body.text).trim().startsWith("{") ? <span className="text-zinc-400">answered</span> : body.text}</div>
                ) : body.type === "reasoning" ? (
                  <div className="ml-7 italic text-zinc-500">{body.text}</div>
                ) : body.type === "error" ? (
                  <div className="ml-7 text-red-500">{body.text}</div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Left>
  );
};

/** Groups consecutive `step` events so each investigation is one fold. */
const group = (events: readonly Event[]): (Event | Event[])[] => {
  const out: (Event | Event[])[] = [];
  for (const event of events) {
    if (event.kind !== "step") {
      out.push(event);
      continue;
    }
    const last = out[out.length - 1];
    if (Array.isArray(last)) last.push(event);
    else out.push([event]);
  }
  return out;
};

export const Thread = ({ shortId }: { shortId: string }) => {
  const atom = threadAtom(shortId);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const setStatus = useAtomSet(setStatusAtom, { mode: "promise" });
  const archive = useAtomSet(archiveAtom, { mode: "promise" });
  const value = AsyncResult.value(result);
  const live = value._tag === "Some" && value.value.report.status === "investigating";
  usePolling(refresh, live ? 2_000 : 6_000);

  const bottom = useRef<HTMLDivElement>(null);
  const count = value._tag === "Some" ? value.value.events.length : 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [shortId, count]);

  if (value._tag === "None") {
    return <div className="flex-1 grid place-items-center text-sm text-zinc-400">{AsyncResult.isFailure(result) ? "Could not load this thread." : "Loading…"}</div>;
  }
  const { report, events } = value.value;
  const status = statusOf(report.status);
  const grouped = group(events.filter((e) => e.kind !== "received"));

  return (
    <>
      <header className="flex items-center gap-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] px-4 py-2.5">
        <a href="#/" className="md:hidden text-zinc-500 -ml-1 px-1">
          ‹
        </a>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{report.subject}</div>
          <div className="truncate text-xs text-zinc-500">{sender(report.from_addr)}</div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs ${status.tone}`}>
          {status.icon} {status.label}
        </span>
        {report.pr_url && (
          <a href={report.pr_url} target="_blank" rel="noreferrer" className="text-xs rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1">
            PR ↗
          </a>
        )}
        {report.status !== "investigating" && report.status !== "queued" && (
          <button className="text-xs rounded-md bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 px-2 py-1" onClick={() => setStatus({ shortId, status: "queued" })}>
            Investigate
          </button>
        )}
        {(report.status === "queued" || report.status === "needs_owner" || report.status === "new") && (
          <button className="text-xs rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1" onClick={() => setStatus({ shortId, status: "ignored" })}>
            Ignore
          </button>
        )}
        <button
          className="text-xs rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-zinc-500"
          title={report.archived_at ? "Put back in the inbox" : "Archive this thread"}
          onClick={() => archive({ shortId, archived: !report.archived_at })}
        >
          {report.archived_at ? "Unarchive" : "Archive"}
        </button>
      </header>

      <div className="pane flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <Email report={report} />
        <RelatedList shortId={shortId} />
        {grouped.map((item, index) =>
          Array.isArray(item) ? (
            <Steps key={item[0]!.id} events={item} live={live && index === grouped.length - 1} />
          ) : item.kind === "email" ? (
            <FollowUpMail key={item.id} event={item} shortId={shortId} />
          ) : item.kind === "note" ? (
            <Note key={item.id} event={item} shortId={shortId} />
          ) : item.kind === "status" ? (
            <Status key={item.id} event={item} report={report} />
          ) : null,
        )}
        {live && grouped.length > 0 && !Array.isArray(grouped[grouped.length - 1]) && (
          <Left time={report.updated_at} icon="🔎">
            <div className="text-sm text-zinc-500 flex items-center gap-2">
              <span className="size-2 rounded-full bg-sky-500 animate-pulse" /> Starting…
            </div>
          </Left>
        )}
        <div ref={bottom} />
      </div>

      <Composer shortId={shortId} disabled={report.status === "investigating"} />
    </>
  );
};
