/**
 * Runs triage on Workers AI: the decision models (Clef, Clef-flash, Jev) in
 * one call, or the open model one question at a time. Clef also sees the
 * email's screenshots, shrunk to fit its request.
 */
import { Domain, Profile, Triage } from "@skusez/pokecenter"
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect"
import { Attachments } from "./Attachments.ts"

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  model: Schema.String,
  message: Schema.String
}) {}

/** The Workers AI binding, as much of it as triage uses. */
export interface ModelRunner {
  readonly run: (model: string, input: unknown) => Effect.Effect<unknown, ModelError>
}

/** Shrinks an image to WebP at most 1024 px on its long side, as base64. */
export interface ImageShrinker {
  readonly shrink: (bytes: Uint8Array) => Effect.Effect<string, unknown>
}

export interface JudgeOptions {
  /** False lets the open model stop after the verdict, which is all replay reads. */
  readonly full?: boolean
  readonly backend?: Profile.Backend
  readonly images?: boolean
}

export class Classifier extends Context.Service<Classifier, {
  /** The verdict, without writing it. Never fails: a model error becomes a
   * decision that sends the mail to the owner. */
  readonly judge: (report: Domain.Report, options?: JudgeOptions) => Effect.Effect<Domain.Decision>
}>()("pokecenter/Classifier") {
  static readonly make = (profile: Profile.Profile, models: ModelRunner, images: ImageShrinker) =>
    Effect.gen(function*() {
      const attachments = yield* Attachments

      const askOpen = (report: Domain.Report, full: boolean) =>
        Effect.gen(function*() {
          const { questions, state } = Triage.request(profile, report)
          const ask = <Q extends Triage.Question>(q: Q) =>
            models.run(Triage.OPEN_MODEL, Triage.openInput(state, q)).pipe(
              Effect.flatMap((output) =>
                Effect.try({
                  try: () => Triage.openAnswer(q, output as Triage.OpenOutput),
                  catch: (e) => new ModelError({ model: Triage.OPEN_MODEL, message: String(e) })
                })
              )
            )
          const verdict = (yield* ask(questions.verdict)) as Triage.ChoiceAnswer<Domain.Verdict>
          // Mail it is sure is noise needs nothing else, and most mail is noise.
          const settled = !full ||
            (verdict.choice === "ignore" && verdict.confidence >= profile.ignoreConfidence.open)
          const [category, severity, directs] = settled
            ? [
              { type: "choice", choice: Profile.UNKNOWN, confidence: 0, probabilities: {} },
              { type: "choice", choice: "low", confidence: 0, probabilities: {} },
              { type: "noul", noul: 0 }
            ] as const
            : yield* Effect.all(
              [ask(questions.category), ask(questions.severity), ask(questions.directs_reader)],
              { concurrency: 3 }
            )
          return {
            model: Triage.OPEN_MODEL,
            answers: {
              verdict,
              category: category as Triage.ChoiceAnswer<string>,
              severity: severity as Triage.ChoiceAnswer<Domain.Severity>,
              directs_reader: directs as Triage.NoulAnswer
            }
          } satisfies Triage.Answers
        })

      /** The report's screenshots, shrunk, in the email's order until the
       * budget is spent. Triage goes ahead on the text alone if they cannot
       * be loaded. */
      const screenshotsOf = (report: Domain.Report) =>
        Effect.gen(function*() {
          const stored = (JSON.parse(report.attachments ?? "[]") as Array<Domain.StoredAttachment>)
            .map((a) => (a.mimeType === "image/jpg" ? { ...a, mimeType: "image/jpeg" } : a))
            .filter((a) => Triage.IMAGE_TYPES.has(a.mimeType))
          const loaded: Array<Domain.StoredAttachment & { bytes: Uint8Array }> = []
          for (const attachment of stored) {
            const bytes = yield* attachments.get(attachment.key)
            if (bytes) loaded.push({ ...attachment, bytes: bytes.bytes })
          }
          const shown: Array<{ content_type: string; base64: string }> = []
          let budget = Triage.IMAGE_BASE64_BUDGET
          for (const image of Triage.pickImages(loaded)) {
            const small = yield* images.shrink(image.bytes)
            if (small.length > budget) continue
            budget -= small.length
            shown.push({ content_type: "image/webp", base64: small })
          }
          return shown
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("screenshots skipped", cause).pipe(Effect.as([])))
        )

      /** A decision model: all four questions in one call. Clef also wants its
       * own name in the body, to pick between clef and clef-flash. */
      const askDecisionModel = (report: Domain.Report, backend: Exclude<Profile.Backend, "open">, withImages: boolean) =>
        Effect.gen(function*() {
          const shown = backend !== "jev" && withImages ? yield* screenshotsOf(report) : []
          const response = yield* models.run(Triage.MODELS[backend], {
            ...Triage.request(profile, report),
            ...(backend === "jev" ? {} : { model: backend }),
            ...(shown.length > 0 ? { images: shown } : {})
          })
          return response as Triage.Answers
        })

      return Classifier.of({
        judge: (report, { backend = profile.backend, full = true, images: withImages = true } = {}) =>
          (backend === "open" ? askOpen(report, full) : askDecisionModel(report, backend, withImages)).pipe(
            Effect.timeout("60 seconds"),
            Effect.map((response) => Triage.decide(profile, response, backend)),
            Effect.catchCause((cause) =>
              Effect.logError("triage failed", cause).pipe(Effect.as(Triage.failed(String(Cause.squash(cause)))))
            )
          )
      })
    })

  static readonly layer = (profile: Profile.Profile, models: ModelRunner, images: ImageShrinker) =>
    Layer.effect(Classifier, Classifier.make(profile, models, images))
}

/** Base64 by hand, without relying on Node's Buffer. */
export const base64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** One-element stream of bytes, the shape the Images binding reads. */
export const streamOf = (bytes: Uint8Array) => Stream.make(bytes)
