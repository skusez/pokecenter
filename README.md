# pokecenter

Turns a support inbox into triaged Telegram cards and agent-drafted fixes.

Mail sent to your support address lands in a Cloudflare Worker. A decision model reads it, screenshots included, and settles what should happen to it:

- **Noise** (newsletters, sign-in codes, notices from other software, "request received" replies) is filed without a word.
- **Mail that needs a person** (pricing, an upset customer, help with something that isn't your software) gets a 🙋 card.
- **A real report or question** gets a 🔧 card. An agent on your machine then picks it up in a git worktree of the right repo. It opens a draft PR, answers the question, or explains what it found.

Every step lands in one Telegram thread per report and in a web inbox. Reply to a card to give the agent instructions; tap a button to queue or ignore.

It pokes you about what matters and heals what it can.

## How it works

```
email ─▶ Cloudflare Email Routing ─▶ worker ──▶ D1 (reports, events)   R2 (raw mail, attachments)
                                       │
                                       ├─ triage on Workers AI (Clef, with screenshots)
                                       ├─ Telegram cards, replies and buttons
                                       └─ HTTP API + thread UI
                                                    ▲
                     your machine: pokecenter agent ─┘  polls the queue, runs opencode
                                                        in a worktree, opens a draft PR
```

| Package | What it is |
|---|---|
| [`@skusez/pokecenter`](packages/core) | The shared core: schemas, mail parsing, threading, triage questions, the HTTP API definition |
| [`@skusez/pokecenter-cloudflare`](packages/cloudflare) | The worker, as a factory you deploy with [Alchemy](https://alchemy.run), and the thread UI |
| [`@skusez/pokecenter-agent`](packages/agent) | The `pokecenter` CLI: the agent loop, digests, replay, `doctor` and `install` |
| [`@skusez/create-pokecenter`](packages/create-pokecenter) | `npm create @skusez/pokecenter` |

Built on [Effect](https://effect.website) v4 and [Alchemy](https://alchemy.run) v2. Cloudflare only.

## Quickstart

```bash
npm create @skusez/pokecenter my-inbox
cd my-inbox && bun install
cp .env.example .env
```

1. **Cloudflare.** Make an API token that can edit Workers, D1, R2, Secrets Store, Email Routing and DNS, and set it with your account id in `.env`. The inbox's zone must be on that account.
2. **Telegram.** Create a bot with [@BotFather](https://t.me/BotFather), add it to a chat, and put the token and chat id in `.env`.
3. **Your inbox.** In `pokecenter.config.ts`, list what mail can be about (categories) in the words your customers use, and name the repo each lives in. In `worker.ts`, set the address, the zone and who may open the UI.
4. **Deploy.** Run `bun run deploy`. It prints the worker's `url` and an `agentToken`; put them in `.env` as `POKECENTER_URL` and `POKECENTER_TOKEN`.
5. **Connect Telegram.** Run `bunx pokecenter webhook register`.
6. **Set up the agent.** Install [opencode](https://opencode.ai) and sign it in to a model provider. List your checkouts in `REPOS`, then run `bunx pokecenter doctor`. When it passes, run `bunx pokecenter install` to run the agent on a schedule.

### Mail delivery

Email Routing needs Cloudflare's MX records on the domain that receives the mail. If your domain's mail already goes to Microsoft 365 or Google, use a subdomain (`support@inbox.example.com`). Alternatively, have the existing mailbox forward to the address.

From Outlook, forward reports **as attachment**. A plain forward rewrites the sender and buries the original in quoted text; forwarding as an attachment keeps the original message, and pokecenter reads the real sender from it.

## Triage

Four typed questions go to a decision model in one call:
- what should happen to the email
- which category it is about
- how serious it is
- whether it tries to direct its reader, such as asking for access or for a command to be run

The answers come back as calibrated probabilities. An "ignore" is only binned silently above a confidence threshold. Anything less certain goes to you, because a wrong card costs a glance while a real report binned unseen costs a customer.

| Backend | Model | Notes |
|---|---|---|
| `clef` (default) | `@cf/cloudflare/clef` | Sees up to four screenshots, shrunk with Cloudflare Images |
| `clef-flash` | `@cf/cloudflare/clef-flash` | Faster; labels much less as noise |
| `jev` | `typesafe/jev` | Bills AI Gateway credit |
| `open` | `@cf/qwen/qwen3.8-27b` | One question per call, read from token probabilities |

Tune the threshold on your own mail with `bunx pokecenter replay --backend clef`. Replay runs triage dry over past reports and compares each answer with where the report ended up, including every button you pressed.

**Screenshots are filtered.** Signature graphics (logos, award badges, social icons, headshot-sized images) are dropped at ingest by name, size and shape. Clef estimates image bytes as if they were text, so images are shrunk to 1024 px WebP and capped at a base64 budget before they're sent.

**Threading.** A reply is matched by its headers, or failing that by the same sender and subject within two months, and lands on its report as a follow-up. Mail on an ignored thread is triaged afresh instead, so a notice that repeats its subject every day stays in the bin.

## The agent

`pokecenter run` does three things:
- retries triage for anything the model couldn't reach
- writes a digest (the email restated under fixed headings) for each report worth opening
- investigates up to `MAX_INVESTIGATIONS_PER_RUN` queued reports

Each investigation:
1. Runs in a fresh git worktree cut from `origin/main`, or from the report's existing branch.
2. Runs the `investigate` opencode agent in that worktree, with the email, your notes, follow-ups and related earlier reports.
3. Ends in one of: a draft PR (`pr_opened`), an answer you can send as-is (`answered`), or a diagnosis.

A run that goes silent for ten minutes is stopped.

The default opencode agents ship with the package. To give the investigator more (an MCP server for your docs, say), put your own `.opencode/opencode.json` in the inbox project.

## Security

- **Email is untrusted.** Every prompt frames it as data describing a symptom. The triage models have no tools, so the worst an email can do there is misfile itself; mail that tries to direct its reader is flagged ⚠️ on its card. The investigator is told to refuse such requests and report them, and its permissions deny reading `.env` files, pushing to main, merging, releasing, deploying, `curl` and web access.
- **The agent never merges, pushes to main or deploys.** Its PRs are drafts for you to review.
- **Only your Telegram chat can instruct the agent,** and the webhook checks the secret Telegram echoes back.
- **The thread UI** is open only to the agent's bearer token and to whatever `auth` accepts: Cloudflare Access, or your own check.

## Costs

Mostly Cloudflare's:
- Workers AI for triage, which is a fraction of a cent per email with Clef
- Images transformations for screenshots
- D1, R2 and Workers usage

The agent uses whatever model provider opencode is signed in to.

## Caveats

- **`alchemy dev` creates a real Email Routing rule** for the address in `worker.ts`. Use a different address, or a different zone, for local development.
- **Version pins.** Alchemy v2 is in beta and parts of Effect v4 (HTTP API, SQL, AI, CLI) are unstable. pokecenter pins both and is versioned 0.x until they settle.

## License

MIT
