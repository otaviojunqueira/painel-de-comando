'use strict';
/*
 * Painel de Comando: serviço local.
 * - Escuta só em 127.0.0.1.
 * - Exige a chave de acesso (cookie) e confere Host e Origin, para que nenhum site aberto no navegador consiga mandar comandos.
 * - Mantém os terminais (node-pty) vivos mesmo que a janela seja fechada.
 * - Guarda projetos, ações, senhas e anotações em ~/.config/painel/painel.json (permissão 600).
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const PORT = Number(process.env.PAINEL_PORT) || 4777;
const CFG = process.env.PAINEL_HOME || path.join(os.homedir(), '.config', 'painel');
const DATA_FILE = path.join(CFG, 'painel.json');
const TOKEN_FILE = path.join(CFG, 'token');
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const NM = path.join(ROOT, 'node_modules');
const SHIM_DIR = path.join(ROOT, 'bin', 'shim');
const VENDOR = {
  '/vendor/xterm.js': path.join(NM, '@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': path.join(NM, '@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.js': path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'),
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

/* ---------- arquivos de configuração ---------- */
fs.mkdirSync(CFG, { recursive: true, mode: 0o700 });
try { fs.chmodSync(CFG, 0o700); } catch (_) {}

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch (_) {}
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
function mkId(raw, seen, prefix) {
  let id = str(raw, 64).replace(/[^\w-]/g, '');
  if (!id || seen.has(id)) id = prefix + crypto.randomBytes(4).toString('hex');
  seen.add(id);
  return id;
}
const list = (v, max, fn, prefix) => {
  const seen = new Set();
  return (Array.isArray(v) ? v : []).slice(0, max).filter((x) => x && typeof x === 'object').map((x) => fn(x, (raw) => mkId(raw, seen, prefix)));
};
function normalize(d) {
  const seen = new Set();
  const projetos = (Array.isArray(d && d.projetos) ? d.projetos : []).slice(0, 100).filter((p) => p && typeof p === 'object').map((p) => ({
    id: mkId(p.id, seen, 'p'),
    nome: str(p.nome, 100) || 'Projeto',
    pasta: str(p.pasta, 500) || '~',
    acoes: list(p.acoes, 100, (a, id) => ({
      id: id(a.id),
      rotulo: str(a.rotulo, 100) || 'Ação',
      cmd: str(a.cmd, 4000),
      tipo: a.tipo === 'unica' ? 'unica' : 'continua',
      ambiente: a.ambiente === 'homologacao' || a.ambiente === 'producao' ? a.ambiente : '',
      destino: str(a.destino, 200),
    }), 'a'),
    conexoes: list(p.conexoes, 50, (c, id) => ({ id: id(c.id), rotulo: str(c.rotulo, 100) || 'Conexão', cmd: str(c.cmd, 1000), ambiente: c.ambiente === 'homologacao' || c.ambiente === 'producao' ? c.ambiente : '' }), 'c'),
    info: list(p.info, 500, (i, id) => ({
      id: id(i.id),
      rotulo: str(i.rotulo, 100) || 'Sem nome',
      valor: str(i.valor, 4000),
      tipo: ['link', 'segredo', 'usuario'].includes(i.tipo) ? i.tipo : 'texto',
      senha: i.tipo === 'usuario' ? str(i.senha, 4000) : '',
    }), 'i'),
    notas: str(p.notas, 50000),
  }));
  return { versao: 1, projetos };
}
function seed() {
  const echo = (m) => `echo "${m}"`;
  return normalize({
    projetos: [{
      id: 'indica', nome: 'Sistema Indica', pasta: '~/projetos/indica-monorepo',
      acoes: [
        { id: 'dev', rotulo: 'Rodar ambiente local', tipo: 'continua', cmd: echo('Edite esta ação (botão ✎) e informe o comando que sobe o backend e o frontend.') },
        { id: 'hml', rotulo: 'Subir build para homologação', tipo: 'unica', ambiente: 'homologacao', destino: 'homologação', cmd: echo('Edite esta ação (botão ✎) e informe o comando que gera e sobe o build para HOMOLOGAÇÃO.') },
        { id: 'prod', rotulo: 'Subir build para produção', tipo: 'unica', ambiente: 'producao', destino: 'produção', cmd: echo('Edite esta ação (botão ✎) e informe o comando que gera e sobe o build para PRODUÇÃO.') },
      ],
      conexoes: [{ id: 'srv', rotulo: 'Servidor (SSH)', cmd: echo('Edite esta conexão (botão ✎) e informe o comando, por exemplo: ssh usuario@servidor') }],
      info: [], notas: '',
    }],
  });
}
let data;
function loadData() {
  try {
    return normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      const aside = DATA_FILE + '.corrompido-' + Date.now();
      try { fs.renameSync(DATA_FILE, aside); console.error('painel.json ilegível; guardei uma cópia em ' + aside); } catch (_) {}
    }
    const d = seed();
    saveData(d);
    return d;
  }
}
function saveData(d) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch (_) {}
  fs.renameSync(tmp, DATA_FILE);
  try { fs.chmodSync(DATA_FILE, 0o600); } catch (_) {}
}
data = loadData();

