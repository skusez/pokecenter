/**
 * The HTTP API, shared by the worker that serves it, the agent that runs
 * investigations, and the thread UI. Definition only: no server code.
 */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "effect/http-api"
import { BACKENDS } from "./Profile.ts"
import { Decision, Event, QueuedReport, Related, Report, Thread } from "./Domain.ts"

// ---- Errors ----

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 }
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 }
) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

/** The request is valid but the report is not in a state to take it. */
export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String },
  { httpApiStatus: 409 }
) {}

export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()(
  "PayloadTooLarge",
  { message: Schema.String },
  { httpApiStatus: 413 }
) {}

// ---- Auth ----

/**
 * The owner: the agent's bearer token, or whatever the inbox's auth policy
 * accepts (an SSO cookie, a Cloudflare Access token). Clients may send the
 * bearer; the browser relies on its cookies instead.
 */
export class OwnerAuth extends HttpApiMiddleware.Service<OwnerAuth>()("pokecenter/OwnerAuth", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}

/** The agent machine only, by bearer token. */
export class AgentAuth extends HttpApiMiddleware.Service<AgentAuth>()("pokecenter/AgentAuth", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}

// ---- Shapes ----

export const Ok = Schema.Struct({ ok: Schema.Boolean })

export const InboxConfig = Schema.Struct({
  title: Schema.String,
  owner: Schema.String,
  signIn: Schema.NullOr(Schema.Struct({ label: Schema.String, url: Schema.String })),
  categories: Schema.Array(Schema.Struct({ id: Schema.String, description: Schema.String }))
})
export type InboxConfig = typeof InboxConfig.Type

export const View = Schema.Literals(["inbox", "ignored", "archived"])
export type View = typeof View.Type

export const BulkAction = Schema.Literals(["archive", "unarchive", "ignore", "queue"])
export type BulkAction = typeof BulkAction.Type

/** A file the owner attaches to a note, base64 in the JSON body. Small by
 * nature (screenshots), so a multipart parser would buy nothing. */
export const NoteUpload = Schema.Struct({
  filename: Schema.String,
  mimeType: Schema.String,
  data: Schema.String
})
export type NoteUpload = typeof NoteUpload.Type

/** Fields the agent may write on a report. */
export const ReportPatch = Schema.Struct({
  status: Schema.optional(Schema.String),
  verdict: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  pr_url: Schema.optional(Schema.NullOr(Schema.String)),
  findings: Schema.optional(Schema.String),
  suspicious: Schema.optional(Schema.String),
  digest: Schema.optional(Schema.String)
})
export type ReportPatch = typeof ReportPatch.Type

export const TriageResult = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  ...Decision.fields
})
export type TriageResult = typeof TriageResult.Type

const Bytes = Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array())

// ---- Groups ----

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/healthz", { success: Ok })
) {}

/** What a signed-out browser needs to show who the inbox is and where to sign in. */
export class PublicApi extends HttpApiGroup.make("public")
  .add(HttpApiEndpoint.get("config", "/config", { success: InboxConfig }))
  .prefix("/api")
{}

/** The thread UI's API: the owner on any device. */
export class InboxApi extends HttpApiGroup.make("inbox")
  .add(
    HttpApiEndpoint.get("threads", "/threads", {
      query: { view: Schema.optional(View) },
      success: Schema.Struct({ threads: Schema.Array(Thread) })
    }),
    HttpApiEndpoint.post("bulk", "/threads/bulk", {
      payload: Schema.Struct({ shortIds: Schema.Array(Schema.String), action: BulkAction }),
      success: Schema.Struct({ ok: Schema.Boolean, changed: Schema.Number, skipped: Schema.Number }),
      error: BadRequest
    }),
    HttpApiEndpoint.get("thread", "/threads/:shortId", {
      params: { shortId: Schema.String },
      success: Schema.Struct({ report: Report, events: Schema.Array(Event) }),
      error: NotFound
    }),
    HttpApiEndpoint.get("related", "/threads/:shortId/related", {
      params: { shortId: Schema.String },
      success: Schema.Struct({ related: Schema.Array(Related) }),
      error: NotFound
    }),
    HttpApiEndpoint.get("events", "/threads/:shortId/events", {
      params: { shortId: Schema.String },
      query: { after: Schema.optional(Schema.NumberFromString) },
      success: Schema.Struct({ status: Schema.String, updated_at: Schema.String, events: Schema.Array(Event) }),
      error: NotFound
    }),
    HttpApiEndpoint.post("addNote", "/threads/:shortId/notes", {
      params: { shortId: Schema.String },
      payload: Schema.Struct({ text: Schema.String, attachments: Schema.optional(Schema.Array(NoteUpload)) }),
      success: Ok,
      error: [NotFound, BadRequest, Conflict, PayloadTooLarge]
    }),
    HttpApiEndpoint.post("archive", "/threads/:shortId/archive", {
      params: { shortId: Schema.String },
      payload: Schema.Struct({ archived: Schema.optional(Schema.Boolean) }),
      success: Ok,
      error: NotFound
    }),
    HttpApiEndpoint.post("setStatus", "/threads/:shortId/status", {
      params: { shortId: Schema.String },
      payload: Schema.Struct({ status: Schema.Literals(["queued", "ignored"]) }),
      success: Ok,
      error: NotFound
    })
  )
  .middleware(OwnerAuth)
  .prefix("/api")
{}

