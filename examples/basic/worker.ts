import * as Pokecenter from "@skusez/pokecenter-cloudflare"
import profile from "./pokecenter.config.ts"

/**
 * The inbox worker. This module must be the worker's `main` and
 * default-export the class.
 */
export default class Inbox extends Pokecenter.worker<Inbox>()({
  main: import.meta.url,
  profile,
  // The worker's own domain, on a zone in your Cloudflare account.
  domain: "inbox.acme.example",
  // Mail to this address is triaged. The zone needs Email Routing enabled.
  email: { address: "support@acme.example", zone: "acme.example" },
  // Who can open the thread UI in a browser. Put the domain behind Cloudflare
  // Access and give its team domain and the application's AUD tag.
  auth: Pokecenter.AuthPolicy.cloudflareAccess({
    teamDomain: "acme.cloudflareaccess.com",
    audience: "your-access-application-aud-tag"
  })
}) {}
