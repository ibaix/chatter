import { secureHeaders } from 'hono/secure-headers';

/**
 * The security headers on each reply: the API, the web app and the 404 and error replies.
 * - No other site can show Chatter in a frame (X-Frame-Options and frame-ancestors).
 * - The browser does not guess the type of a file (nosniff).
 * - A link to another site does not send the Chatter address (Referrer-Policy).
 * - The Content-Security-Policy lets the page load scripts and data only from this server.
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
