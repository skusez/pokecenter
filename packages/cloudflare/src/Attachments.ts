/**
 * Files kept beside a report: the raw email, its attachments, and files the
 * owner attaches to notes. Every key starts with the report's id, which is
 * what scopes a link to its own report.
 */
import { Context, Effect, Layer } from "effect"

export interface StoredFile {
  readonly bytes: Uint8Array
  readonly contentType: string | undefined
}

export class Attachments extends Context.Service<Attachments, {
  readonly get: (key: string) => Effect.Effect<StoredFile | null>
  readonly put: (key: string, bytes: Uint8Array | ArrayBuffer, contentType: string) => Effect.Effect<void>
}>()("pokecenter/Attachments") {
  /** In memory, for tests and local runs. */
  static readonly layerMemory = Layer.sync(Attachments, () => {
    const files = new Map<string, StoredFile>()
    return Attachments.of({
      get: (key) => Effect.sync(() => files.get(key) ?? null),
      put: (key, bytes, contentType) =>
        Effect.sync(() => {
          files.set(key, { bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), contentType })
        })
    })
  })
}

/** The prefix every file of a report is stored under. */
export const prefixOf = (reportId: string) => `${encodeURIComponent(reportId)}/`
