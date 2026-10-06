import * as Atom from "effect/reactivity/Atom";
import * as Effect from "effect/Effect";
import * as api from "./api";

const runtime = api.Client.runtime;

/** The hash is the router: `#/t/<short_id>` opens a thread. */
export const routeAtom = Atom.make(() => window.location.hash).pipe(Atom.keepAlive);

/** The inbox's title, owner and sign-in link. */
export const configAtom = runtime.atom(api.getConfig).pipe(Atom.keepAlive);

/** Which list is showing: the inbox, what was ignored, or the archive. */
export const viewAtom = Atom.make<api.View>("inbox").pipe(Atom.keepAlive);

export const threadsAtom = runtime.atom((get) => api.listThreads(get(viewAtom))).pipe(Atom.keepAlive);

/** The short ids ticked in the list. Empty means the list is in its normal state. */
export const selectionAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive);

export const threadAtom = Atom.family((shortId: string) => runtime.atom(api.getThread(shortId)));

export const relatedAtom = Atom.family((shortId: string) => runtime.atom(api.getRelated(shortId)));

export const sendNoteAtom = runtime.fn(
  ({ shortId, text, attachments }: { shortId: string; text: string; attachments: api.Upload[] }, get) =>
    api.sendNote(shortId, text, attachments).pipe(
      Effect.tap(() => Effect.sync(() => {
        get.refresh(threadAtom(shortId));
        get.refresh(threadsAtom);
      })),
    ),
);

export const setStatusAtom = runtime.fn(
  ({ shortId, status }: { shortId: string; status: "queued" | "ignored" }, get) =>
    api.setStatus(shortId, status).pipe(
      Effect.tap(() => Effect.sync(() => {
        get.refresh(threadAtom(shortId));
        get.refresh(threadsAtom);
      })),
    ),
);

export const archiveAtom = runtime.fn(
  ({ shortId, archived }: { shortId: string; archived: boolean }, get) =>
    api.setArchived(shortId, archived).pipe(
      Effect.tap(() => Effect.sync(() => {
        get.refresh(threadAtom(shortId));
        get.refresh(threadsAtom);
      })),
    ),
);

export const bulkAtom = runtime.fn(
  ({ shortIds, action }: { shortIds: readonly string[]; action: api.BulkAction }, get) =>
    api.bulk(shortIds, action).pipe(
      Effect.tap(() => Effect.sync(() => {
        // The rows are about to leave the list, so drop the ticks with them
        // rather than holding a selection the user can no longer see.
        get.set(selectionAtom, new Set<string>());
        get.refresh(threadsAtom);
        for (const shortId of shortIds) get.refresh(threadAtom(shortId));
      })),
    ),
);
