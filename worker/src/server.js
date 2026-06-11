import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { createHash, createSign, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const config = {
  nodeEnv: env.NODE_ENV ?? 'development',
  host: env.HOST ?? '0.0.0.0',
  port: Number(env.PORT ?? 8080),
  dataDir: env.DATA_DIR ?? path.resolve(__dirname, '../../data'),
  allowedOrigins: splitList(env.ALLOWED_ORIGINS),
  publicApiUrl: trimSlash(env.PUBLIC_API_URL ?? ''),
  publicFrontendUrl: trimSlash(env.PUBLIC_FRONTEND_URL ?? ''),
  publishMode: env.PUBLISH_MODE ?? 'dry-run',
  maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024),
  maxPublicationsPerHour: Number(env.MAX_PUBLICATIONS_PER_HOUR ?? 20),
  archiveAccessKey: env.ARCHIVE_ACCESS_KEY ?? '',
  archiveSecretKey: env.ARCHIVE_SECRET_KEY ?? '',
  archiveSourcePrefix: env.ARCHIVE_SOURCE_PREFIX ?? 'prezenter-source',
  archiveOutputPrefix: env.ARCHIVE_OUTPUT_PREFIX ?? 'prezenter',
  archiveCollection: env.ARCHIVE_COLLECTION ?? '',
  archiveCreator: env.ARCHIVE_CREATOR ?? 'Prezenter',
  githubToken: env.GITHUB_TOKEN ?? '',
  githubAppId: env.GITHUB_APP_ID ?? '',
  githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID ?? '',
  githubAppPrivateKeyBase64: env.GITHUB_APP_PRIVATE_KEY_BASE64 ?? '',
  githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY ?? '',
  githubOwner: env.GITHUB_OWNER ?? '',
  githubRepo: env.GITHUB_REPO ?? '',
  githubWorkflow: env.GITHUB_WORKFLOW ?? 'build-presentation.yml',
  githubRef: env.GITHUB_REF ?? 'main',
  callbackSecret: env.CALLBACK_SECRET ?? ''
};

const dirs = {
  uploads: path.join(config.dataDir, 'uploads'),
  publications: path.join(config.dataDir, 'publications'),
  rooms: path.join(config.dataDir, 'rooms'),
  logs: path.join(config.dataDir, 'logs')
};

const publicationBuckets = new Map();
const rooms = new Map();
let githubInstallationTokenCache = null;

const app = Fastify({
  logger: true,
  bodyLimit: config.maxUploadBytes + 1024 * 1024,
  trustProxy: true
});

await prepareDataDirs();
await loadRooms();

