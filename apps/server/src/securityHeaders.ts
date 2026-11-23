import { secureHeaders } from 'hono/secure-headers';

/**
 * The security headers on each reply of the Hono app: the API, the web app and the 404 and error replies.
 * Node writes some replies itself, outside the app, so this middleware does not cover them: the 400 reply to a bad
 * request, the 431 reply to headers that are too large, and the 408 reply when a connection does not send its
 * headers in the time of headersTimeout. These replies have no body. The 408 reply of limitRequestTime
 * (webServerOptions.ts) is also outside the app, so it sets nosniff itself.
 * - No other site can show Chatter in a frame (X-Frame-Options and frame-ancestors).
 * - The browser does not guess the type of a file (nosniff).
 * - A link to another site does not send the Chatter address (Referrer-Policy).
 * - The Content-Security-Policy lets the page load scripts and data only from this server.
 *
 * These Hono defaults (hono 4.13) stay on:
 * - Cross-Origin-Opener-Policy: same-origin
 * - Cross-Origin-Resource-Policy: same-origin
 * - Origin-Agent-Cluster: ?1
 * - X-Content-Type-Options: nosniff
 * - X-DNS-Prefetch-Control: off
 * - X-Download-Options: noopen
 * - X-Permitted-Cross-Domain-Policies: none
 * - X-XSS-Protection: 0
 * - No X-Powered-By header
 * Hono leaves Cross-Origin-Embedder-Policy off by default, and Chatter keeps it off.
 *
 * No HSTS (Strict-Transport-Security). Chatter often runs on plain HTTP on a LAN, and HTTPS is optional
 * (see docs/guide/https.md). HSTS on a LAN address can lock the users out. A proxy that adds HTTPS can send HSTS.
 */
export function securityHeaders() {
  return secureHeaders({
    strictTransportSecurity: false,
    xFrameOptions: 'DENY',
    referrerPolicy: 'same-origin',
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      // No script in the page. apps/web/public/theme-start.js is a file for this reason.
      scriptSrc: ["'self'"],
      // Some libraries in the web app add <style> elements when they run (Emotion, and a resize detector)
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      // The built CSS has some fonts in data: addresses
      fontSrc: ["'self'", 'data:'],
      // The API and the live events (EventSource) are on this server
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  });
}
