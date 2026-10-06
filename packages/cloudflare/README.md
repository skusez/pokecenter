# @skusez/pokecenter-cloudflare

The [pokecenter](https://github.com/skusez/pokecenter) worker, deployed with [Alchemy](https://alchemy.run). It does four things:
- receives mail through Email Routing
- triages it on Workers AI
- sends Telegram cards
- serves the HTTP API and the thread UI

```ts
import * as Pokecenter from "@skusez/pokecenter-cloudflare"
import profile from "./pokecenter.config.ts"

// This module must be the worker's `main` and default-export the class.
export default class Inbox extends Pokecenter.worker<Inbox>()({
  main: import.meta.url,
  profile,
  domain: "inbox.example.com",
  email: { address: "support@example.com", zone: "example.com" },
  auth: Pokecenter.AuthPolicy.cloudflareAccess({ teamDomain: "team.cloudflareaccess.com", audience: "…" })
}) {}
```

The worker needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the environment at deploy time. Start from `npm create @skusez/pokecenter`.
