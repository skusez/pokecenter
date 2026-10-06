/**
 * The Cloudflare resources one inbox owns. Logical ids are fixed, so a stack
 * keeps its database, bucket and tokens across releases; they are scoped by
 * the stack, so two inboxes never share them. Secrets Store names are the
 * exception: they are account-wide, hence `secretPrefix`.
 */
import { Random } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"

import { MIGRATIONS_DIR } from "./Paths.ts"

export { MIGRATIONS_DIR, UI_DIR } from "./Paths.ts"

export interface ResourceOptions {
  /**
   * Prepended to the Secrets Store secret names, which are shared by every
   * stack on the account. Give each inbox its own.
   */
  readonly secretPrefix: string
}

/** The agent's token, minted once and kept in state. Read it in your stack to
 * output it for the agent's `POKECENTER_TOKEN`. */
export const AgentTokenValue = Random("AgentTokenValue")

export const resources = ({ secretPrefix }: ResourceOptions) => {
  const Database = Cloudflare.D1.Database("InboxDb", { migrations: MIGRATIONS_DIR })
  const Bucket = Cloudflare.R2.Bucket("InboxAttachments")
  /** One Secrets Store per account: this adopts the existing one and never
   * deletes it. */
  const SecretStore = Cloudflare.SecretsStore.Store("InboxSecrets")
  /** Minted once and kept in state, so every later deploy keeps it. */
  const WebhookSecretValue = Random("WebhookSecretValue", { bytes: 24 })
  /** Stored rather than bound from env: read live at runtime, so rotating
   * one takes effect without a redeploy. */
  const AgentToken = Effect.gen(function*() {
    const store = yield* SecretStore
    const value = yield* AgentTokenValue
    return yield* Cloudflare.SecretsStore.Secret("AgentToken", {
      store,
      value: value.text,
      name: `${secretPrefix}AgentToken`
    })
  })
  const WebhookSecret = Effect.gen(function*() {
    const store = yield* SecretStore
    const value = yield* WebhookSecretValue
    return yield* Cloudflare.SecretsStore.Secret("WebhookSecret", {
      store,
      value: value.text,
      name: `${secretPrefix}WebhookSecret`
    })
  })
  return { Database, Bucket, SecretStore, AgentTokenValue, WebhookSecretValue, AgentToken, WebhookSecret } as const
}
