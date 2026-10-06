/**
 * The worker's implementation of the API defined in `@skusez/pokecenter/Api`.
 */
import { Api, Profile } from "@skusez/pokecenter"
import { Context, Effect, Layer, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Attachments, prefixOf } from "./Attachments.ts"
import { AuthPolicy } from "./Auth.ts"
import { Inbox } from "./Inbox.ts"
import { isPending, Store } from "./Store.ts"
import { NOTIFYING, Telegram } from "./Telegram.ts"

/** Secrets read per request, so rotating one needs no redeploy. */
export class Secrets extends Context.Service<Secrets, {
  readonly agentToken: Effect.Effect<string>
  readonly webhookSecret: Effect.Effect<string>
}>()("pokecenter/Secrets") {}

/** The inbox's profile and public origin. */
export class Settings extends Context.Service<Settings, {
  readonly profile: Profile.Profile
  /** e.g. https://inbox.example.com, for links in cards and the webhook URL. */
  readonly origin: string
}>()("pokecenter/Settings") {}

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

const unauthorized = new Api.Unauthorized({ message: "Sign in to view this inbox" })

// ---- Middleware ----

export const AgentAuthLive = Layer.effect(
  Api.AgentAuth,
  Effect.gen(function*() {
    const secrets = yield* Secrets
    return Api.AgentAuth.of({
      bearer: Effect.fn(function*(httpEffect, { credential }) {
        const expected = yield* secrets.agentToken
        // A missing header arrives as an empty credential, not as an error.
        const given = Redacted.value(credential)
        if (!given || given !== expected) return yield* Effect.fail(new Api.Unauthorized({ message: "Bad token" }))
        return yield* httpEffect
      })
    })
  })
)

export const OwnerAuthLive = Layer.effect(
  Api.OwnerAuth,
  Effect.gen(function*() {
    const secrets = yield* Secrets
    const policy = yield* AuthPolicy
    return Api.OwnerAuth.of({
      bearer: Effect.fn(function*(httpEffect, { credential }) {
        const given = Redacted.value(credential)
        if (given && given === (yield* secrets.agentToken)) return yield* httpEffect
        const request = yield* HttpServerRequest.HttpServerRequest
        if (yield* policy.authorize({ headers: request.headers })) return yield* httpEffect
        return yield* Effect.fail(unauthorized)
      })
    })
  })
)

// ---- Groups ----

const SystemLive = HttpApiBuilder.group(
  Api.Api,
  "system",
  (handlers) => handlers.handle("health", () => Effect.succeed({ ok: true }))
)

const PublicLive = HttpApiBuilder.group(
  Api.Api,
  "public",
  Effect.fn(function*(handlers) {
    const { profile } = yield* Settings
    return handlers.handle("config", () =>
      Effect.succeed({
        title: profile.ui.title,
        owner: profile.owner,
        signIn: profile.ui.signIn,
        categories: Object.entries(profile.categories).map(([id, c]) => ({ id, description: c.description }))
      }))
  })
)

const reportOr404 = (store: Store["Service"], shortId: string) =>
  store.byShortId(shortId).pipe(
    Effect.flatMap((report) =>
      report ? Effect.succeed(report) : Effect.fail(new Api.NotFound({ message: `No thread ${shortId}` }))
    )
  )

const file = (attachments: Attachments["Service"], key: string) =>
  attachments.get(key).pipe(
    Effect.flatMap((stored) =>
      stored
        ? Effect.succeed(HttpServerResponse.uint8Array(stored.bytes, {
          headers: { "content-type": stored.contentType ?? "application/octet-stream" }
        }))
        : Effect.fail(new Api.NotFound({ message: "No such file" }))
    )
  )

const InboxLive = HttpApiBuilder.group(
  Api.Api,
  "inbox",
  Effect.fn(function*(handlers) {
    const store = yield* Store
    const attachments = yield* Attachments
    return handlers.handleAll({
      threads: ({ query }) => store.threads(query.view ?? "inbox").pipe(Effect.map((threads) => ({ threads }))),
      bulk: Effect.fn(function*({ payload }) {
        const shortIds = payload.shortIds.filter((id) => /^[0-9a-f]{1,32}$/.test(id))
        if (shortIds.length === 0) return yield* Effect.fail(new Api.BadRequest({ message: "nothing selected" }))
        // The list never shows more than 200, so more could only be hand-made.
        if (shortIds.length > 200) return yield* Effect.fail(new Api.BadRequest({ message: "at most 200 at a time" }))
        const result = yield* store.bulk(shortIds, payload.action)
        return { ok: true, ...result }
      }),
      thread: Effect.fn(function*({ params }) {
        const report = yield* reportOr404(store, params.shortId)
        return { report, events: yield* store.events(report.id) }
      }),
      related: Effect.fn(function*({ params }) {
        const report = yield* reportOr404(store, params.shortId)
        return { related: yield* store.related(report) }
      }),
      events: Effect.fn(function*({ params, query }) {
        const report = yield* reportOr404(store, params.shortId)
        return {
          status: report.status,
          updated_at: report.updated_at,
          events: yield* store.events(report.id, query.after ?? 0)
        }
      }),
      addNote: Effect.fn(function*({ params, payload }) {
        const report = yield* reportOr404(store, params.shortId)
        const text = payload.text.trim()
        const uploads = payload.attachments ?? []
        if (!text && uploads.length === 0) return yield* Effect.fail(new Api.BadRequest({ message: "empty note" }))
        const stored = []
        for (const upload of uploads) {
          const bytes = Uint8Array.from(atob(upload.data), (c) => c.charCodeAt(0))
          if (bytes.byteLength > MAX_UPLOAD_BYTES) {
            return yield* Effect.fail(new Api.PayloadTooLarge({ message: `${upload.filename} is over 8 MB` }))
          }
          const filename = upload.filename.replace(/[^\w.-]+/g, "_")
          // Under the report's prefix, which is what the file link checks.
          const key = `${prefixOf(report.id)}note-${Date.now()}-${filename}`
          yield* attachments.put(key, bytes, upload.mimeType)
          stored.push({ key, filename, mimeType: upload.mimeType })
        }
        const result = yield* store.addNote(report, text, stored, "web")
        if (!result.ok) return yield* Effect.fail(new Api.Conflict({ message: result.reason }))
        return { ok: true }
      }),
      archive: Effect.fn(function*({ params, payload }) {
        const report = yield* reportOr404(store, params.shortId)
        yield* store.setArchived(report, payload.archived !== false, "web")
        return { ok: true }
      }),
      setStatus: Effect.fn(function*({ params, payload }) {
        const report = yield* reportOr404(store, params.shortId)
        yield* store.setStatus(report, payload.status, "web")
        return { ok: true }
      })
    })
  })
)

