import type { Severity, Verdict } from "./Domain.ts"

/**
 * Who answers triage. The decision models take every question in one call and
 * return calibrated probabilities: Cloudflare's Clef and Clef-flash (which also
 * see screenshots) and TypeSafe's Jev. "open" asks an open model on Workers AI
 * one question at a time and reads the answer from its token probabilities.
 */
export const BACKENDS = ["clef", "clef-flash", "jev", "open"] as const
export type Backend = (typeof BACKENDS)[number]

export interface Category {
  /** What it is, in the words the people writing in use. The model matches on this. */
  readonly description: string
  /** The repo its code lives in, by the name the agent's `REPOS` gives it. */
  readonly repo?: string | null
}

export interface ProfileInput {
  /** The organisation or product suite, as prompts refer to it. */
  readonly name: string
  /**
   * What the inbox is for, completing "This email reached the support
   * address for …". Say who writes in.
   */
  readonly about: string
  /** The person `needs_owner` mail goes to, as prompts and the UI name them. */
  readonly owner: string
  /** What mail can be about. `unknown` is added for mail that fits none. */
  readonly categories: Readonly<Record<string, Category>>
  /** Replaces the default wording of each verdict. */
  readonly verdicts?: Partial<Readonly<Record<Verdict, string>>>
  readonly severity?: Partial<Readonly<Record<Severity, string>>>
  readonly classifier?: {
    readonly backend?: Backend
    /**
     * Below this confidence an "ignore" goes to the owner instead of the bin.
     * Per backend, since each is calibrated differently. Tune it with replay.
     */
    readonly ignoreConfidence?: Partial<Readonly<Record<Backend, number>>>
  }
  readonly investigator?: {
    /** Extra guidance appended to the investigator's instructions. */
    readonly instructions?: string
  }
  readonly ui?: {
    readonly title?: string
    /** Where a signed-out visitor should go to sign in. */
    readonly signIn?: { readonly label: string; readonly url: string }
  }
}

export interface Profile {
  readonly name: string
  readonly about: string
  readonly owner: string
  readonly categories: Readonly<Record<string, Required<Category>>>
  readonly verdicts: Readonly<Record<Verdict, string>>
  readonly severity: Readonly<Record<Severity, string>>
  readonly backend: Backend
  readonly ignoreConfidence: Readonly<Record<Backend, number>>
  readonly investigatorInstructions: string
  readonly ui: { readonly title: string; readonly signIn: { readonly label: string; readonly url: string } | null }
}

export const UNKNOWN = "unknown"

const defaultVerdicts = (input: ProfileInput): Record<Verdict, string> => ({
  queue: `A person is asking about ${input.name}'s software: a defect, an error, missing or wrong data, a feature request, or a question about how it works. Brief or vague still counts, including "see attached" or a screenshot of an error with hardly any text.`,
  needs_owner:
    "Someone needs a person rather than a change to the software: pricing or contract negotiation, an upset customer who wants a personal reply, or help with something that is not this software.",
  ignore:
    "Nobody is asking for anything: a newsletter, marketing, an automated notification or alert, sign-in codes and links, security and sign-in alerts, change notices from other software, a supplier's support desk writing back about a ticket you raised with them (including \"request received\" and automatic replies), a calendar invite or meeting notification, an invoice, receipt or renewal notice, a delivery notice, a thank-you, internal chatter, or a problem the email says is already resolved."
})

const DEFAULT_SEVERITY: Record<Severity, string> = {
  high: "Stops people working or is wrong for many people: cannot sign in, data lost, figures or payments wrong for a whole team.",
  medium: "Something is broken or wrong for one person or one screen, or there is a workaround.",
  low: "Cosmetic, a question, a feature request, or nothing is broken."
}

/**
 * Calibrated on real mail: no backend binned a real report at any of these.
 * Clef reads lower than the others, so its bar is lower.
 */
const DEFAULT_IGNORE_CONFIDENCE: Record<Backend, number> = { clef: 0.5, "clef-flash": 0.6, jev: 0.6, open: 0.6 }

/** One inbox's configuration, with defaults filled in. */
export const define = (input: ProfileInput): Profile => {
  const categories: Record<string, Required<Category>> = {}
  for (const [id, category] of Object.entries(input.categories)) {
    categories[id] = { description: category.description, repo: category.repo ?? null }
  }
  categories[UNKNOWN] ??= {
    description: "None of these, or the email names nothing that places it in one of them.",
    repo: null
  }
  return {
    name: input.name,
    about: input.about,
    owner: input.owner,
    categories,
    verdicts: { ...defaultVerdicts(input), ...input.verdicts },
    severity: { ...DEFAULT_SEVERITY, ...input.severity },
    backend: input.classifier?.backend ?? "clef",
    ignoreConfidence: { ...DEFAULT_IGNORE_CONFIDENCE, ...input.classifier?.ignoreConfidence },
    investigatorInstructions: input.investigator?.instructions ?? "",
    ui: { title: input.ui?.title ?? `${input.name} inbox`, signIn: input.ui?.signIn ?? null }
  }
}

/** The category a stored value names, or `unknown`. */
export const categoryOf = (profile: Profile, value: string | null | undefined): string =>
  value && value in profile.categories ? value : UNKNOWN
