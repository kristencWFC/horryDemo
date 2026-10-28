// Server assembly. CORS is registered FIRST (house rule — the WxCC Desktop is a foreign
// origin), then form parsing (Twilio + NextGen token are form-encoded), the raw-body JSON
// parser (ElevenLabs HMAC is over the exact bytes), static pages, the NextGen mock, routes.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { registerRoutes, type Deps } from './routes.js';
import { registerNextGenMock } from './nextgen-mock.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildServer(deps: Deps): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });

  await f.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });
  await f.register(formbody);

  f.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const publicDir = join(here, '..', 'public');
  if (existsSync(publicDir)) {
    await f.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      cacheControl: false,
      setHeaders: (res) => {
        res.header('cache-control', 'no-cache');
      },
    });
  }

  // Desktop widgets bundle (packages/widgets → dist/horry-widgets.js) at /widgets/.
  const widgetsDist = join(here, '..', '..', 'widgets', 'dist');
  if (existsSync(widgetsDist)) {
    await f.register(fastifyStatic, {
      root: widgetsDist,
      prefix: '/widgets/',
      decorateReply: false,
      cacheControl: false, // no-cache: the Desktop otherwise serves a stale bundle after deploys
      setHeaders: (res) => {
        res.header('cache-control', 'no-cache');
      },
    });
  }

  registerNextGenMock(f, deps.members);
  registerRoutes(f, deps);
  return f;
}