/** Attachments for the thread UI. Outside /api so an <img> can load them. */
export class FilesApi extends HttpApiGroup.make("files")
  .add(
    HttpApiEndpoint.get("attachment", "/a/:shortId", {
      params: { shortId: Schema.String },
      query: { key: Schema.String },
      success: Bytes,
      error: NotFound
    })
  )
  .middleware(OwnerAuth)
{}

/** Telegram's webhook. Authenticated by the secret Telegram echoes back. */
export class TelegramApi extends HttpApiGroup.make("telegram").add(
  HttpApiEndpoint.post("webhook", "/tg", {
    headers: { "x-telegram-bot-api-secret-token": Schema.optional(Schema.String) },
    payload: Schema.Unknown,
    success: Ok,
    error: Unauthorized
  })
) {}

/** The agent machine: queue, progress, results, and on-demand triage. */
export class AgentApi extends HttpApiGroup.make("agent")
  .add(
    HttpApiEndpoint.post("registerWebhook", "/tg/register", {
      success: Schema.Struct({ ok: Schema.Boolean, description: Schema.optional(Schema.String) })
    }),
    HttpApiEndpoint.post("triage", "/triage", {
      payload: Schema.Struct({
        ids: Schema.optional(Schema.Array(Schema.String)),
        /** Answer without writing or sending anything. */
        dry: Schema.optional(Schema.Boolean),
        /** A backend other than the deployed one. Dry runs only. */
        backend: Schema.optional(Schema.Literals(BACKENDS)),
        /** False leaves the screenshots out. Dry runs only. */
        images: Schema.optional(Schema.Boolean)
      }),
      success: Schema.Struct({ results: Schema.Array(TriageResult) }),
      error: BadRequest
    }),
    HttpApiEndpoint.get("queue", "/queue", {
      query: { status: Schema.optional(Schema.String), limit: Schema.optional(Schema.NumberFromString) },
      success: Schema.Struct({ reports: Schema.Array(QueuedReport) })
    }),
    HttpApiEndpoint.get("attachment", "/attachment", {
      query: { key: Schema.String },
      success: Bytes,
      error: NotFound
    }),
    HttpApiEndpoint.get("related", "/related", {
      query: { report: Schema.String },
      success: Schema.Struct({ related: Schema.Array(Related) }),
      error: NotFound
    }),
    HttpApiEndpoint.post("postEvents", "/event", {
      payload: Schema.Struct({
        report_id: Schema.String,
        events: Schema.Array(Schema.Struct({ kind: Schema.String, body: Schema.Unknown }))
      }),
      success: Schema.Struct({ ok: Schema.Boolean, count: Schema.Number })
    }),
    HttpApiEndpoint.post("patchReport", "/report/:id", {
      params: { id: Schema.String },
      payload: ReportPatch,
      /** `notified` false means a card that should have gone out did not. */
      success: Schema.Struct({ ok: Schema.Boolean, notified: Schema.Boolean }),
      error: NotFound
    })
  )
  .middleware(AgentAuth)
{}

export class Api extends HttpApi.make("pokecenter")
  .add(SystemApi)
  .add(PublicApi)
  .add(InboxApi)
  .add(FilesApi)
  .add(TelegramApi)
  .add(AgentApi)
{}
