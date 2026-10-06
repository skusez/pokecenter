/**
 * Telegram: the Bot API client, and the cards a report sends as it moves.
 * Every message after the first replies to the arrival card, so a report's
 * whole life reads as one Telegram thread.
 */
import type { Domain } from "@skusez/pokecenter"
import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect"

export class TelegramError extends Schema.TaggedError<TelegramError>()("TelegramError", {
  method: Schema.String,
  message: Schema.String,
  /** Seconds Telegram asked us to wait, on a 429. */
  retryAfter: Schema.optional(Schema.Number)
}) {}

export type Button = { text: string; callback_data: string } | { text: string; url: string }

export interface TelegramConfig {
  readonly token: Redacted.Redacted<string>
  readonly chatId: string
  /** Where "Open thread" links point: the worker's public origin. */
  readonly origin: string
}

export const escape = (s: string): string =>
  s.replace(/[<&>]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!)

const OUTCOME_ICON: Record<string, string> = {
  pr_opened: "✅",
  answered: "💬",
  diagnosed_only: "🔍",
  already_fixed: "♻️",
  not_reproducible: "🤷"
}

// Statuses that produce a message. A re-patch of an unchanged row is silence
// by design; reporting that as a failed notification would teach the reader
// to ignore the warning that matters.
export const NOTIFYING: ReadonlyArray<string> = ["queued", "needs_owner", "investigating", "done", "error"]

