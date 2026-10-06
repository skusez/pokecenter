import PostalMime, { type Email } from "postal-mime"

export interface Attachment {
  readonly filename: string
  readonly mimeType: string
  readonly content: ArrayBuffer
}

export interface ParsedMail {
  readonly from: string
  readonly replyTo: string | null
  readonly subject: string
  readonly body: string
  readonly forwarded: boolean
  readonly attachments: ReadonlyArray<Attachment>
  /** The sender's own Message-Id: the inner message when forwarded as an
   * attachment. A reply from them references this one. */
  readonly originId: string | null
  /** Every id this mail says it replies to: In-Reply-To plus References. */
  readonly refs: ReadonlyArray<string>
  /** Why this is bulk mail, or null. Newsletters and notification streams
   * declare themselves in headers a person's email never carries. */
  readonly bulk: string | null
}

const header = (email: Email, name: string): string | null =>
  email.headers.find((h) => h.key.toLowerCase() === name)?.value ?? null

const bulkReason = (...emails: Array<Email>): string | null => {
  for (const email of emails) {
    if (header(email, "list-unsubscribe")) return "bulk mail: carries a List-Unsubscribe header"
    if (/^(bulk|list)$/i.test(header(email, "precedence") ?? "")) return "bulk mail: Precedence header"
    if (/^auto-/i.test(header(email, "auto-submitted") ?? "")) return "automated: Auto-Submitted header"
  }
  return null
}

const refsOf = (...emails: Array<Email>): Array<string> => [
  ...new Set(emails.flatMap((e) => `${e.inReplyTo ?? ""} ${e.references ?? ""}`.match(/<[^>]+>/g) ?? []))
]

// Only what a model or a person can look at. Everything else (.docx, .zip,
// tracking pixels) is weight with no signal. Outlook labels JPEGs `image/jpg`,
// which is not a registered type.
const VISIBLE = /^image\/(png|jpe?g|pjpeg|gif|webp)$|^application\/pdf$/

const MAX_ATTACHMENTS = 10

// Signature blocks ship logos, award badges and social icons. Forwarded a few
// levels deep, a report can carry several of them and no screenshot at all.
const DECORATIVE_NAME = /logo|signature|banner|footer|award|badge|icon|avatar/i

/** Width and height from the file header, or null when it cannot be read. */
export const dimensions = (bytes: Uint8Array): { width: number; height: number } | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = (offset: number, length: number) => bytes.byteLength >= offset + length
  // PNG: the IHDR chunk is always first.
  if (at(0, 24) && view.getUint32(0) === 0x89504e47) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  // GIF87a / GIF89a: logical screen size, little-endian.
  if (at(0, 10) && view.getUint32(0) === 0x47494638) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  // JPEG: walk the segments to the first start-of-frame.
  if (at(0, 4) && view.getUint16(0) === 0xffd8) {
    let offset = 2
    while (at(offset, 9)) {
      if (bytes[offset] !== 0xff) return null
      const marker = bytes[offset + 1]!
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      offset += 2 + view.getUint16(offset + 2)
    }
    return null
  }
  // WebP: RIFF....WEBP, then a VP8, VP8L or VP8X chunk.
  if (at(0, 30) && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const chunk = String.fromCharCode(...bytes.slice(12, 16))
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === "VP8X") {
      const w = bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)
      const h = bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)
      return { width: w + 1, height: h + 1 }
    }
  }
  return null
}

/**
 * Signature graphics (logos, award badges, social icons) are small, or short
 * and wide. A screenshot of a broken page is neither. Size in bytes cannot tell
 * them apart: a cropped screenshot saved as JPEG is often under 50 KB.
 */
const smallOrBanner = ({ height, width }: { width: number; height: number }): boolean =>
  Math.min(width, height) < 64 ||
  width * height < 50_000 ||
  (width / height >= 4 && height < 200) ||
  // Company logos: around 500×160 is common and passes the rules above.
  (width / height >= 2.5 && height < 220)

// Fallback for an inline image whose header cannot be read.
const INLINE_DECORATIVE_BYTES = 20_000

/**
 * For an image already stored, whose inline-or-attached flag is gone: kept
 * only when its header can be read and it is neither a signature-sized nor a
 * banner-shaped graphic. The inline rule, the stricter of the two.
 */
export const looksLikeScreenshot = (filename: string, bytes: Uint8Array): boolean => {
  if (DECORATIVE_NAME.test(filename)) return false
  const size = dimensions(bytes)
  return size !== null && !smallOrBanner(size)
}

type Part = Email["attachments"][number]

const decorative = (a: Part, bytes: Uint8Array): boolean => {
  if (DECORATIVE_NAME.test(a.filename ?? "")) return true
  if (a.mimeType === "application/pdf") return false
  const size = dimensions(bytes)
  // Pasted inline (a Content-ID, or Outlook's `inline` disposition) is where
  // signatures live. A file someone attached on purpose only has to be more
  // than an icon.
  const inline = Boolean(a.contentId) || a.disposition === "inline"
  if (!size) return inline && bytes.byteLength < INLINE_DECORATIVE_BYTES
  return inline ? smallOrBanner(size) : Math.min(size.width, size.height) < 64
}

