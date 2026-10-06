import { AgentAuth, Api, type BadRequest, type NotFound, type Unauthorized } from "@skusez/pokecenter/Api"
import { FollowUp, Note, type QueuedReport, StoredAttachment } from "@skusez/pokecenter/Domain"
import { Context, Effect, flow, Layer, Redacted, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, type HttpClientError, HttpClientRequest } from "effect/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api"
import { AgentConfig } from "./AgentConfig.ts"

/** Anything a call to the worker can fail with. */
export type ApiError = HttpClientError.HttpClientError | Schema.SchemaError | Unauthorized | NotFound | BadRequest

/** The worker's API, typed end to end from the shared definition. */
export class Client extends Context.Service<Client, HttpApiClient.ForApi<typeof Api>>()(
  "@skusez/pokecenter-agent/Client"
) {
  static readonly layerNoDeps = Layer.effect(
    Client,
    Effect.gen(function*() {
      const { url } = yield* AgentConfig
      return yield* HttpApiClient.make(Api, {
        transformClient: (client) =>
          client.pipe(
            HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(url))),
            HttpClient.retryTransient({ schedule: Schedule.exponential(250), times: 3 })
          )
      })
    })
  ).pipe(
    Layer.provide(
      HttpApiMiddleware.layerClient(
        AgentAuth,
        Effect.fn(function*({ next, request }) {
          const { token } = yield* AgentConfig
          return yield* next(HttpClientRequest.bearerToken(request, Redacted.value(token)))
        })
      )
    )
  )

  static readonly layer = this.layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer))
}

/** A JSON column read leniently: a malformed value reads as empty rather than failing the run. */
const jsonArray = <A>(decode: (value: string) => ReadonlyArray<A>) => (value: string | null): ReadonlyArray<A> => {
  if (!value) return []
  try {
    return decode(value)
  } catch {
    return []
  }
}

const notes = jsonArray(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Note))))
const followUps = jsonArray(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(FollowUp))))
const attachments = jsonArray(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(StoredAttachment))))

/** What the owner has said about a report, oldest first. */
export const notesOf = (report: QueuedReport): ReadonlyArray<Note> => notes(report.notes)

/** Later emails on the report's thread, oldest first. */
export const followUpsOf = (report: QueuedReport): ReadonlyArray<FollowUp> => followUps(report.followups)

/** The email's own attachments. */
export const attachmentsOf = (report: { readonly attachments: string | null }): ReadonlyArray<StoredAttachment> =>
  attachments(report.attachments)

/** Every file a report carries: the email's, the owner's notes', and later mails'. */
export const allAttachmentsOf = (report: QueuedReport): ReadonlyArray<StoredAttachment> => [
  ...attachmentsOf(report),
  ...notesOf(report).flatMap((note) => note.attachments ?? []),
  ...followUpsOf(report).flatMap((mail) => mail.attachments ?? [])
]