/* ---------- segurança ---------- */
function cookieOf(req) {
  const m = /(?:^|;\s*)painel_token=([0-9a-f]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
}
function tokenOk(t) {
  const a = Buffer.from(String(t || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const hostOk = (req) => HOSTS.has(req.headers.host || '');

/* ---------- sessões de terminal ---------- */
const sessions = new Map();
const BUF_MAX = 400000;
const expand = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const pub = (s) => ({ id: s.id, projeto: s.projeto, tipo: s.tipo, ref: s.ref, titulo: s.titulo, cmd: s.cmd, status: s.status, code: s.code, parada: s.parada, inicio: s.inicio, fim: s.fim, pai: s.pai });

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(raw);
}
function killGroup(s, sig) {
  try { process.kill(-s.pty.pid, sig); } catch (_) { try { s.pty.kill(sig); } catch (_) {} }
}
const arquivos = require('./arquivos')({
  broadcast,
  cfgDir: CFG,
  achar: (pid, cid) => {
    const p = data && data.projetos.find((x) => x.id === pid);
    const c = p && p.conexoes.find((x) => x.id === cid);
    return c ? { p, c } : null;
  },
});
const filhos = (id) => [...sessions.values()].filter((x) => x.pai === id);
function removeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  for (const c of filhos(id)) {
    c.pai = null;
    if (c.status === 'rodando') broadcast({ t: 'sessao', s: pub(c) });
    else removeSession(c.id);
  }
  if (s.status === 'rodando') { s.removida = true; killGroup(s, 'SIGHUP'); }
  sessions.delete(id);
  broadcast({ t: 'removida', id });
}
let abaSeq = 0;
/* Cria uma sessão de terminal. cmd vazio = shell interativo. */
function spawnSession(o) {
  const id = 's' + crypto.randomBytes(4).toString('hex');
  const key = crypto.randomBytes(16).toString('hex');
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color', COLORTERM: 'truecolor',
    PAINEL_SESSAO_ID: id, PAINEL_SESSAO_KEY: key, PAINEL_PORTA: String(PORT), PAINEL_NODE: process.execPath,
    PATH: SHIM_DIR + path.delimiter + (process.env.PATH || ''),
  });
  delete env.ELECTRON_RUN_AS_NODE;
  let term;
  try {
    term = pty.spawn('/bin/bash', o.cmd ? ['-lic', o.cmd] : ['-li'], { name: 'xterm-256color', cols: 120, rows: 32, cwd: o.cwd, env });
  } catch (e) {
    return { erro: 'Não consegui iniciar o terminal: ' + e.message };
  }
  const s = { id, key, cwd: o.cwd, projeto: o.projeto, tipo: o.tipo, ref: o.ref, titulo: o.titulo, cmd: o.cmd || '', status: 'rodando', code: null, parada: false, inicio: Date.now(), fim: null, pai: o.pai || null, pty: term, buf: '' };
  sessions.set(id, s);
  term.onData((d) => {
    s.buf += d;
    if (s.buf.length > BUF_MAX) s.buf = s.buf.slice(-Math.floor(BUF_MAX * 0.75));
    broadcast({ t: 'dado', id, d });
  });
  term.onExit((e) => {
    if (s.removida) return;
    s.status = 'encerrado';
    s.code = e.exitCode;
    s.fim = Date.now();
    broadcast({ t: 'sessao', s: pub(s) });
  });
  broadcast({ t: 'sessao', s: pub(s) });
  return { id };
}
function pastaDe(p) {
  const cwd = expand(p.pasta);
  return fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : null;
}
function runSession(projetoId, tipo, refId) {
  const p = data.projetos.find((x) => x.id === projetoId);
  if (!p) return { erro: 'Não encontrei esse projeto.' };
  const item = (tipo === 'acao' ? p.acoes : p.conexoes).find((x) => x.id === refId);
  if (!item) return { erro: 'Não encontrei essa ' + (tipo === 'acao' ? 'ação' : 'conexão') + '.' };
  if (!item.cmd.trim()) return { erro: 'Esta ' + (tipo === 'acao' ? 'ação' : 'conexão') + ' não tem comando. Edite e informe o comando.' };
  const cwd = pastaDe(p);
  if (!cwd) return { erro: 'A pasta ' + p.pasta + ' não existe. Corrija a pasta do projeto.' };
  for (const s of [...sessions.values()]) {
    if (s.projeto === p.id && s.tipo === tipo && s.ref === item.id) {
      if (s.status === 'rodando') return { id: s.id, jaRodando: true };
      removeSession(s.id);
    }
  }
  return spawnSession({ projeto: p.id, tipo, ref: item.id, titulo: item.rotulo, cmd: item.cmd, cwd });
}
function novoTerminal(projetoId) {
  const p = data.projetos.find((x) => x.id === projetoId);
  if (!p) return { erro: 'Não encontrei esse projeto.' };
  const cwd = pastaDe(p);
  if (!cwd) return { erro: 'A pasta ' + p.pasta + ' não existe. Corrija a pasta do projeto.' };
  abaSeq += 1;
  return spawnSession({ projeto: p.id, tipo: 'aba', ref: 'aba-' + crypto.randomBytes(3).toString('hex'), titulo: 'Terminal ' + abaSeq, cmd: '', cwd });
}
function pararUma(s) {
  if (s.status !== 'rodando') return;
  s.parada = true;
  killGroup(s, 'SIGINT');
  setTimeout(() => { if (s.status === 'rodando') killGroup(s, 'SIGTERM'); }, 4000);
  setTimeout(() => { if (s.status === 'rodando') killGroup(s, 'SIGKILL'); }, 9000);
}
function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  filhos(id).forEach(pararUma);
  pararUma(s);
}

