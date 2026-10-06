/**
 * Who counts as the inbox's owner in a browser. The agent's bearer token is
 * always accepted; this decides everything else.
 */
import { Context, Effect, Layer } from "effect"

export interface AuthRequest {
  readonly headers: Readonly<Record<string, string | undefined>>
}

export class AuthPolicy extends Context.Service<AuthPolicy, {
  /** True when the request is the owner. Must not fail: an outage of
   * whatever it asks reads as "not signed in", never as "allowed". */
  readonly authorize: (request: AuthRequest) => Effect.Effect<boolean>
}>()("pokecenter/AuthPolicy") {
  /** Only the bearer token: the UI works through the dev proxy, not in a browser. */
  static readonly bearerOnly = Layer.succeed(AuthPolicy, AuthPolicy.of({ authorize: () => Effect.succeed(false) }))

  /** Any check of your own, from the request's headers. */
  static readonly custom = (authorize: (request: AuthRequest) => Effect.Effect<boolean>) =>
    Layer.succeed(AuthPolicy, AuthPolicy.of({ authorize }))

  /**
   * Cloudflare Access in front of the worker's domain. Verifies the token
   * Access attaches (`Cf-Access-Jwt-Assertion`, or the `CF_Authorization`
   * cookie) against the team's signing keys and the application's audience.
   */
  static readonly cloudflareAccess = (options: {
    /** e.g. `yourteam.cloudflareaccess.com` */
    readonly teamDomain: string
    /** The Access application's Audience (AUD) tag. */
    readonly audience: string
  }) =>
    Layer.sync(AuthPolicy, () => {
      const issuer = `https://${options.teamDomain}`
      let keys: { at: number; keys: Map<string, CryptoKey> } | null = null

      const signingKeys = Effect.tryPromise(async () => {
        if (keys && Date.now() - keys.at < 3_600_000) return keys.keys
        const res = await fetch(`${issuer}/cdn-cgi/access/certs`)
        const body = (await res.json()) as { keys: Array<JsonWebKey & { kid: string }> }
        const imported = new Map<string, CryptoKey>()
        for (const jwk of body.keys) {
          imported.set(
            jwk.kid,
            await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
          )
        }
        keys = { at: Date.now(), keys: imported }
        return imported
      })

      const decode = (part: string) =>
        Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))

      const verify = (token: string) =>
        Effect.gen(function*() {
          const [head, payload, signature] = token.split(".")
          if (!head || !payload || !signature) return false
          const header = JSON.parse(new TextDecoder().decode(decode(head))) as { kid?: string; alg?: string }
          if (header.alg !== "RS256" || !header.kid) return false
          const key = (yield* signingKeys).get(header.kid)
          if (!key) return false
          const valid = yield* Effect.tryPromise(() =>
            crypto.subtle.verify(
              "RSASSA-PKCS1-v1_5",
              key,
              decode(signature),
              new TextEncoder().encode(`${head}.${payload}`)
            )
          )
          if (!valid) return false
          const claims = JSON.parse(new TextDecoder().decode(decode(payload))) as {
            aud?: string | Array<string>
            exp?: number
            iss?: string
          }
          const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
          return audiences.includes(options.audience) && claims.iss === issuer &&
            (claims.exp ?? 0) * 1000 > Date.now()
        })

      return AuthPolicy.of({
        authorize: (request) => {
          const token = request.headers["cf-access-jwt-assertion"] ?? cookie(request.headers.cookie, "CF_Authorization")
          return token ? verify(token).pipe(Effect.orElseSucceed(() => false)) : Effect.succeed(false)
        }
      })
    })
}

/** A cookie's value from a Cookie header. */
export const cookie = (header: string | undefined, name: string): string | null =>
  header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null
