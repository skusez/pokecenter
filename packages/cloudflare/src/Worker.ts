/**
 * The inbox worker: receives mail through Email Routing, triages it on Workers
 * AI, sends Telegram cards, and serves the API and the thread UI.
 *
 * Build it in your own module, which must be the worker's `main` and
 * default-export the class:
 *
 *     export default class Inbox extends Pokecenter.worker<Inbox>()({
 *       main: import.meta.url,
 *       profile,
 *       domain: "inbox.example.com",
 *       email: { address: "bugs@example.com", zone: "example.com" },
 *     }) {}
 */
import { RuntimeContext } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as SQL from "alchemy/SQL/D1"
import type { Profile } from "@skusez/pokecenter"
import { Config, Effect, Layer, Redacted, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { Attachments } from "./Attachments.ts"
import { AuthPolicy } from "./Auth.ts"
import { base64, Classifier, ModelError } from "./Classifier.ts"
import { ApiLive, Secrets, Settings } from "./Handlers.ts"
import { Backend, Inbox } from "./Inbox.ts"
import { UI_DIR } from "./Paths.ts"
import { resources } from "./Resources.ts"
import { Store } from "./Store.ts"
import { Telegram } from "./Telegram.ts"

export interface WorkerOptions {
  /** `import.meta.url` of the module that default-exports the worker. */
  readonly main: string
  readonly profile: Profile.Profile
  /** The custom domain the worker serves on. */
  readonly domain: string
  /** The address mail arrives at, and the Cloudflare zone it belongs to. */
  readonly email: { readonly address: string; readonly zone: string }
  /** Who may open the thread UI in a browser. Defaults to bearer only. */
  readonly auth?: Layer.Layer<AuthPolicy>
  /** See `ResourceOptions.secretPrefix`. Defaults to `<domain>_`. */
  readonly secretPrefix?: string
  /** The worker's logical id. Keep it stable: renaming it replaces the worker. */
  readonly id?: string
  readonly compatibility?: {
    readonly date?: string
    readonly flags?: ReadonlyArray<string>
  }
}

const UNSAFE_SECRET_CHARS = /[^A-Za-z0-9_]/g

export const worker = <Self>() => (options: WorkerOptions) => {
  const { Bucket, Database, AgentToken, WebhookSecret } = resources({
    secretPrefix: options.secretPrefix ?? `${options.domain.replace(UNSAFE_SECRET_CHARS, "_")}_`
  })
  const origin = `https://${options.domain}`

  return Cloudflare.Worker<Self>()(
    options.id ?? "InboxAgent",
    {
      main: options.main,
      domain: options.domain,
      // Assets are matched first, so index.html serves `/` and the UI routes
      // with `#/t/<id>`; every other path falls through to fetch.
      assets: { directory: UI_DIR },
      ...(options.compatibility ? { compatibility: options.compatibility as never } : {})
    },
    Effect.gen(function*() {
      const d1 = yield* Cloudflare.D1.QueryDatabase(Database)
      const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket)
      const botToken = yield* Config.Redacted("TELEGRAM_BOT_TOKEN")
      const chatId = yield* Config.String("TELEGRAM_CHAT_ID")
      const agentToken = yield* Cloudflare.SecretsStore.ReadSecret(AgentToken)
      const webhookSecret = yield* Cloudflare.SecretsStore.ReadSecret(WebhookSecret)
      const ai = yield* Cloudflare.Workers.AI()
      const images = yield* Cloudflare.Images.Images("IMAGES")

      // Binding calls carry a type-only RuntimeContext requirement; the
      // runtime supplies the real one per request.
      const bound = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
        effect.pipe(Effect.provide(RuntimeContext.phantom))

      const AttachmentsLive = Layer.succeed(
        Attachments,
        Attachments.of({
          get: (key) =>
            bound(bucket.get(key)).pipe(
              Effect.flatMap((object) =>
                object
                  ? bound(object.arrayBuffer()).pipe(
                    Effect.map((buffer) => ({
                      bytes: new Uint8Array(buffer),
                      contentType: object.httpMetadata?.contentType
                    }))
                  )
                  : Effect.succeed(null)
              ),
              Effect.orDie
            ),
          put: (key, bytes, contentType) =>
            bound(bucket.put(key, bytes, { httpMetadata: { contentType } })).pipe(Effect.asVoid, Effect.orDie)
        })
      )

      const models = {
        // The decision models are not in the binding's typed catalog.
        run: (model: string, input: unknown) =>
          bound(ai.raw).pipe(
            Effect.flatMap((raw) =>
              Effect.tryPromise({
                try: () => (raw.run as (model: string, input: unknown) => Promise<unknown>)(model, input),
                // The runtime's message is the useful part ("Insufficient
                // balance…"); a generic wrapper would replace it.
                catch: (cause) => new ModelError({ model, message: cause instanceof Error ? cause.message : String(cause) })
              })
            )
          )
      }

      /** A screenshot at most 1024 px on its long side, as WebP: large enough
       * to read, small enough that a few fit in Clef's request. */
      const shrinker = {
        shrink: (bytes: Uint8Array) =>
          bound(images.input(Stream.make(bytes)).pipe(
            Effect.flatMap((image) =>
              image.transform({ width: 1024, height: 1024, fit: "scale-down" }).output({ format: "image/webp", quality: 50 })
            ),
            Effect.flatMap((result) => result.response),
            Effect.flatMap((response) => Effect.promise(() => response.arrayBuffer())),
            Effect.map((buffer) => base64(new Uint8Array(buffer)))
          ))
      }

      // Unwrap before comparing: interpolating a Redacted gives "<redacted>".
      const SecretsLive = Layer.succeed(
        Secrets,
        Secrets.of({
          agentToken: bound(agentToken).pipe(Effect.map(Redacted.value), Effect.orDie),
          webhookSecret: bound(webhookSecret).pipe(Effect.map(Redacted.value), Effect.orDie)
        })
      )

      const services = Inbox.layer.pipe(
        Layer.provideMerge(Classifier.layer(options.profile, models, shrinker)),
        Layer.provideMerge(Store.layer),
        Layer.provideMerge(Telegram.layer({ token: botToken, chatId, origin })),
        Layer.provideMerge(AttachmentsLive),
        Layer.provideMerge(SQL.D1Layer(d1)),
        Layer.provideMerge(Layer.succeed(Backend, options.profile.backend)),
        Layer.provideMerge(SecretsLive),
        Layer.provideMerge(Layer.succeed(Settings, Settings.of({ profile: options.profile, origin }))),
        Layer.provideMerge(options.auth ?? AuthPolicy.bearerOnly)
      )

      yield* Cloudflare.email({
        zone: options.email.zone,
        matchers: [{ type: "literal", field: "to", value: options.email.address }],
        ruleName: `pokecenter ${options.email.address}`
      }).subscribe((message) =>
        Effect.gen(function*() {
          const raw = yield* Effect.promise(() =>
            new Response(message.body as unknown as ReadableStream<Uint8Array>).arrayBuffer()
          )
          const inbox = yield* Inbox
          yield* inbox.receive(raw, message.headers.get("message-id"))
        }).pipe(Effect.provide(services))
      )

      // Built once per isolate, not per request.
      const fetch = yield* HttpRouter.toHttpEffect(
        ApiLive.pipe(Layer.provide(services), Layer.provide(HttpServer.layerServices))
      )
      return { fetch }
    }).pipe(
      Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
      Effect.provide(Cloudflare.Workers.AIBinding),
      Effect.provide(Cloudflare.Images.ImagesBinding),
      Effect.provide(Cloudflare.R2.ReadWriteBucketBinding),
      Effect.provide(Cloudflare.EmailEventSourceLive),
      Effect.provide(Cloudflare.SecretsStore.ReadSecretBinding)
    )
  )
}

export { resources }
