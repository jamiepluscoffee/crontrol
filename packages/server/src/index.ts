import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import {
  getJobDetail,
  dismissInputSchema,
  idParamsSchema,
  listJobCards,
  openDatabase,
  pingBodySchema,
  pingParamsSchema,
  pingQuerySchema,
  recordRun,
  redactSecrets,
  runInputSchema,
  superviseDatabase,
  upsertRemoteJob
} from '@crontrol/shared';
import { runChaos } from './supervision.js';
import { ApprovalError, approveIncident, dismissIncident } from './approval.js';
import { Sentinel } from './sentinel.js';

export { runChaos } from './supervision.js';

export async function buildServer() {
  const app = Fastify({ logger: false });
  const db = openDatabase();
  const clients = new Set<ServerResponse>();
  const pingStarts = new Map<string, number>();

  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', issues: error.issues });
    if (error instanceof ApprovalError) return reply.code(error.statusCode).send({ error: error.message });
    const message = error instanceof Error ? error.message : 'Internal server error';
    const status = message.startsWith('Demo jobs are missing') ? 404 : 500;
    return reply.code(status).send({ error: message });
  });

  const broadcast = (event: string) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
    for (const client of clients) client.write(payload);
  };
  const sentinel = new Sentinel(db, () => broadcast('proposal'));
  const scheduleIncidents = (incidents: Array<{ id: number }>) => {
    for (const incident of incidents) sentinel.schedule(incident.id);
  };
  const supervise = () => {
    const opened = superviseDatabase(db);
    scheduleIncidents(opened);
    broadcast(opened.length ? 'incident' : 'jobs');
    return opened;
  };

  superviseDatabase(db);
  sentinel.schedulePending();
  const watchdog = setInterval(supervise, 30_000);
  watchdog.unref();
  app.addHook('onClose', async () => {
    clearInterval(watchdog);
    for (const client of clients) client.end();
    db.close();
  });

  app.get('/api/jobs', async () => ({ jobs: listJobCards(db) }));
  app.get('/api/jobs/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const job = getJobDetail(db, id);
    return job ?? reply.code(404).send({ error: 'Job not found' });
  });

  app.post('/api/runs', async (request, reply) => {
    const input = runInputSchema.parse(request.body);
    const runId = recordRun(db, { ...input, logTail: redactSecrets(input.logTail) });
    const incidents = superviseDatabase(db);
    scheduleIncidents(incidents);
    broadcast(incidents.length ? 'incident' : 'run');
    return reply.code(201).send({ runId, incidents });
  });

  app.post('/api/ping/:name', async (request, reply) => {
    const { name } = pingParamsSchema.parse(request.params);
    const { state = 'success' } = pingQuerySchema.parse(request.query);
    const body = pingBodySchema.parse(request.body);
    const now = new Date();
    upsertRemoteJob(db, name, now);
    if (state === 'start') {
      pingStarts.set(name, now.getTime());
      broadcast('job');
      return reply.code(202).send({ name, state, startedAt: now.toISOString() });
    }
    const startedMs = pingStarts.get(name) ?? now.getTime();
    pingStarts.delete(name);
    const logTail = redactSecrets(typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body));
    const runId = recordRun(db, {
      name,
      command: `remote:${name}`,
      cwd: process.cwd(),
      startedAt: new Date(startedMs).toISOString(),
      endedAt: now.toISOString(),
      exitCode: state === 'fail' ? 1 : 0,
      durationMs: Math.max(0, now.getTime() - startedMs),
      logTail,
      source: 'api'
    });
    const incidents = superviseDatabase(db);
    scheduleIncidents(incidents);
    broadcast(incidents.length ? 'incident' : 'run');
    return reply.code(201).send({ name, state, runId, incidents });
  });

  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    clients.add(reply.raw);
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    request.raw.on('close', () => clients.delete(reply.raw));
  });

  app.post('/api/chaos', async (_request, reply) => {
    const result = await runChaos(db);
    const incident = result.incident as { id: number } | undefined;
    if (result.openedIncident && incident) sentinel.schedule(incident.id);
    broadcast('incident');
    return reply.code(201).send(result);
  });

  app.post('/api/incidents/:id/approve', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const result = await approveIncident(db, id);
    if (!result.closed) sentinel.schedule(id);
    broadcast(result.closed ? 'incident-closed' : 'run');
    return reply.send(result);
  });

  app.post('/api/incidents/:id/dismiss', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const { reason } = dismissInputSchema.parse(request.body);
    const result = dismissIncident(db, id, reason);
    broadcast('incident-closed');
    return reply.send(result);
  });

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