await app.register(cors, {
  origin(origin, cb) {
    if (!origin || config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) {
      cb(null, true);
      return;
    }
    cb(new Error('Origin not allowed'), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Prezenter-Callback-Secret']
});

await app.register(multipart, {
  limits: {
    fileSize: config.maxUploadBytes,
    files: 1,
    fields: 20
  }
});

app.get('/health', async () => ({
  ok: true,
  mode: config.publishMode,
  time: new Date().toISOString()
}));

app.get('/api/config', async () => ({
  maxUploadBytes: config.maxUploadBytes,
  publishMode: config.publishMode,
  liveSync: true
}));

app.post('/api/rooms', async (request, reply) => {
  const body = parseJsonBody(request.body);
  const room = await createRoom(body?.title);
  reply.code(201);
  return publicRoom(room);
});

app.get('/api/rooms/:roomId', async (request, reply) => {
  const room = rooms.get(request.params.roomId);
  if (!room) {
    reply.code(404);
    return { error: 'room_not_found' };
  }
  return publicRoom(room, { includePresenter: false });
});

app.post('/api/publish', async (request, reply) => {
  const ip = request.ip;
  if (!consumeRateLimit(ip)) {
    reply.code(429);
    return { error: 'rate_limited' };
  }

  const publicationId = randomId('pub');
  const uploadDir = path.join(dirs.uploads, publicationId);
  await fs.mkdir(uploadDir, { recursive: true });

  const fields = {};
  let uploadedFile = null;

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (uploadedFile) {
        reply.code(400);
        return { error: 'only_one_bundle_file_is_allowed' };
      }
      const safeName = sanitizeFilename(part.filename || 'presentation-bundle.zip');
      const filePath = path.join(uploadDir, safeName);
      await pipeline(part.file, createWriteStream(filePath));
      uploadedFile = {
        fieldName: part.fieldname,
        filename: safeName,
        mimeType: part.mimetype,
        path: filePath
      };
    } else {
      fields[part.fieldname] = String(part.value ?? '').trim();
    }
  }

  const validation = validatePublication(fields, uploadedFile);
  if (validation.length > 0) {
    reply.code(400);
    return { error: 'invalid_publication', details: validation };
  }

  const createdAt = new Date().toISOString();
  const title = fields.title;
  const short = publicationId.replace(/^pub_/, '').slice(0, 10);
  const sourceIdentifier = fields.sourceIdentifier || makeArchiveIdentifier(config.archiveSourcePrefix, title, short);
  const outputIdentifier = fields.outputIdentifier || makeArchiveIdentifier(config.archiveOutputPrefix, title, short);
  const room = await createRoom(title);

  const publication = {
    id: publicationId,
    createdAt,
    updatedAt: createdAt,
    status: 'received',
    title,
    language: fields.language,
    license: fields.license,
    sourceIdentifier,
    sourceFile: uploadedFile.filename,
    outputIdentifier,
    roomId: room.roomId,
    viewerUrl: publicRoom(room).viewerUrl,
    presenterUrl: publicRoom(room).presenterUrl,
    bundle: {
      filename: uploadedFile.filename,
      mimeType: uploadedFile.mimeType,
      path: uploadedFile.path
    },
    checks: {
      rightsConfirmed: fields.rightsConfirmed === 'true',
      publicConfirmed: fields.publicConfirmed === 'true',
      accessibilityConfirmed: fields.accessibilityConfirmed === 'true'
    },
    events: [{ at: createdAt, status: 'received' }]
  };

  await savePublication(publication);
  await appendLog('publications.jsonl', summarizePublication(publication));

  queuePublication(publication.id);

  reply.code(202);
  return clientPublication(publication);
});

app.get('/api/publications/:publicationId/status', async (request, reply) => {
  const publication = await readPublication(request.params.publicationId);
  if (!publication) {
    reply.code(404);
    return { error: 'publication_not_found' };
  }
  return clientPublication(publication);
});

app.post('/api/github/callback', async (request, reply) => {
  if (!config.callbackSecret) {
    reply.code(503);
    return { error: 'callback_secret_not_configured' };
  }

  const provided = request.headers['x-prezenter-callback-secret']
    || readBearer(request.headers.authorization);
  if (provided !== config.callbackSecret) {
    reply.code(401);
    return { error: 'unauthorized' };
  }

  const body = parseJsonBody(request.body);
  if (!body?.publicationId || !body?.status) {
    reply.code(400);
    return { error: 'publicationId_and_status_are_required' };
  }

  const publication = await readPublication(body.publicationId);
  if (!publication) {
    reply.code(404);
    return { error: 'publication_not_found' };
  }

  await updatePublication(publication.id, {
    status: body.status,
    resultUrl: body.resultUrl,
    archiveIdentifier: body.archiveIdentifier,
    accessibilityReport: body.accessibilityReport,
    callback: body
  });

  return { ok: true };
});

const server = app.server;
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws/live') {
    socket.destroy();
    return;
  }

  const roomId = url.searchParams.get('room');
  const role = url.searchParams.get('role') ?? 'viewer';
  const token = url.searchParams.get('token') ?? '';
  const room = rooms.get(roomId);

  if (!room) {
    socket.destroy();
    return;
  }

  if (role === 'presenter' && !verifyPresenterToken(room, token)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.roomId = roomId;
    ws.role = role === 'presenter' ? 'presenter' : 'viewer';
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  const room = rooms.get(ws.roomId);
  if (!room) {
    ws.close(1008, 'room_not_found');
    return;
  }

  ws.send(JSON.stringify({ type: 'state', roomId: room.roomId, state: room.state }));

  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
      return;
    }

    if (ws.role !== 'presenter') {
      ws.send(JSON.stringify({ type: 'error', error: 'viewer_is_read_only' }));
      return;
    }

    if (message.type !== 'state:update') {
      ws.send(JSON.stringify({ type: 'error', error: 'unsupported_message_type' }));
      return;
    }

    const nextState = sanitizeSlideState(message.state);
    room.state = { ...room.state, ...nextState, updatedAt: new Date().toISOString() };
    await persistRoom(room);
    broadcastRoom(room.roomId, { type: 'state', roomId: room.roomId, state: room.state });
  });
});

