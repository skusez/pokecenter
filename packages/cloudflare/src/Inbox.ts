/**
 * What happens to mail: ingest, triage, and the owner's answers from
 * Telegram. Composes the store, the classifier, attachments and Telegram.
 */
import { Domain, Mail } from "@skusez/pokecenter"
import { Context, Effect, Layer } from "effect"
import { Attachments, prefixOf } from "./Attachments.ts"
import { Classifier, type JudgeOptions } from "./Classifier.ts"
import { isPending, Store } from "./Store.ts"
import { escape, shortIdOfCard, Telegram } from "./Telegram.ts"

interface TelegramUpdate {
  readonly callback_query?: { id: string; data: string }
  readonly message?: {
    message_id: number
    chat: { id: number }
    text?: string
    reply_to_message?: {
      message_id: number
      reply_markup?: { inline_keyboard?: ReadonlyArray<ReadonlyArray<{ url?: string; callback_data?: string }>> }
    }
  }
}

export class Inbox extends Context.Service<Inbox>()("pokecenter/Inbox", {
  make: Effect.gen(function*() {
    const store = yield* Store
    const classifier = yield* Classifier
    const attachments = yield* Attachments
    const telegram = yield* Telegram
    const backend = yield* Backend

    /** Sends the card for a report's state and remembers the first one. */
    const notify = (report: Domain.Report, as?: "followup") =>
      Effect.gen(function*() {
        const messageId = yield* telegram.notify(report, as)
        yield* store.rememberCard(report, messageId)
        return messageId
      })

    /** Classify one pending report, write the verdict, and send its only
     * card, or none when it is noise. */
    const triage = (report: Domain.Report) =>
      Effect.gen(function*() {
        const retry = report.status !== "new"
        const decision = yield* classifier.judge(report)
        // Failing again changes nothing: the card from the first failure
        // stands, and the retry job stays silent.
        if (retry && !decision.scores) return decision
        const row = yield* store.writeDecision(report, decision, backend)
        if (!row) return decision
        // A retry that lands on needs_owner already has its card from the failure.
        if (retry && row.status === "needs_owner") return decision
        yield* notify(row)
        return decision
      })

    const judge = (report: Domain.Report, options?: JudgeOptions) => classifier.judge(report, options)

    const storeAll = (prefix: string, files: ReadonlyArray<Mail.Attachment>) =>
      Effect.forEach(files, (file, index) =>
        Effect.gen(function*() {
          const key = `${prefix}${index}-${file.filename}`
          yield* attachments.put(key, file.content, file.mimeType)
          return { key, filename: file.filename, mimeType: file.mimeType }
        }))

    /**
     * One inbound email. A reply lands on the thread it answers; anything
     * else becomes a report, filed straight away when its headers say it is
     * bulk mail, triaged otherwise. The raw email is kept beside it, so a
     * later change to what counts as a signature can reach mail already in.
     */
    const receive = (raw: ArrayBuffer, messageId: string | null) =>
      Effect.gen(function*() {
        const mail = yield* Effect.promise(() => Mail.parse(raw))
        const id = messageId ?? crypto.randomUUID()
        const parent = yield* store.parentOf(mail)

        if (parent && !(yield* store.exists(id))) {
          const stamp = Date.now()
          const prefix = `${prefixOf(parent.id)}re-${stamp}-`
          yield* attachments.put(`${prefix}raw.eml`, raw, "message/rfc822")
          const stored = yield* storeAll(prefix, mail.attachments)
          yield* store.appendFollowUp(parent, {
            id,
            from: mail.from,
            subject: mail.subject,
            body: mail.body.slice(0, 60_000),
            received_at: new Date().toISOString(),
            attachments: stored
          })
          yield* notify(parent, "followup")
          return
        }

        yield* attachments.put(`${prefixOf(id)}raw.eml`, raw, "message/rfc822")
        const stored = yield* storeAll(prefixOf(id), mail.attachments)
        yield* store.insert({
          id,
          shortId: crypto.randomUUID().replace(/-/g, "").slice(0, 8),
          from: mail.from,
          replyTo: mail.replyTo,
          subject: mail.subject,
          body: mail.body,
          forwarded: mail.forwarded,
          attachments: stored,
          status: mail.bulk ? "ignored" : "new",
          originId: mail.originId
        })
        // Bulk mail is filed on arrival: no card, no model call.
        if (mail.bulk) return yield* store.fileAsBulk(id, mail.bulk)
        const report = yield* store.byId(id)
        if (report?.status === "new") {
          yield* store.record(id, "received", {})
          yield* triage(report)
        }
      })

    /** A reply to a card is a note for that report; a button is a decision. */
    const telegramUpdate = (update: TelegramUpdate) =>
      Effect.gen(function*() {
        const message = update.message
        // Only the configured chat may instruct the agent.
        if (message?.text && String(message.chat.id) === telegram.chatId) {
          const replyTo = message.reply_to_message
          const shortId = replyTo ? shortIdOfCard(replyTo.reply_markup) : null
          const report = shortId
            ? yield* store.byShortId(shortId)
            : replyTo
            ? yield* store.byCard(replyTo.message_id)
            : null
          if (!report) {
            return yield* telegram.reply(
              message.message_id,
              "Reply to a report card to give the agent instructions for that report."
            )
          }
          const result = yield* store.addNote(report, message.text, [], "telegram")
          return yield* telegram.reply(
            message.message_id,
            result.ok ? `📝 Queued <b>${escape(report.subject)}</b> with your note.` : result.reason
          )
        }
        const callback = update.callback_query
        if (!callback) return
        const [action, shortId] = [callback.data.slice(0, 1), callback.data.slice(2)]
        const report = yield* store.byShortId(shortId)
        if (report) yield* store.setStatus(report, action === "q" ? "queued" : "ignored", "telegram")
        yield* telegram.answer(callback.id, action === "q" ? "Queued for investigation" : "Ignored")
      })

    return { triage, judge, receive, notify, telegramUpdate, isPending } as const
  })
}) {
  static readonly layer = Layer.effect(Inbox, Inbox.make)
}

/** The deployed triage backend's name, recorded on each verdict. */
export class Backend extends Context.Service<Backend, string>()("pokecenter/Backend") {}
