import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listJobCards, openDatabase } from '@crontrol/shared';

export async function buildServer() {
  const app = Fastify({ logger: false });
  const db = openDatabase();
  app.addHook('onClose', async () => db.close());
  app.get('/api/jobs', async () => ({ jobs: listJobCards(db) }));

  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  if (!existsSync(join(publicDir, 'index.html'))) {
    throw new Error('Dashboard assets are missing. Run `pnpm build` first.');
  }
  await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
  return app;
}

export async function startServer(port = 4100) {
  const app = await buildServer();
  await app.listen({ port, host: '127.0.0.1' });
  return app;
}