/* ---------- WebSocket ---------- */
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'init', sessoes: [...sessions.values()].map(pub) }));
  for (const s of sessions.values()) ws.send(JSON.stringify({ t: 'hist', id: s.id, d: s.buf }));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'fs') arquivos.handle(ws, m);
    else if (m.t === 'rodar') {
      const r = runSession(String(m.projeto), m.tipo === 'conexao' ? 'conexao' : 'acao', String(m.ref));
      if (r.erro) ws.send(JSON.stringify({ t: 'erro', msg: r.erro }));
    } else if (m.t === 'novo-terminal') {
      const r = novoTerminal(String(m.projeto));
      if (r.erro) ws.send(JSON.stringify({ t: 'erro', msg: r.erro }));
    } else if (m.t === 'parar') stopSession(String(m.id));
    else if (m.t === 'entrada') {
      const s = sessions.get(String(m.id));
      if (s && s.status === 'rodando' && typeof m.d === 'string') s.pty.write(m.d);
    } else if (m.t === 'tamanho') {
      const s = sessions.get(String(m.id));
      const cols = Math.max(20, Math.min(500, m.cols | 0)), rows = Math.max(5, Math.min(200, m.rows | 0));
      if (s && s.status === 'rodando') { try { s.pty.resize(cols, rows); } catch (_) {} }
    } else if (m.t === 'fechar') removeSession(String(m.id));
  });
});

