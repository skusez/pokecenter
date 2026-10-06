import { Schema } from "effect"

/**
 * Where a report is. `needs_owner` is mail triage hands to a person rather
 * than to the investigator; `ignored` never sends a card.
 */
export const Status = Schema.Literals([
  "new",
  "queued",
  "investigating",
  "done",
  "error",
  "needs_owner",
  "ignored"
])
export type Status = typeof Status.Type

/** What triage says should happen to an email. */
export const Verdict = Schema.Literals(["queue", "needs_owner", "ignore"])
export type Verdict = typeof Verdict.Type

/** The verdict stored on a report triage could not reach. Retried later. */
export const TRIAGE_FAILED = "triage_failed"

export const Severity = Schema.Literals(["low", "medium", "high"])
export type Severity = typeof Severity.Type

export const Outcome = Schema.Literals(["pr_opened", "answered", "diagnosed_only", "already_fixed", "not_reproducible"])
export type Outcome = typeof Outcome.Type

/** A file kept in the attachments bucket, as stored on a report or event. */
export const StoredAttachment = Schema.Struct({
  key: Schema.String,
  filename: Schema.String,
  mimeType: Schema.String
})
export type StoredAttachment = typeof StoredAttachment.Type

export const StoredAttachments = Schema.fromJsonString(Schema.Array(StoredAttachment))

/** A report row as stored. JSON columns stay JSON text on the wire. */
export const Report = Schema.Struct({
  id: Schema.String,
  short_id: Schema.String,
  received_at: Schema.String,
  from_addr: Schema.String,
  reply_to: Schema.NullOr(Schema.String),
  subject: Schema.String,
  body: Schema.String,
  forwarded: Schema.Number,
  status: Schema.String,
  verdict: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  severity: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  pr_url: Schema.NullOr(Schema.String),
  findings: Schema.NullOr(Schema.String),
  /** JSON array of `StoredAttachment`. */
  attachments: Schema.NullOr(Schema.String),
  suspicious: Schema.Number,
  tg_message: Schema.NullOr(Schema.Number),
  updated_at: Schema.String,
  /** JSON `Digest`, written once triage lets the mail through. */
  digest: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.String),
  origin_id: Schema.NullOr(Schema.String)
})
export type Report = typeof Report.Type

/** A report with its notes and follow-up mails, as the investigator reads it. */
export const QueuedReport = Schema.Struct({
  ...Report.fields,
  /** JSON array of `Note`, oldest first. */
  notes: Schema.NullOr(Schema.String),
  /** JSON array of `FollowUp`, oldest first. */
  followups: Schema.NullOr(Schema.String)
})
export type QueuedReport = typeof QueuedReport.Type

/** One row of the inbox list. */
export const Thread = Schema.Struct({
  id: Schema.String,
  short_id: Schema.String,
  received_at: Schema.String,
  from_addr: Schema.String,
  subject: Schema.String,
  status: Schema.String,
  verdict: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  severity: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.String),
  pr_url: Schema.NullOr(Schema.String),
  suspicious: Schema.Number,
  updated_at: Schema.String,
  attachments: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.String),
  last_kind: Schema.NullOr(Schema.String),
  last_at: Schema.NullOr(Schema.String)
})
export type Thread = typeof Thread.Type

/**
 * Everything that happens to a report, oldest first. `kind` is one of
 * received, status, email, note, step; `body` is that kind's JSON.
 */
export const Event = Schema.Struct({
  id: Schema.Number,
  report_id: Schema.String,
  kind: Schema.String,
  body: Schema.String,
  created_at: Schema.String
})
export type Event = typeof Event.Type

/** What the owner said about a report, from Telegram or the web thread. */
export const Note = Schema.Struct({
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(StoredAttachment)),
  via: Schema.optional(Schema.String)
})
export type Note = typeof Note.Type

/** A later email matched to a report: a reply, a nudge, more detail. */
export const FollowUp = Schema.Struct({
  from: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  received_at: Schema.String,
  attachments: Schema.optional(Schema.Array(StoredAttachment))
})
export type FollowUp = typeof FollowUp.Type

/** An earlier report worth knowing about: same sender, same words, a recent fix. */
export const Related = Schema.Struct({
  short_id: Schema.String,
  subject: Schema.String,
  from_addr: Schema.String,
  received_at: Schema.String,
  status: Schema.String,
  outcome: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  findings: Schema.NullOr(Schema.String),
  pr_url: Schema.NullOr(Schema.String)
})
export type Related = typeof Related.Type

/** The email restated under fixed headings, so every thread reads the same. */
export const Digest = Schema.Struct({
  reporter: Schema.String,
  summary: Schema.String,
  request: Schema.String,
  expected: Schema.NullOr(Schema.String),
  details: Schema.Array(Schema.String),
  asks: Schema.Array(Schema.String)
})
export type Digest = typeof Digest.Type

/** Scores kept on a status event, so a threshold can be tuned from real mail. */
export const Scores = Schema.Struct({
  model: Schema.String,
  verdict: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
  directs_reader: Schema.Number
})
export type Scores = typeof Scores.Type

/** Triage's answer for one email, before or instead of writing it. */
export const Decision = Schema.Struct({
  status: Schema.Literals(["queued", "ignored", "needs_owner"]),
  verdict: Schema.Union([Verdict, Schema.Literal(TRIAGE_FAILED)]),
  reason: Schema.String,
  category: Schema.String,
  severity: Severity,
  suspicious: Schema.Boolean,
  /** Null when the model could not be reached. */
  scores: Schema.NullOr(Scores)
})
export type Decision = typeof Decision.Type

/** What an investigation reports back. */
export const Investigation = Schema.Struct({
  outcome: Outcome,
  headline: Schema.String,
  findings: Schema.String,
  files: Schema.Array(Schema.String),
  branch: Schema.NullOr(Schema.String),
  pr_url: Schema.NullOr(Schema.String),
  refused_instructions: Schema.NullOr(Schema.String),
  /** Decisions only the owner can make, raised after the work rather than instead of it. */
  questions: Schema.optional(Schema.NullOr(Schema.String))
})
export type Investigation = typeof Investigation.Type
