import { FilesApi, InboxApi, PublicApi } from "@skusez/pokecenter/Api";
import type { BulkAction, InboxConfig, NoteUpload, View } from "@skusez/pokecenter/Api";
import type { Digest, Event, Related, Report, Scores, StoredAttachment, Thread } from "@skusez/pokecenter/Domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";

export type { BulkAction, Digest, Event, InboxConfig, Related, Report, Thread, View };
export type Attachment = StoredAttachment;
export type Upload = NoteUpload;

/** Any failed call, reduced to what the UI acts on: a status and a message. */
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  status: Schema.Number,
  message: Schema.String,
}) {
  get signedOut() {
    return this.status === 401;
  }
}

/** The groups the browser calls. The agent's endpoints need a bearer the
 * browser never holds, so they stay out of this client. */
class BrowserApi extends HttpApi.make("pokecenter").add(PublicApi).add(InboxApi).add(FilesApi) {}

/** The typed client and the atom runtime that runs it. Same-origin cookies
 * authenticate the browser, so there is no client middleware to provide. */
export class Client extends AtomHttpApi.Service<Client>()("pokecenter/ui/Client", {
  api: BrowserApi,
  httpClient: FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "same-origin" })),
  ),
  baseUrl: window.location.origin,
}) {}

const STATUS_BY_TAG: Record<string, number> = {
  Unauthorized: 401,
  BadRequest: 400,
  NotFound: 404,
  Conflict: 409,
  PayloadTooLarge: 413,
};

const toApiError = (cause: unknown): ApiError => {
  if (cause instanceof ApiError) return cause;
  if (HttpClientError.isHttpClientError(cause)) {
    return new ApiError({ status: cause.response?.status ?? 0, message: cause.message });
  }
  const tagged = cause as { _tag?: string; message?: string };
  const status = (tagged._tag && STATUS_BY_TAG[tagged._tag]) || 0;
  return new ApiError({ status, message: tagged.message || String(cause) });
};

/** Runs one call on the inbox client, with every failure as an `ApiError`. */
const call = <A, E>(f: (inbox: InboxClient) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const client = yield* Client;
    return yield* f(client.inbox);
  }).pipe(Effect.mapError(toApiError));

type InboxClient = HttpApiClient.ForApi<typeof BrowserApi>["inbox"];

export const getConfig = Effect.gen(function* () {
  const client = yield* Client;
  return yield* client.public.config();
}).pipe(Effect.mapError(toApiError));

export const listThreads = (view: View) =>
  call((inbox) => inbox.threads({ query: { view } })).pipe(Effect.map((r) => r.threads));

export const getThread = (shortId: string) => call((inbox) => inbox.thread({ params: { shortId } }));

export const getRelated = (shortId: string) =>
  call((inbox) => inbox.related({ params: { shortId } })).pipe(Effect.map((r) => r.related));

export const sendNote = (shortId: string, text: string, attachments: readonly Upload[]) =>
  call((inbox) => inbox.addNote({ params: { shortId }, payload: { text, attachments } }));

export const setStatus = (shortId: string, status: "queued" | "ignored") =>
  call((inbox) => inbox.setStatus({ params: { shortId }, payload: { status } }));

export const setArchived = (shortId: string, archived: boolean) =>
  call((inbox) => inbox.archive({ params: { shortId }, payload: { archived } }));

/** `changed` counts what moved; `skipped` counts reports an investigation held. */
export const bulk = (shortIds: readonly string[], action: BulkAction) =>
  call((inbox) => inbox.bulk({ payload: { shortIds, action } }));

export const parseJson = (json: string | null): Record<string, any> => {
  try {
    const value = JSON.parse(json ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};

/** A status event's body. */
export const parseStatusBody = (json: string): Record<string, any> & { scores: Scores | null; category: string | null } => {
  const body = parseJson(json);
  return { ...body, scores: body.scores ?? null, category: body.category ?? null };
};

export const parseDigest = (json: string | null): Digest | null => {
  if (!json) return null;
  try {
    const d = JSON.parse(json) as Partial<Digest>;
    if (!d.summary || !d.request) return null;
    return { reporter: d.reporter ?? "", summary: d.summary, request: d.request, expected: d.expected ?? null, details: d.details ?? [], asks: d.asks ?? [] };
  } catch {
    return null;
  }
};

/** A plain URL, not a client call: <img> and links load it with the browser's cookies. */
export const attachmentUrl = (shortId: string, key: string) => `/a/${shortId}?key=${encodeURIComponent(key)}`;

export const parseAttachments = (json: string | null): Attachment[] => {
  try {
    const value = JSON.parse(json ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};
