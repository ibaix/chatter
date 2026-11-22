import { bodyLimit } from 'hono/body-limit';
import { validator } from 'hono/validator';
import type { z } from 'zod';

/**
 * Check a part of the request against a zod schema.
 * A bad request gets 400 with the first problem as the error text.
 * The schema also tells the typed web client (hono/client) what the route accepts.
 */
function checked<Target extends 'json' | 'form' | 'query' | 'param', Schema extends z.ZodType>(target: Target, schema: Schema) {
  return validator(target, (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) return c.json({ error: result.error.issues[0].message }, 400);
    return result.data as z.output<Schema>;
  });
}

/** The largest JSON body that a route takes, if the route does not give its own limit */
const JSON_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Check the JSON body against a zod schema. A body larger than `maxBytes` gets 413, and the check does not read it.
 * The login routes need no login, so without this limit one computer on the network could fill the memory of a Pi.
 */
export function checkedJson<Schema extends z.ZodType>(schema: Schema, maxBytes = JSON_BODY_LIMIT_BYTES) {
  const sizeLimit = bodyLimit({ maxSize: maxBytes, onError: c => c.json({ error: 'The body is too large' }, 413) });
  const check = checked('json', schema);
  // The type of the check stays, so the typed web client still knows what the route accepts
  return (async (c, next) => {
    // The reply of a refused check, as Hono types it for the web client
    let checkReply: unknown;
    const sizeReply = await sizeLimit(c, async () => {
      checkReply = await check(c, next);
    });
    return (sizeReply ?? checkReply) as Response | undefined;
  }) as typeof check;
}

export const checkedForm = <Schema extends z.ZodType>(schema: Schema) => checked('form', schema);
export const checkedQuery = <Schema extends z.ZodType>(schema: Schema) => checked('query', schema);
export const checkedParam = <Schema extends z.ZodType>(schema: Schema) => checked('param', schema);
