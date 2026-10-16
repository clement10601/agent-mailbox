import { getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";

export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 86_400;

type Handler = ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>["fetch"]> };

/**
 * The single definition of the OAuthProvider options.
 *
 * `resource` is the protected resource URL (`<origin>/mcp`). The deployment host is not known at build time,
 * so the worker derives it from each request's origin; code that only needs grant bookkeeping (listing and
 * revoking grants) can pass any valid origin, because those helpers never look at the resource.
 */
export function providerOptions(origin: string, apiHandler: Handler, defaultHandler: Handler): OAuthProviderOptions<Env> {
  return {
    apiRoute: "/mcp",
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Agent Mailbox" },
  };
}

const unused: Handler = {
  fetch: () => new Response("Not Found", { status: 404 }),
};

/** Origin used where no request origin exists (inside the MCP Durable Object). Grant helpers ignore it. */
const BOOKKEEPING_ORIGIN = "https://agent-mailbox.invalid";

/**
 * OAuth helpers for grant bookkeeping outside a request the provider dispatched (the admin tools run in the
 * MCP Durable Object, whose env never receives `OAUTH_PROVIDER`). Grants and tokens live in OAUTH_KV, so these
 * helpers see exactly what the request-path provider wrote.
 */
export function grantHelpers(env: Env): OAuthHelpers {
  return getOAuthApi(providerOptions(BOOKKEEPING_ORIGIN, unused, unused), env);
}