await app.ready();
await app.listen({ port: config.port, host: config.host });

function splitList(value) {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function trimSlash(value) {
  return value.replace(/\/+$/, '');
}

async function prepareDataDirs() {
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));
}

async function loadRooms() {
  const entries = await fs.readdir(dirs.rooms).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const room = await readJson(path.join(dirs.rooms, entry));
    if (room?.roomId) rooms.set(room.roomId, room);
  }
}

function randomId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function randomToken() {
  return randomBytes(32).toString('base64url');
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizeFilename(filename) {
  return path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
}

function slugify(value) {
  const slug = value
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/[\s_.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'presentation';
}

function makeArchiveIdentifier(prefix, title, short) {
  return `${prefix}-${slugify(title).slice(0, 48)}-${short}`.replace(/[^a-z0-9._-]/g, '-');
}

function validatePublication(fields, uploadedFile) {
  const errors = [];
  if (!fields.title) errors.push({ field: 'title', message: 'Title is required.' });
  if (!fields.language) errors.push({ field: 'language', message: 'Language is required.' });
  if (!fields.license) errors.push({ field: 'license', message: 'License is required.' });
  if (fields.rightsConfirmed !== 'true') errors.push({ field: 'rightsConfirmed', message: 'Rights confirmation is required.' });
  if (fields.publicConfirmed !== 'true') errors.push({ field: 'publicConfirmed', message: 'Public publication confirmation is required.' });
  if (fields.accessibilityConfirmed !== 'true') errors.push({ field: 'accessibilityConfirmed', message: 'Accessibility confirmation is required.' });
  if (!uploadedFile) errors.push({ field: 'bundle', message: 'A presentation bundle file is required.' });
  if (uploadedFile && !/\.(zip|tar|tar\.gz|tgz|md)$/i.test(uploadedFile.filename)) {
    errors.push({ field: 'bundle', message: 'Bundle must be .zip, .tar, .tar.gz, .tgz, or .md.' });
  }
  return errors;
}

function consumeRateLimit(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const bucket = publicationBuckets.get(ip) ?? [];
  const fresh = bucket.filter((timestamp) => now - timestamp < hour);
  if (fresh.length >= config.maxPublicationsPerHour) {
    publicationBuckets.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  publicationBuckets.set(ip, fresh);
  return true;
}

async function createRoom(title = '') {
  const roomId = randomId('room').slice(0, 22);
  const presenterKey = randomToken();
  const now = new Date().toISOString();
  const room = {
    roomId,
    title: String(title || 'Presentation room').slice(0, 160),
    presenterKeyHash: hash(presenterKey),
    createdAt: now,
    updatedAt: now,
    state: {
      indexh: 0,
      indexv: 0,
      fragment: -1,
      paused: false,
      updatedAt: now
    },
    presenterKey
  };
  rooms.set(roomId, room);
  await persistRoom(room);
  return room;
}

function publicRoom(room, options = {}) {
  const includePresenter = options.includePresenter ?? true;
  const viewerUrl = config.publicFrontendUrl
    ? `${config.publicFrontendUrl}/?room=${encodeURIComponent(room.roomId)}`
    : '';
  const presenterUrl = includePresenter && config.publicFrontendUrl
    ? `${config.publicFrontendUrl}/?room=${encodeURIComponent(room.roomId)}#presenterKey=${encodeURIComponent(room.presenterKey ?? '')}`
    : '';
  return {
    roomId: room.roomId,
    title: room.title,
    presenterKey: includePresenter ? room.presenterKey ?? '' : undefined,
    viewerUrl,
    presenterUrl,
    wsUrl: config.publicApiUrl ? `${config.publicApiUrl.replace(/^http/, 'ws')}/ws/live` : ''
  };
}

function verifyPresenterToken(room, token) {
  return Boolean(token && room.presenterKeyHash === hash(token));
}

async function persistRoom(room) {
  const safeRoom = { ...room };
  delete safeRoom.presenterKey;
  await writeJson(path.join(dirs.rooms, `${room.roomId}.json`), safeRoom);
}

function sanitizeSlideState(state) {
  const next = {};
  for (const key of ['indexh', 'indexv', 'fragment']) {
    if (Number.isInteger(state?.[key]) && state[key] >= -1 && state[key] <= 10000) {
      next[key] = state[key];
    }
  }
  if (typeof state?.paused === 'boolean') next.paused = state.paused;
  return next;
}

function broadcastRoom(roomId, payload) {
  const encoded = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.roomId === roomId) {
      client.send(encoded);
    }
  }
}

async function queuePublication(publicationId) {
  setTimeout(() => {
    processPublication(publicationId).catch(async (error) => {
      app.log.error({ error, publicationId }, 'publication processing failed');
      await updatePublication(publicationId, {
        status: 'failed',
        error: error.message
      });
    });
  }, 0);
}

async function processPublication(publicationId) {
  const publication = await readPublication(publicationId);
  if (!publication) return;

  const missing = missingLiveConfiguration();
  if (config.publishMode !== 'live' || missing.length > 0) {
    await updatePublication(publicationId, {
      status: 'awaiting_configuration',
      missingConfiguration: missing,
      note: config.publishMode !== 'live'
        ? 'PUBLISH_MODE is dry-run; external upload and GitHub dispatch were skipped.'
        : 'Required live configuration is missing.'
    });
    return;
  }

  await updatePublication(publicationId, { status: 'uploading_source_to_archive' });
  await uploadSourceToArchive(publication);

  await updatePublication(publicationId, { status: 'dispatching_github_workflow' });
  await dispatchGithubWorkflow(publication);

  await updatePublication(publicationId, { status: 'queued_in_github_actions' });
}

function missingLiveConfiguration() {
  const required = {
    ARCHIVE_ACCESS_KEY: config.archiveAccessKey,
    ARCHIVE_SECRET_KEY: config.archiveSecretKey,
    GITHUB_OWNER: config.githubOwner,
    GITHUB_REPO: config.githubRepo,
    CALLBACK_SECRET: config.callbackSecret,
    PUBLIC_API_URL: config.publicApiUrl
  };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
  if (!hasGithubDispatchCredentials()) {
    missing.push('GITHUB_APP_ID/GITHUB_APP_INSTALLATION_ID/GITHUB_APP_PRIVATE_KEY_BASE64 or GITHUB_TOKEN');
  }
  return missing;
}

function hasGithubDispatchCredentials() {
  return Boolean(config.githubToken || (
    config.githubAppId
    && config.githubAppInstallationId
    && getGithubAppPrivateKey()
  ));
}

async function uploadSourceToArchive(publication) {
  const configFile = path.join(config.dataDir, 'ia.ini');
  await fs.writeFile(configFile, `[s3]\naccess = ${config.archiveAccessKey}\nsecret = ${config.archiveSecretKey}\n`, { mode: 0o600 });

  const metadata = [
    `title:${publication.title} source bundle`,
    `mediatype:data`,
    `creator:${config.archiveCreator}`,
    `language:${publication.language}`,
    `licenseurl:${publication.license}`,
    `subject:prezenter;markdown;revealjs;presentation`
  ];
  if (config.archiveCollection) metadata.push(`collection:${config.archiveCollection}`);

  const args = [
    '--config-file', configFile,
    'upload',
    publication.sourceIdentifier,
    publication.bundle.path,
    '--remote-name', publication.sourceFile,
    '--retries', '3'
  ];
  for (const entry of metadata) args.push('--metadata', entry);

  await runCommand('ia', args, { cwd: config.dataDir });
}

async function dispatchGithubWorkflow(publication) {
  const callbackUrl = `${config.publicApiUrl}/api/github/callback`;
  const githubToken = await getGithubDispatchToken();
  const response = await fetch(
    `https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/actions/workflows/${config.githubWorkflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'prezenter-worker'
      },
      body: JSON.stringify({
        ref: config.githubRef,
        inputs: {
          publication_id: publication.id,
          source_identifier: publication.sourceIdentifier,
          source_file: publication.sourceFile,
          output_identifier: publication.outputIdentifier,
          callback_url: callbackUrl
        }
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub workflow dispatch failed: ${response.status} ${text}`);
  }
}