const sha1 = async (content: ArrayBuffer): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-1", content))].map((b) => b.toString(16).padStart(2, "0")).join("")

/** The images and PDFs worth a look, in the order the email has them. The
 * same picture pasted again down a quoted chain is kept once. */
const visible = async (...emails: Array<Email>): Promise<Array<Attachment>> => {
  const seen = new Set<string>()
  const kept: Array<Attachment> = []
  for (const a of emails.flatMap((email) => email.attachments ?? [])) {
    if (kept.length === MAX_ATTACHMENTS) break
    if (!VISIBLE.test(a.mimeType) || !(a.content instanceof ArrayBuffer)) continue
    const bytes = new Uint8Array(a.content)
    if (decorative(a, bytes)) continue
    const hash = await sha1(a.content)
    if (seen.has(hash)) continue
    seen.add(hash)
    const mimeType = a.mimeType.replace(/^image\/(jpg|pjpeg)$/, "image/jpeg")
    kept.push({
      filename: a.filename?.replace(/[^\w.-]/g, "_") || `attachment-${kept.length}.${mimeType.split("/")[1]}`,
      mimeType,
      content: a.content
    })
  }
  return kept
}

const text = (email: Email): string =>
  email.text?.trim() ||
  (email.html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const address = (email: Email): string => email.from?.address ?? "unknown"

/**
 * An inline "Fw:" keeps the whole chain in the body, so the envelope sender is
 * whoever forwarded it. The deepest quoted `From:` is the person who actually
 * wrote in, and the one a reply should go to.
 */
const QUOTED_FROM = /^\s*From:\s*(?:"?([^"<\n]*?)"?\s*)?<?([^\s<>@]+@[^\s<>]+?)>?\s*$/gim

const deepestQuotedSender = (body: string): string | null => {
  const matches = [...body.matchAll(QUOTED_FROM)]
  return matches.length === 0 ? null : (matches[matches.length - 1]?.[2] ?? null)
}

/**
 * Parses raw RFC 822 mail. An Outlook "forward as attachment" wraps the
 * original as a message/rfc822 part; reading the outer envelope instead would
 * attribute every report to whoever forwarded it.
 */
export const parse = async (raw: ArrayBuffer): Promise<ParsedMail> => {
  const outer = await PostalMime.parse(raw)
  const nested = outer.attachments?.find((a) => a.mimeType === "message/rfc822")

  if (nested) {
    const inner = await PostalMime.parse(nested.content as ArrayBuffer)
    return {
      from: address(inner),
      replyTo: inner.replyTo?.[0]?.address ?? null,
      subject: inner.subject ?? outer.subject ?? "(no subject)",
      body: text(inner),
      forwarded: true,
      attachments: await visible(inner, outer),
      originId: inner.messageId ?? null,
      refs: refsOf(inner, outer),
      bulk: bulkReason(inner)
    }
  }

  const body = text(outer)
  const quoted = deepestQuotedSender(body)

  return {
    from: quoted ?? address(outer),
    replyTo: outer.replyTo?.[0]?.address ?? null,
    subject: (outer.subject ?? "(no subject)").replace(/^(?:(?:Fw|Fwd|Re):\s*)+/i, ""),
    body,
    forwarded: quoted !== null,
    attachments: await visible(outer),
    originId: outer.messageId ?? null,
    refs: refsOf(outer),
    bulk: bulkReason(outer)
  }
}

/** "Re: Fw: RE: Pulse" → "pulse", so a reply matches the report it answers. */
export const normalisedSubject = (subject: string): string =>
  subject.replace(/^(?:\s*(?:re|fw|fwd|aw|sv)\s*:)+/i, "").replace(/\s+/g, " ").trim().toLowerCase()

/** Words that carry meaning in a subject line: enough to find its siblings. */
export const keywords = (subject: string): Array<string> =>
  [...new Set(normalisedSubject(subject).split(/[^a-z0-9]+/).filter((w) => w.length > 3))].slice(0, 5)

/**
 * How likely an earlier report is the same thing: same sender or domain, the
 * same subject words, a fix that may already cover it. 2 or more is related.
 */
export const relatedness = (
  report: { readonly from_addr: string; readonly subject: string },
  other: { readonly from_addr: string; readonly subject: string; readonly outcome: string | null }
): number => {
  const domain = report.from_addr.split("@")[1] ?? "\u0000"
  const words = keywords(report.subject)
  const subject = normalisedSubject(other.subject)
  let n = 0
  if (other.from_addr === report.from_addr) n += 3
  else if (other.from_addr.endsWith(`@${domain}`)) n += 1
  n += words.filter((w) => subject.includes(w)).length * 2
  if (other.outcome === "pr_opened" || other.outcome === "already_fixed") n += 1
  return n
}
