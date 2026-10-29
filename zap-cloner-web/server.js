import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!PANEL_PASSWORD) {
  console.error('Defina a variável de ambiente PANEL_PASSWORD (senha do painel).');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUTH_DIR = path.join(DATA_DIR, 'auth');

const pinoLog = pino({ level: 'info' });

// ---------- configuração (salva em disco, editada pelo painel) ----------

const defaults = {
  sourceGroup: '',
  targetGroup: '',
  shopeeAppId: '',
  shopeeSecret: '',
  shopeeSubId: 'clone',
  mlParams: '',
  allowOtherLinks: false,
  minDelay: 5,
  maxDelay: 20,
};

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}
let config = { ...defaults, ...readConfig() };
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

// ---------- estado e logs ----------

const state = { status: 'iniciando', qr: null, groups: [] };
const logs = [];
function addLog(msg) {
  logs.unshift({ t: new Date().toISOString(), msg });
  if (logs.length > 100) logs.pop();
  pinoLog.info(msg);
}

// ---------- conversão de links ----------

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const isShopee = (h) => /(^|\.)(shopee\.com\.br|shope\.ee|shp\.ee)$/.test(h);
const isML = (h) => /(^|\.)(mercadolivre\.com\.br|mercadolivre\.com|mercadolibre\.com|meli\.la)$/.test(h);

async function resolveFinal(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  return res.url;
}

function stripQuery(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.toString();
}

async function shopeeLink(originUrl) {
  if (!config.shopeeAppId || !config.shopeeSecret) throw new Error('chaves da Shopee não configuradas');
  const query = `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}, subIds: [${JSON.stringify(config.shopeeSubId || 'clone')}] }) { shortLink } }`;
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash('sha256').update(`${config.shopeeAppId}${ts}${payload}${config.shopeeSecret}`).digest('hex');
  const res = await fetch('https://open-api.affiliate.shopee.com.br/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `SHA256 Credential=${config.shopeeAppId}, Timestamp=${ts}, Signature=${sig}`,
    },
    body: payload,
  });
  const json = await res.json();
  const link = json?.data?.generateShortLink?.shortLink;
  if (!link) throw new Error('Shopee: ' + JSON.stringify(json.errors ?? json));
  return link;
}

function mlLink(finalUrl) {
  if (!config.mlParams) throw new Error('parâmetros do Mercado Livre não configurados');
  return `${stripQuery(finalUrl)}?${config.mlParams.replace(/^\?/, '')}`;
}

async function convertText(text) {
  const urls = text.match(URL_RE) ?? [];
  if (!urls.length) return null;

  let out = text;
  let converted = 0;

  for (const raw of urls) {
    const clean = raw.replace(/[.,;!?]+$/, '');
    let host;
    try {
      host = new URL(clean).hostname.toLowerCase();
    } catch {
      continue;
    }

    try {
      let replacement = null;
      if (isShopee(host)) {
        const finalUrl = await resolveFinal(clean);
        replacement = await shopeeLink(stripQuery(finalUrl));
      } else if (isML(host)) {
        const finalUrl = await resolveFinal(clean);
        replacement = mlLink(finalUrl);
      } else if (!config.allowOtherLinks) {
        addLog('Ignorada: tem link de outra loja (' + host + ')');
        return null;
      }
      if (replacement) {
        out = out.replaceAll(clean, replacement);
        converted++;
      }
    } catch (err) {
      addLog('Ignorada: falha ao converter ' + host + ' — ' + String(err.message ?? err));
      return null;
    }
  }
  return converted ? out : null;
}

// ---------- fila e deduplicação ----------

const sentHashes = new Map();
const DAY = 24 * 60 * 60 * 1000;
let queue = Promise.resolve();

function isDuplicate(text) {
  const now = Date.now();
  for (const [k, t] of sentHashes) if (now - t > DAY) sentHashes.delete(k);
  const hash = crypto.createHash('sha1').update(text).digest('hex');
  if (sentHashes.has(hash)) return true;
  sentHashes.set(hash, now);
  return false;
}

const enqueue = (task) => {
  queue = queue.then(task).catch((e) => addLog('Erro no envio: ' + String(e)));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => {
  const min = Number(config.minDelay) * 1000;
  const max = Number(config.maxDelay) * 1000;
  return min + Math.random() * Math.max(0, max - min);
};

// ---------- WhatsApp ----------

let sock = null;

function extract(message) {
  const m = message.ephemeralMessage?.message ?? message;
  if (m.viewOnceMessage || m.viewOnceMessageV2) return null;
  if (m.conversation) return { text: m.conversation };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text };
  if (m.imageMessage) return { text: m.imageMessage.caption ?? '', media: 'image' };
  if (m.videoMessage) return { text: m.videoMessage.caption ?? '', media: 'video' };
  return null;
}