const FilesLive = HttpApiBuilder.group(
  Api.Api,
  "files",
  Effect.fn(function*(handlers) {
    const store = yield* Store
    const attachments = yield* Attachments
    return handlers.handle(
      "attachment",
      Effect.fn(function*({ params, query }) {
        // Scope the link to its own report: it must not become a key for
        // every object in the bucket.
        const report = yield* reportOr404(store, params.shortId)
        if (!query.key.startsWith(prefixOf(report.id))) {
          return yield* Effect.fail(new Api.NotFound({ message: "No such file" }))
        }
        return yield* file(attachments, query.key)
      })
    )
  })
)

const TelegramLive = HttpApiBuilder.group(
  Api.Api,
  "telegram",
  Effect.fn(function*(handlers) {
    const secrets = yield* Secrets
    const inbox = yield* Inbox
    return handlers.handle(
      "webhook",
      Effect.fn(function*({ headers, payload }) {
        // The webhook URL is not secret once set; this header is the only
        // thing separating a real update from anyone POSTing here.
        const expected = yield* secrets.webhookSecret
        if (headers["x-telegram-bot-api-secret-token"] !== expected) {
          return yield* Effect.fail(new Api.Unauthorized({ message: "Bad webhook secret" }))
        }
        yield* inbox.telegramUpdate(payload as never)
        return { ok: true }
      })
    )
  })
)

const AgentLive = HttpApiBuilder.group(
  Api.Api,
  "agent",
  Effect.fn(function*(handlers) {
    const store = yield* Store
    const inbox = yield* Inbox
    const telegram = yield* Telegram
    const attachments = yield* Attachments
    const secrets = yield* Secrets
    const { origin } = yield* Settings
    return handlers.handleAll({
      registerWebhook: () =>
        secrets.webhookSecret.pipe(Effect.flatMap((secret) => telegram.setWebhook(`${origin}/tg`, secret))),
      // Triage on demand. No ids: everything still pending. `dry` answers
      // without writing or sending, which is what replay uses; only a dry run
      // may pick another backend or leave the screenshots out.
      triage: Effect.fn(function*({ payload }) {
        if ((payload.backend !== undefined || payload.images !== undefined) && !payload.dry) {
          return yield* Effect.fail(new Api.BadRequest({ message: "backend and images need dry" }))
        }
        const reports = payload.ids?.length ? yield* store.byIds(payload.ids) : yield* store.pending
        const results = []
        for (const report of reports) {
          const decision = payload.dry || !isPending(report)
            ? yield* inbox.judge(report, {
              full: !payload.dry,
              ...(payload.backend ? { backend: payload.backend } : {}),
              ...(payload.images !== undefined ? { images: payload.images } : {})
            })
            : yield* inbox.triage(report)
          results.push({ id: report.id, subject: report.subject, ...decision })
        }
        return { results }
      }),
      queue: ({ query }) =>
        store.queue(query.status ?? "new", query.limit ?? 10).pipe(Effect.map((reports) => ({ reports }))),
      attachment: ({ query }) => file(attachments, query.key),
      related: Effect.fn(function*({ query }) {
        const report = yield* store.byId(query.report)
        if (!report) return yield* Effect.fail(new Api.NotFound({ message: `No report ${query.report}` }))
        return { related: yield* store.related(report) }
      }),
      postEvents: Effect.fn(function*({ payload }) {
        for (const event of payload.events) yield* store.record(payload.report_id, event.kind, event.body)
        return { ok: true, count: payload.events.length }
      }),
      patchReport: Effect.fn(function*({ params, payload }) {
        const report = yield* store.patch(params.id, payload)
        // A patch that matches no row is a bug upstream, not a no-op: it is
        // how a verdict silently fails to persist.
        if (!report) return yield* Effect.fail(new Api.NotFound({ message: `No report ${params.id}` }))
        const messageId = yield* inbox.notify(report)
        return { ok: true, notified: messageId !== null || !NOTIFYING.includes(report.status) }
      })
    })
  })
)

/** Every group of the API, needing the inbox's services. */
export const ApiLive = HttpApiBuilder.layer(Api.Api).pipe(
  Layer.provide([SystemLive, PublicLive, InboxLive, FilesLive, TelegramLive, AgentLive]),
  Layer.provide([AgentAuthLive, OwnerAuthLive])
)
