import { serve } from "@hono/node-server";
import app from "./index.js";

/*
 * Local dev only — excluded from deployment.
 * Imports @hono/node-server which is incompatible with the Vercel Edge runtime.
 */

const port = Number(process.env.PORT ?? "3003");
serve({ fetch: app.fetch, port });
console.log(`Cast Stats snap listening on http://localhost:${port}`);
