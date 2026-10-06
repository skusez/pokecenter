/**
 * Reports and their events in SQL. The report row is the current state; the
 * event table is everything that happened to it, which both the Telegram cards
 * and the web thread are views over.
 *
 * Database failures are defects here: there is nothing a caller could do
 * about one but report it, which the HTTP layer does as a 500.
 */
import type { Api } from "@skusez/pokecenter"
import { Domain, Mail } from "@skusez/pokecenter"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

type Report = Domain.Report
type Decision = Domain.Decision

const now = () => new Date().toISOString()

/** Mail still waiting on a verdict: never triaged, or the model could not be reached. */
export const isPending = (report: Pick<Report, "status" | "verdict">): boolean =>
  report.status === "new" || (report.status === "needs_owner" && report.verdict === Domain.TRIAGE_FAILED)

export interface NewReport {
  readonly id: string
  readonly shortId: string
  readonly from: string
  readonly replyTo: string | null
  readonly subject: string
  readonly body: string
  readonly forwarded: boolean
  readonly attachments: ReadonlyArray<Domain.StoredAttachment>
  readonly status: "new" | "ignored"
  readonly originId: string | null
}

export class Store extends Context.Service<Store>()("pokecenter/Store", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const die = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.orDie(effect)

    const one = (rows: ReadonlyArray<Report>) => rows[0] ?? null

    const record = (reportId: string, kind: string, body: unknown) =>
      die(sql`INSERT INTO event (report_id, kind, body, created_at)
              VALUES (${reportId}, ${kind}, ${JSON.stringify(body)}, ${now()})`)

    const byId = (id: string) => die(sql<Report>`SELECT * FROM report WHERE id = ${id}`).pipe(Effect.map(one))

    const byShortId = (shortId: string) =>
      die(sql<Report>`SELECT * FROM report WHERE short_id = ${shortId}`).pipe(Effect.map(one))

    const byIds = (ids: ReadonlyArray<string>) =>
      die(sql<Report>`SELECT * FROM report WHERE id IN ${sql.in(ids.slice(0, 50))}`)

    const pending = die(sql<Report>`
      SELECT * FROM report
      WHERE status = 'new' OR (status = 'needs_owner' AND verdict = ${Domain.TRIAGE_FAILED})
      ORDER BY received_at ASC LIMIT 50
    `)

    const insert = (report: NewReport) =>
      die(sql`
        INSERT OR IGNORE INTO report
          (id, short_id, received_at, from_addr, reply_to, subject, body, forwarded, attachments, status, updated_at, origin_id)
        VALUES
          (${report.id}, ${report.shortId}, ${now()}, ${report.from}, ${report.replyTo},
           ${report.subject}, ${report.body.slice(0, 60_000)}, ${report.forwarded ? 1 : 0},
           ${JSON.stringify(report.attachments)}, ${report.status}, ${now()}, ${report.originId})
      `)

    /**
     * The thread a new email continues, if any. Headers first; failing that,
     * the same sender on the same subject within two months. Never an ignored
     * thread: new mail there is triaged afresh, so a notice that repeats its
     * subject daily stays in the bin instead of carding as a follow-up.
     */
    const parentOf = (mail: { refs: ReadonlyArray<string>; from: string; subject: string }) =>
      Effect.gen(function*() {
        if (mail.refs.length > 0) {
          const [byHeader] = yield* die(sql<Report>`
            SELECT * FROM report
            WHERE (id IN ${sql.in(mail.refs)} OR origin_id IN ${sql.in(mail.refs)}) AND status != 'ignored'
            LIMIT 1
          `)
          if (byHeader) return byHeader
        }
        const since = new Date(Date.now() - 60 * 86_400_000).toISOString()
        const candidates = yield* die(sql<Report>`
          SELECT * FROM report
          WHERE from_addr = ${mail.from} AND received_at > ${since} AND status != 'ignored'
          ORDER BY received_at DESC LIMIT 20
        `)
        const subject = Mail.normalisedSubject(mail.subject)
        return candidates.find((r) => Mail.normalisedSubject(r.subject) === subject) ?? null
      })

    /** A later email lands on its thread, and brings it back from the archive. */
    const appendFollowUp = (parent: Report, mail: unknown) =>
      Effect.gen(function*() {
        yield* record(parent.id, "email", mail)
        if (parent.archived_at) yield* record(parent.id, "status", { status: "unarchived", by: "followup" })
        yield* die(sql`UPDATE report SET updated_at = ${now()}, archived_at = NULL WHERE id = ${parent.id}`)
      })

    const exists = (id: string) =>
      die(sql<{ n: number }>`SELECT count(*) AS n FROM report WHERE id = ${id}`).pipe(
        Effect.map((rows) => (rows[0]?.n ?? 0) > 0)
      )

    /**
     * Writes a verdict, only onto a report still waiting for one: a retry
     * must not overwrite a status someone has set since.
     */
    const writeDecision = (report: Report, decision: Decision, by: string) =>
      Effect.gen(function*() {
        yield* die(sql`
          UPDATE report SET
            status = ${decision.status}, verdict = ${decision.verdict}, reason = ${decision.reason},
            category = ${decision.category}, severity = ${decision.severity},
            suspicious = ${decision.suspicious ? 1 : 0}, updated_at = ${now()}
          WHERE id = ${report.id}
            AND (status = 'new' OR (status = 'needs_owner' AND verdict = ${Domain.TRIAGE_FAILED}))
        `)
        yield* record(report.id, "status", { ...decision, suspicious: undefined, by })
        return yield* byId(report.id)
      })

    const fileAsBulk = (id: string, reason: string) =>
      Effect.gen(function*() {
        yield* die(sql`UPDATE report SET verdict = 'ignore', reason = ${reason} WHERE id = ${id} AND status = 'ignored'`)
        yield* record(id, "status", { status: "ignored", reason, by: "headers" })
      })

    const setStatus = (report: Report, status: "queued" | "ignored", by: string) =>
      Effect.gen(function*() {
        yield* die(sql`UPDATE report SET status = ${status}, updated_at = ${now()} WHERE id = ${report.id}`)
        yield* record(report.id, "status", { status, by })
      })

    const setArchived = (report: Report, archived: boolean, by: string) =>
      Effect.gen(function*() {
        yield* die(sql`UPDATE report SET archived_at = ${archived ? now() : null} WHERE id = ${report.id}`)
        yield* record(report.id, "status", { status: archived ? "archived" : "unarchived", by })
      })

    /** One request for a whole selection, recorded as the same events a
     * single-thread action writes so every timeline reads the same. */
    const bulk = (shortIds: ReadonlyArray<string>, action: Api.BulkAction) =>
      Effect.gen(function*() {
        const found = yield* die(sql<Report>`SELECT * FROM report WHERE short_id IN ${sql.in(shortIds)}`)
        // An investigation writes the status when it finishes, so moving one
        // out from under a running agent would lose the edit. Archiving is
        // orthogonal to status and stays allowed.
        const targets = action === "ignore" || action === "queue"
          ? found.filter((r) => r.status !== "investigating")
          : found
        const skipped = shortIds.length - targets.length
        if (targets.length === 0) return { changed: 0, skipped }
        const at = now()
        const ids = targets.map((r) => r.id)
        const status = action === "archive" ? "archived" : action === "unarchive" ? "unarchived" : action === "queue" ? "queued" : "ignored"
        if (action === "archive" || action === "unarchive") {
          yield* die(sql`UPDATE report SET archived_at = ${action === "archive" ? at : null} WHERE id IN ${sql.in(ids)}`)
        } else {
          yield* die(sql`UPDATE report SET status = ${status}, updated_at = ${at} WHERE id IN ${sql.in(ids)}`)
        }
        yield* die(sql`INSERT INTO event ${
          sql.insert(ids.map((reportId) => ({
            report_id: reportId,
            kind: "status",
            body: JSON.stringify({ status, by: "web" }),
            created_at: at
          })))
        }`)
        return { changed: targets.length, skipped }
      })

    /** inbox: live reports. ignored: what triage or the headers binned.
     * archived: what the owner put away. */
    const threads = (view: Api.View) =>
      die(sql<Domain.Thread>`
        SELECT report.id, short_id, received_at, from_addr, subject, status, verdict, reason, category,
               severity, outcome, pr_url, suspicious, updated_at, attachments, archived_at,
               (SELECT kind FROM event WHERE event.report_id = report.id ORDER BY id DESC LIMIT 1) AS last_kind,
               (SELECT created_at FROM event WHERE event.report_id = report.id ORDER BY id DESC LIMIT 1) AS last_at
        FROM report
        WHERE CASE ${view}
          WHEN 'archived' THEN archived_at IS NOT NULL
          WHEN 'ignored' THEN archived_at IS NULL AND status = 'ignored'
          ELSE archived_at IS NULL AND status != 'ignored'
        END
        ORDER BY updated_at DESC LIMIT 200
      `)

    const events = (reportId: string, after = 0) =>
      die(sql<Domain.Event>`SELECT * FROM event WHERE report_id = ${reportId} AND id > ${after} ORDER BY id`)

    const queue = (status: string, limit: number) =>
      die(sql<Domain.QueuedReport>`
        SELECT report.*,
          (SELECT json_group_array(json(body)) FROM (SELECT body FROM event WHERE event.report_id = report.id AND kind = 'note' ORDER BY id)) AS notes,
          (SELECT json_group_array(json(body)) FROM (SELECT body FROM event WHERE event.report_id = report.id AND kind = 'email' ORDER BY id)) AS followups
        FROM report WHERE status = ${status} ORDER BY received_at ASC LIMIT ${limit}
      `)

    /** Earlier reports that may be the same thing. Recent first, ignored mail excluded. */
    const related = (report: Report) =>
      Effect.gen(function*() {
        const since = new Date(Date.now() - 120 * 86_400_000).toISOString()
        const rows = yield* die(sql<Domain.Related & { from_addr: string; outcome: string | null }>`
          SELECT id, short_id, subject, from_addr, received_at, status, outcome, reason, findings, pr_url
          FROM report
          WHERE id != ${report.id} AND status != 'ignored' AND received_at > ${since}
          ORDER BY received_at DESC LIMIT 400
        `)
        return rows
          .map((r) => ({ r, n: Mail.relatedness(report, r) }))
          .filter(({ n }) => n >= 2)
          .sort((a, b) => b.n - a.n)
          .slice(0, 8)
          .map(({ r }): Domain.Related => ({
            short_id: r.short_id,
            subject: r.subject,
            from_addr: r.from_addr,
            received_at: r.received_at,
            status: r.status,
            outcome: r.outcome,
            reason: r.reason,
            findings: r.findings,
            pr_url: r.pr_url
          }))
      })

    /** The agent's write. A status change is a step in the thread; the fields
     * alongside it are what the step has to say. */
    const patch = (id: string, fields: Api.ReportPatch) =>
      Effect.gen(function*() {
        yield* die(sql`
          UPDATE report SET
            status     = COALESCE(${fields.status ?? null}, status),
            verdict    = COALESCE(${fields.verdict ?? null}, verdict),
            reason     = COALESCE(${fields.reason ?? null}, reason),
            category   = COALESCE(${fields.category ?? null}, category),
            severity   = COALESCE(${fields.severity ?? null}, severity),
            outcome    = COALESCE(${fields.outcome ?? null}, outcome),
            branch     = COALESCE(${fields.branch ?? null}, branch),
            pr_url     = COALESCE(${fields.pr_url ?? null}, pr_url),
            findings   = COALESCE(${fields.findings ?? null}, findings),
            suspicious = COALESCE(${fields.suspicious ?? null}, suspicious),
            digest     = COALESCE(${fields.digest ?? null}, digest),
            updated_at = ${now()}
          WHERE id = ${id}
        `)
        const report = yield* byId(id)
        if (report && fields.status) yield* record(id, "status", { ...fields, digest: undefined, by: "agent" })
        return report
      })

    /** A note is an instruction to an agent that can push code. Telegram and
     * the web thread both land here, so the rules match. */
    const addNote = (
      report: Report,
      text: string,
      attachments: ReadonlyArray<Domain.StoredAttachment>,
      via: "telegram" | "web"
    ) =>
      Effect.gen(function*() {
        if (report.status === "investigating") {
          // Queuing now would be overwritten when the running investigation
          // reports back, and the note would never be read.
          return { ok: false as const, reason: "That one is being investigated right now. Reply to its result once it reports back." }
        }
        yield* record(report.id, "note", { text: text.slice(0, 4_000), attachments, via })
        yield* die(sql`UPDATE report SET status = 'queued', updated_at = ${now()} WHERE id = ${report.id}`)
        yield* record(report.id, "status", { status: "queued", by: via })
        return { ok: true as const }
      })

    /** The first card is the thread root; later ones reply to it and must not
     * replace it, or the Telegram thread would fork at every step. */
    const rememberCard = (report: Report, messageId: number | null) =>
      messageId && !report.tg_message
        ? die(sql`UPDATE report SET tg_message = ${messageId} WHERE id = ${report.id}`)
        : Effect.void

    const byCard = (messageId: number) =>
      die(sql<Report>`SELECT * FROM report WHERE tg_message = ${messageId}`).pipe(Effect.map(one))

    return {
      record,
      byId,
      byShortId,
      byIds,
      byCard,
      pending,
      insert,
      exists,
      parentOf,
      appendFollowUp,
      writeDecision,
      fileAsBulk,
      setStatus,
      setArchived,
      bulk,
      threads,
      events,
      queue,
      related,
      patch,
      addNote,
      rememberCard
    } as const
  })
}) {
  static readonly layer = Layer.effect(Store, Store.make)
}