async function handle(s, msg) {
  if (!msg.message || msg.key.fromMe) return;
  if (!config.sourceGroup || !config.targetGroup) return;
  if (msg.key.remoteJid !== config.sourceGroup) return;

  const data = extract(msg.message);
  if (!data?.text) return;

  const newText = await convertText(data.text);
  if (!newText) return;
  if (isDuplicate(newText)) {
    addLog('Ignorada: oferta repetida');
    return;
  }

  let buffer = null;
  if (data.media) {
    try {
      buffer = await downloadMediaMessage(msg, 'buffer', {});
    } catch (err) {
      addLog('Não consegui baixar a mídia, enviando só o texto');
    }
  }

  enqueue(async () => {
    await sleep(randomDelay());
    const target = config.targetGroup;
    if (buffer && data.media === 'image') await s.sendMessage(target, { image: buffer, caption: newText });
    else if (buffer && data.media === 'video') await s.sendMessage(target, { video: buffer, caption: newText });
    else await s.sendMessage(target, { text: newText });
    addLog('Oferta enviada: ' + newText.slice(0, 60).replace(/\s+/g, ' ') + '...');
  });
}

async function loadGroups(s) {
  const groups = await s.groupFetchAllParticipating();
  state.groups = Object.values(groups)
    .map((g) => ({ id: g.id, name: g.subject }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function start() {
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const s = makeWASocket({ version, auth, logger: pino({ level: 'silent' }) });
  sock = s;

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (s !== sock) return;
    if (qr) {
      state.status = 'aguardando QR Code';
      state.qr = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
    }
    if (connection === 'open') {
      state.status = 'conectado';
      state.qr = null;
      addLog('WhatsApp conectado');
      try {
        await loadGroups(s);
      } catch (e) {
        addLog('Não consegui listar os grupos: ' + String(e));
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      state.groups = [];
      if (code === DisconnectReason.loggedOut) {
        addLog('Sessão encerrada, gerando novo QR Code');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        addLog('Conexão caiu, reconectando...');
      }
      state.status = 'reconectando';
      setTimeout(() => {
        if (s === sock) start().catch((e) => addLog('Erro ao reconectar: ' + String(e)));
      }, 3000);
    }
  });

  s.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handle(s, msg);
      } catch (err) {
        addLog('Erro: ' + String(err));
      }
    }
  });
}

// ---------- painel web ----------

const app = express();

app.use((req, res, next) => {
  const [scheme, b64] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && b64) {
    const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass);
    const b = Buffer.from(PANEL_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="zap-cloner"').status(401).send('Autenticação necessária');
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    status: state.status,
    qr: state.qr,
    groups: state.groups,
    logs,
    config: { ...config, shopeeSecret: config.shopeeSecret ? '********' : '' },
  });
});

app.post('/api/config', (req, res) => {
  const b = req.body ?? {};
  const str = (v, d = '') => (typeof v === 'string' ? v.trim() : d);
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  config = {
    ...config,
    sourceGroup: str(b.sourceGroup),
    targetGroup: str(b.targetGroup),
    shopeeAppId: str(b.shopeeAppId),
    shopeeSecret: b.shopeeSecret === '********' ? config.shopeeSecret : str(b.shopeeSecret),
    shopeeSubId: str(b.shopeeSubId, 'clone') || 'clone',
    mlParams: str(b.mlParams),
    allowOtherLinks: Boolean(b.allowOtherLinks),
    minDelay: num(b.minDelay, config.minDelay),
    maxDelay: num(b.maxDelay, config.maxDelay),
  };
  saveConfig();
  addLog('Configuração salva');
  res.json({ ok: true });
});

app.post('/api/refresh-groups', async (req, res) => {
  try {
    if (sock && state.status === 'conectado') await loadGroups(sock);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/logout', async (req, res) => {
  const s = sock;
  res.json({ ok: true });
  try {
    await s.logout();
  } catch {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    s.end(new Error('reset'));
  }
});

app.listen(PORT, '0.0.0.0', () => addLog('Painel rodando na porta ' + PORT));

start().catch((e) => addLog('Erro ao iniciar: ' + String(e)));
