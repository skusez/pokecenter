import { Schema } from "effect"

/** The environment or the profile is missing something the agent needs. */
export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()("ConfigInvalid", {
  message: Schema.String
}) {}

/** A report's category names a repo that `REPOS` has no checkout for. */
export class MissingRepo extends Schema.TaggedError<MissingRepo>()("MissingRepo", {
  category: Schema.String,
  repo: Schema.NullOr(Schema.String),
  message: Schema.String
}) {}

export class GitFailed extends Schema.TaggedError<GitFailed>()("GitFailed", {
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  message: Schema.String
}) {}

/** opencode went quiet for longer than any real step takes. */
export class OpencodeStalled extends Schema.TaggedError<OpencodeStalled>()("OpencodeStalled", {
  minutes: Schema.Number,
  message: Schema.String
}) {}

/** opencode ran past the run's overall time limit. */
export class OpencodeTimedOut extends Schema.TaggedError<OpencodeTimedOut>()("OpencodeTimedOut", {
  minutes: Schema.Number,
  message: Schema.String
}) {}

/** opencode could not be started, or exited non-zero. */
export class OpencodeFailed extends Schema.TaggedError<OpencodeFailed>()("OpencodeFailed", {
  exitCode: Schema.NullOr(Schema.Number),
  message: Schema.String
}) {}

/** opencode finished but its answer held no usable JSON object. */
export class OpencodeNoJson extends Schema.TaggedError<OpencodeNoJson>()("OpencodeNoJson", {
  message: Schema.String
}) {}

export type OpencodeError = OpencodeStalled | OpencodeTimedOut | OpencodeFailed | OpencodeNoJson

/** Any failure, reduced to one line a log or a report's findings can hold. */
export const describe = (error: unknown): string => {
  if (error && typeof error === "object") {
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : undefined
    const message = "message" in error && typeof error.message === "string" ? error.message : undefined
    if (tag && message) return `${tag}: ${message}`
    if (message) return message
    if (tag) return tag
  }
  return String(error)
}