export class Telegram extends Context.Service<Telegram, {
  readonly chatId: string
  readonly call: (method: string, body: unknown) => Effect.Effect<{ message_id: number } | undefined, TelegramError>
  readonly reply: (replyTo: number, html: string) => Effect.Effect<void>
  readonly answer: (callbackId: string, text: string) => Effect.Effect<void>
  /** Sends or updates the card for a report's current state. Null when
   * nothing was sent: no card for the state, or Telegram failed (logged). */
  readonly notify: (report: Domain.Report, as?: "followup") => Effect.Effect<number | null>
  readonly setWebhook: (url: string, secret: string) => Effect.Effect<{ ok: boolean; description?: string }>
}>()("pokecenter/Telegram") {
  static readonly make = (config: TelegramConfig) =>
    Effect.sync(() => {
      const raw = (method: string, body: unknown) =>
        Effect.tryPromise({
          try: async () => {
            const res = await fetch(`https://api.telegram.org/bot${Redacted.value(config.token)}/${method}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            })
            return (await res.json()) as {
              ok: boolean
              description?: string
              parameters?: { retry_after?: number }
              result?: { message_id: number }
            }
          },
          catch: (cause) => new TelegramError({ method, message: String(cause) })
        })

      // 429 carries retry_after in seconds. Flood control backs off for
      // minutes, so wait what it asks, a couple of times, then give up loudly.
      const call = (method: string, body: unknown, attempt = 0): Effect.Effect<{ message_id: number } | undefined, TelegramError> =>
        raw(method, body).pipe(
          Effect.flatMap((json) =>
            json.ok
              ? Effect.succeed(json.result)
              : Effect.fail(
                new TelegramError({
                  method,
                  message: json.description ?? "unknown error",
                  ...(json.parameters?.retry_after ? { retryAfter: json.parameters.retry_after } : {})
                })
              )
          ),
          Effect.catchTag("TelegramError", (error) =>
            attempt < 2 && error.retryAfter !== undefined && error.retryAfter <= 30
              ? Effect.sleep(Duration.seconds(error.retryAfter)).pipe(Effect.andThen(call(method, body, attempt + 1)))
              : Effect.fail(error))
        )

      const send = (html: string, buttons: Array<Array<Button>>, replyTo: number | null) =>
        call("sendMessage", {
          chat_id: config.chatId,
          text: html,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
          ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {})
        }).pipe(Effect.map((r) => r?.message_id ?? null))

      const notify = (report: Domain.Report, as?: "followup") =>
        Effect.gen(function*() {
          const link = `${config.origin}/#/t/${report.short_id}`
          const thread = report.tg_message
          const head = `<b>${escape(report.subject)}</b>\nfrom ${escape(report.from_addr)}` +
            // Triage flags mail that tries to direct its reader.
            (report.suspicious ? "\n⚠️ <i>This email asks the reader to take action beyond reporting</i>" : "")
          const open = { text: "Open thread", url: link }

          if (as === "followup") {
            // A later email landed on this thread. The row's own status is
            // untouched; the buttons decide what happens next.
            return yield* send(`↩️ <b>Follow-up</b>\n${head}`, [
              [open],
              [{ text: "Investigate", callback_data: `q:${report.short_id}` }, {
                text: "Ignore",
                callback_data: `x:${report.short_id}`
              }]
            ], thread)
          }
          switch (report.status) {
            case "ignored": {
              // Ignored mail never gets a card. A card exists here only when
              // the report had one before; rewrite it down to one line.
              if (!thread) return null
              yield* call("editMessageText", {
                chat_id: config.chatId,
                message_id: thread,
                text: `🗑 <s>${escape(report.subject)}</s>\n<i>${escape(report.reason ?? "ignored")}</i>`,
                parse_mode: "HTML",
                disable_web_page_preview: true,
                reply_markup: {
                  inline_keyboard: [[open, { text: "Investigate anyway", callback_data: `q:${report.short_id}` }]]
                }
              })
              return null
            }
            case "queued":
              return yield* send(`🔧 <b>Queued</b>\n${head}\n\n${escape(report.reason ?? "")}`, [
                [open, { text: "Skip this one", callback_data: `x:${report.short_id}` }]
              ], thread)
            case "needs_owner":
              return yield* send(`🙋 <b>Needs you</b>\n${head}\n\n${escape(report.reason ?? "")}`, [
                [open],
                [{ text: "Investigate anyway", callback_data: `q:${report.short_id}` }, {
                  text: "Ignore",
                  callback_data: `x:${report.short_id}`
                }]
              ], thread)
            case "investigating":
              return yield* send(`🔎 <b>Investigating</b>\n${head}`, [[{ text: "Watch", url: link }]], thread)
            case "done": {
              const icon = OUTCOME_ICON[report.outcome ?? ""] ?? "•"
              return yield* send(
                `${icon} <b>${escape(report.outcome ?? "done")}</b>\n${head}\n\n${
                  escape((report.findings ?? "").slice(0, 1500))
                }`,
                report.pr_url ? [[{ text: "Review PR", url: report.pr_url }], [open]] : [[open]],
                thread
              )
            }
            case "error":
              return yield* send(
                `💥 <b>Investigation failed</b>\n${head}\n\n${escape((report.findings ?? "").slice(0, 800))}`,
                [[open, { text: "Retry", callback_data: `q:${report.short_id}` }]],
                thread
              )
            default:
              return null
          }
        }).pipe(
          Effect.tapCause((cause) => Effect.logError("telegram notify failed", cause)),
          Effect.catchCause(() => Effect.succeed(null))
        )

      return Telegram.of({
        chatId: config.chatId,
        call,
        notify,
        reply: (replyTo, html) =>
          call("sendMessage", {
            chat_id: config.chatId,
            text: html,
            parse_mode: "HTML",
            reply_parameters: { message_id: replyTo, allow_sending_without_reply: true }
          }).pipe(Effect.ignore),
        answer: (callbackId, text) =>
          call("answerCallbackQuery", { callback_query_id: callbackId, text }).pipe(Effect.ignore),
        setWebhook: (url, secret) =>
          raw("setWebhook", {
            url,
            secret_token: secret,
            allowed_updates: ["callback_query", "message"]
          }).pipe(
            Effect.map((json) => ({ ok: json.ok, ...(json.description ? { description: json.description } : {}) })),
            Effect.catch((e) => Effect.succeed({ ok: false, description: e.message }))
          )
      })
    })

  static readonly layer = (config: TelegramConfig) => Layer.effect(Telegram, Telegram.make(config))
}

/** The short id a card carries in its buttons: the thread link or a callback.
 * Reading it from there matches a reply to any card for a report. */
export const shortIdOfCard = (
  markup: { inline_keyboard?: ReadonlyArray<ReadonlyArray<{ url?: string; callback_data?: string }>> } | undefined
): string | null => {
  for (const button of (markup?.inline_keyboard ?? []).flat()) {
    const match = button.url?.match(/(?:\/r\/|#\/t\/)([0-9a-f]+)$/) ?? button.callback_data?.match(/^[qx]:([0-9a-f]+)$/)
    if (match) return match[1]!
  }
  return null
}
