import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import { Effect, Redacted } from "effect"
import Inbox from "./worker.ts"
import { AgentTokenValue } from "@skusez/pokecenter-cloudflare"

export default Alchemy.Stack(
  "AcmeInbox",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function*() {
    const worker = yield* Inbox
    const token = yield* AgentTokenValue
    return {
      url: worker.url.as<string>(),
      // The agent's POKECENTER_TOKEN.
      agentToken: token.text.pipe(Output.map(Redacted.value))
    }
  })
)