/* ---------- HTTP ---------- */
const CSP = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
function headers(extra) {
  return Object.assign({ 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }, extra);
}
function send(res, code, body, type, extra) {
  res.writeHead(code, headers(Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8' }, extra)));
  res.end(body);
}
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Não encontrado');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const NEGADO = '<!doctype html><meta charset="utf-8"><title>Painel de Comando</title><body style="font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem"><h1>Acesso negado</h1><p>Abra o painel pelo ícone <b>Painel de Comando</b> (ou rodando <code>bin/painel</code>). Ele leva a chave de acesso junto.</p>';

/* O comando gnome-terminal dentro das ações do painel vira abas do próprio painel (bin/shim/gnome-terminal). */
async function abrirAbasDoShim(req, res) {
  const nao = () => send(res, 403, JSON.stringify({ erro: 'Negado' }), MIME['.json']);
  if (req.headers['x-painel-shim'] !== '1' || req.headers.origin) return nao();
  try {
    const b = JSON.parse(await readBody(req, 65536));
    const par = sessions.get(String(b.id));
    const k = Buffer.from(String(b.key || ''));
    if (!par || par.status !== 'rodando' || k.length !== Buffer.byteLength(par.key) || !crypto.timingSafeEqual(k, Buffer.from(par.key))) return nao();
    const raiz = par.pai || par.id;
    const abas = (Array.isArray(b.abas) ? b.abas : []).slice(0, 10);
    for (const a of abas) {
      const dir = typeof a.cwd === 'string' && a.cwd ? expand(a.cwd) : par.cwd;
      const cwd = fs.existsSync(dir) ? dir : par.cwd;
      spawnSession({ projeto: par.projeto, tipo: 'aba', ref: 'aba-' + crypto.randomBytes(3).toString('hex'), titulo: str(a.titulo, 100) || 'Terminal', cmd: str(a.cmd, 8000), cwd, pai: raiz });
    }
    return send(res, 200, JSON.stringify({ ok: true, abas: abas.length }), MIME['.json']);
  } catch (_) {
    return send(res, 400, JSON.stringify({ erro: 'Pedido inválido' }), MIME['.json']);
  }
}

const server = http.createServer(async (req, res) => {
  if (!hostOk(req)) return send(res, 403, 'Host não permitido');
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/' && url.searchParams.has('t')) {
    if (!tokenOk(url.searchParams.get('t'))) return send(res, 401, NEGADO, 'text/html; charset=utf-8');
    return send(res, 302, '', 'text/plain', { Location: '/', 'Set-Cookie': `painel_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
  }
  if (url.pathname === '/api/shim' && req.method === 'POST') return abrirAbasDoShim(req, res);
  if (!tokenOk(cookieOf(req))) return send(res, 401, NEGADO, 'text/html; charset=utf-8');

  if (url.pathname === '/api/dados') {
    if (req.headers['x-painel'] !== '1') return send(res, 403, 'Cabeçalho ausente');
    if (req.method === 'GET') return send(res, 200, JSON.stringify(data), MIME['.json']);
    if (req.method === 'PUT') {
      try {
        data = normalize(JSON.parse(await readBody(req, 4 * 1024 * 1024)));
        saveData(data);
        return send(res, 200, JSON.stringify(data), MIME['.json']);
      } catch (e) {
        return send(res, 400, JSON.stringify({ erro: 'Dados inválidos' }), MIME['.json']);
      }
    }
    return send(res, 405, 'Método não permitido');
  }
  if (req.method !== 'GET') return send(res, 405, 'Método não permitido');
  if (VENDOR[url.pathname]) return serveFile(res, VENDOR[url.pathname]);
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Negado');
  serveFile(res, file);
});
server.on('upgrade', (req, socket, head) => {
  const ok = hostOk(req) && ORIGINS.has(req.headers.origin || '') && tokenOk(cookieOf(req)) && req.url === '/ws';
  if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `A porta ${PORT} já está em uso. O painel já está rodando?` : e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Painel de Comando em http://127.0.0.1:${PORT}  (dados em ${CFG})`));

function sair() {
  try { arquivos.fechar(); } catch (_) {}
  for (const s of sessions.values()) if (s.status === 'rodando') killGroup(s, 'SIGHUP');
  process.exit(0);
}
process.on('SIGTERM', sair);
process.on('SIGINT', sair);