async function getGithubDispatchToken() {
  if (config.githubAppId && config.githubAppInstallationId && getGithubAppPrivateKey()) {
    return getGithubAppInstallationToken();
  }
  if (config.githubToken) {
    return config.githubToken;
  }
  throw new Error('GitHub dispatch credentials are not configured.');
}

async function getGithubAppInstallationToken() {
  const now = Date.now();
  if (
    githubInstallationTokenCache
    && githubInstallationTokenCache.expiresAtMs - 60_000 > now
  ) {
    return githubInstallationTokenCache.token;
  }

  const jwt = createGithubAppJwt();
  const response = await fetch(
    `https://api.github.com/app/installations/${config.githubAppInstallationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'prezenter-worker',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        repositories: [config.githubRepo],
        permissions: {
          actions: 'write'
        }
      })
    }
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) {
    throw new Error(`GitHub App installation token failed: ${response.status} ${JSON.stringify(body)}`);
  }

  githubInstallationTokenCache = {
    token: body.token,
    expiresAtMs: Date.parse(body.expires_at)
  };
  return githubInstallationTokenCache.token;
}

function createGithubAppJwt() {
  const privateKey = getGithubAppPrivateKey();
  if (!privateKey) throw new Error('GitHub App private key is not configured.');

  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 540,
    iss: config.githubAppId
  });
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey, 'base64url');
  return `${unsigned}.${signature}`;
}

function getGithubAppPrivateKey() {
  if (config.githubAppPrivateKeyBase64) {
    return Buffer.from(config.githubAppPrivateKeyBase64, 'base64').toString('utf8');
  }
  if (config.githubAppPrivateKey) {
    return config.githubAppPrivateKey.replace(/\\n/g, '\n');
  }
  return '';
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: { ...process.env, ...options.env }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      app.log.info({ command, output: chunk.toString().trim() }, 'external command output');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
  });
}

async function savePublication(publication) {
  await writeJson(path.join(dirs.publications, `${publication.id}.json`), publication);
}

async function updatePublication(publicationId, patch) {
  const publication = await readPublication(publicationId);
  if (!publication) return null;
  const now = new Date().toISOString();
  const updated = {
    ...publication,
    ...patch,
    updatedAt: now,
    events: [
      ...(publication.events ?? []),
      { at: now, status: patch.status ?? publication.status, patch }
    ]
  };
  await savePublication(updated);
  await appendLog('events.jsonl', { publicationId, at: now, patch });
  return updated;
}

async function readPublication(publicationId) {
  if (!/^pub_[a-f0-9]+$/.test(publicationId)) return null;
  return readJson(path.join(dirs.publications, `${publicationId}.json`));
}

function summarizePublication(publication) {
  return {
    id: publication.id,
    createdAt: publication.createdAt,
    title: publication.title,
    sourceIdentifier: publication.sourceIdentifier,
    outputIdentifier: publication.outputIdentifier,
    roomId: publication.roomId
  };
}

function clientPublication(publication) {
  return {
    id: publication.id,
    createdAt: publication.createdAt,
    updatedAt: publication.updatedAt,
    status: publication.status,
    title: publication.title,
    language: publication.language,
    license: publication.license,
    sourceIdentifier: publication.sourceIdentifier,
    sourceFile: publication.sourceFile,
    outputIdentifier: publication.outputIdentifier,
    resultUrl: publication.resultUrl,
    archiveIdentifier: publication.archiveIdentifier,
    roomId: publication.roomId,
    viewerUrl: publication.viewerUrl,
    presenterUrl: publication.presenterUrl,
    missingConfiguration: publication.missingConfiguration,
    note: publication.note,
    error: publication.error,
    events: publication.events
  };
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function appendLog(filename, data) {
  await fs.appendFile(path.join(dirs.logs, filename), `${JSON.stringify(data)}\n`, { mode: 0o600 });
}

function parseJsonBody(body) {
  if (!body) return {};
  if (typeof body === 'object') return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function readBearer(value) {
  if (!value) return '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1] ?? '';
}
