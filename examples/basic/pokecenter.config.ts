import { Profile } from "@skusez/pokecenter"

/**
 * Your inbox. Describe what mail can be about in the words the people writing
 * in use: the model matches on these descriptions. `repo` names the checkout,
 * by its name in REPOS, that the agent investigates that category in.
 */
export default Profile.define({
  name: "Acme",
  about: "Acme's invoicing app, which small businesses use",
  owner: "Sam",
  categories: {
    web: { description: "The web app: signing in, invoices, customers, settings.", repo: "acme-web" },
    api: { description: "The public API and webhooks other software calls.", repo: "acme-api" }
  },
  ui: { title: "Acme inbox" }
})
