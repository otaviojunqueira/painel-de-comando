'use strict';
/*
 * Gerenciador de arquivos (SFTP) do Painel de Comando.
 * - Reaproveita a conexão SSH cadastrada no projeto: lê o comando (ssh usuario@host -p 22 -i chave) e resolve com `ssh -G`.
 * - Confere a chave do servidor no known_hosts do usuário (ssh-keygen -F). Servidor novo pede confirmação; chave diferente é recusada.
 * - Senhas e frases das chaves ficam só na memória do serviço, nunca em disco.
 * - Transferências em fila (2 por vez), com progresso, cancelamento e sem sobrescrever sem permissão.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Client, utils } = require('ssh2');

class Erro extends Error {
  constructor(msg, codigo, extra) { super(msg); this.codigo = codigo || 'erro'; this.extra = extra || null; }
}
class Cancelado extends Error {}

const home = os.homedir();
const posix = path.posix;
const OPT_COM_VALOR = new Set('bcDEeFIiJLlmOopQRSWw'.split(''));

/* ---------- mensagens de erro em português ---------- */
function amigavel(e) {
  if (e instanceof Erro) return e;
  const c = e && (e.code !== undefined ? e.code : e.errno);
  const msg = {
    ENOENT: 'Não encontrei esse caminho.', EACCES: 'Sem permissão para acessar isso.', EPERM: 'Operação não permitida.',
    EEXIST: 'Já existe um item com esse nome.', ENOTEMPTY: 'A pasta não está vazia.', ENOTDIR: 'Isso não é uma pasta.', EISDIR: 'Isso é uma pasta.',
    ENOSPC: 'Sem espaço no disco.', ECONNREFUSED: 'O servidor recusou a conexão. Confira host e porta.', ENOTFOUND: 'Não encontrei o endereço do servidor.',
    ETIMEDOUT: 'O servidor não respondeu a tempo.', ECONNRESET: 'A conexão foi interrompida.', EHOSTUNREACH: 'Não consegui alcançar o servidor.',
    2: 'Não encontrei esse caminho no servidor.', 3: 'O servidor negou a permissão para isso.', 4: 'O servidor recusou a operação (o item pode já existir ou estar em uso).',
  }[c];
  return new Erro(msg || (e && e.message) || 'Algo deu errado.', 'erro');
}

/* ---------- leitura do comando SSH ---------- */
function tokens(str) {
  const out = []; let cur = '', q = null, tem = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"' && i + 1 < str.length) cur += str[++i]; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; tem = true; }
    else if (ch === '\\' && i + 1 < str.length) { cur += str[++i]; tem = true; }
    else if (/\s/.test(ch)) { if (tem || cur) out.push(cur); cur = ''; tem = false; }
    else if (ch === ';' || ch === '&' || ch === '|') { if (tem || cur) out.push(cur); cur = ''; tem = false; if (str[i + 1] === ch) i++; out.push('\u0000SEP'); }
    else { cur += ch; tem = true; }
  }
  if (tem || cur) out.push(cur);
  return out;
}
function argsSsh(cmd) {
  const toks = tokens(cmd);
  const segs = []; let seg = [];
  for (const t of toks) { if (t === '\u0000SEP') { if (seg.length) segs.push(seg); seg = []; } else seg.push(t); }
  if (seg.length) segs.push(seg);
  for (const s of segs) {
    let i = 0;
    while (i < s.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(s[i])) i++;
    if (s[i] && path.basename(s[i]) === 'ssh') {
      const opts = []; let j = i + 1, destino = null;
      for (; j < s.length; j++) {
        const t = s[j];
        if (t.startsWith('-') && t.length > 1) {
          opts.push(t);
          if (t.length === 2 && OPT_COM_VALOR.has(t[1]) && j + 1 < s.length) opts.push(s[++j]);
        } else { destino = t; break; }
      }
      if (destino) return { opts, destino };
    }
  }
  return null;
}
const expandir = (p) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
function sshG(a) {
  return new Promise((resolve) => {
    execFile('ssh', ['-G', ...a.opts, a.destino], { timeout: 8000 }, (err, out) => {
      if (err) return resolve(null);
      const r = { identityfile: [] };
      for (const l of String(out).split('\n')) {
        const i = l.indexOf(' '); if (i < 0) continue;
        const k = l.slice(0, i).toLowerCase(), v = l.slice(i + 1).trim();
        if (k === 'identityfile') r.identityfile.push(v); else r[k] = v;
      }
      resolve(r);
    });
  });
}
async function resolverSsh(cmd) {
  const a = argsSsh(cmd);
  if (!a) throw new Erro('Não achei um comando “ssh usuario@servidor” nesta conexão. Edite a conexão e confira o comando.', 'cmd');
  let host, user, port, ids = [];
  const g = await sshG(a);
  if (g && g.hostname) {
    if ((g.proxyjump && g.proxyjump !== 'none') || (g.proxycommand && g.proxycommand !== 'none')) throw new Erro('Conexões com ProxyJump ou ProxyCommand ainda não são suportadas no gerenciador de arquivos.', 'cmd');
    host = g.hostname; user = g.user; port = Number(g.port) || 22; ids = g.identityfile.map(expandir);
  } else {
    let d = a.destino; user = null; port = 22;
    const at = d.lastIndexOf('@'); if (at >= 0) { user = d.slice(0, at); d = d.slice(at + 1); }
    host = d;
    for (let i = 0; i < a.opts.length; i++) {
      const o = a.opts[i];
      if (o === '-p') port = Number(a.opts[++i]) || 22;
      else if (o === '-l') user = a.opts[++i];
      else if (o === '-i') ids.push(expandir(a.opts[++i]));
    }
    if (!user) user = os.userInfo().username;
    for (const n of ['id_ed25519', 'id_ecdsa', 'id_rsa']) ids.push(path.join(home, '.ssh', n));
  }
  return { host, port, user, ids };
}

/* ---------- chave do servidor ---------- */
const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');
function conhecidos(host, port) {
  return new Promise((resolve) => {
    const alvo = port === 22 ? host : '[' + host + ']:' + port;
    execFile('ssh-keygen', ['-F', alvo, '-l'], { timeout: 5000 }, (err, out) => {
      resolve((String(out || '').match(/SHA256:[A-Za-z0-9+/]+/g) || []).map((x) => x.slice(7)));
    });
  });
}

module.exports = function criarArquivos({ broadcast, achar, cfgDir }) {
  const conns = new Map();
  const jobs = new Map();
  const fila = [];
  let ativos = 0, timer = null;
  const MAX = 2;
  const STORE = path.join(cfgDir, 'known_hosts.json');
  const chave = (m) => String(m.projeto) + ':' + String(m.conexao);

  function lerStore() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')) || {}; } catch (_) { return {}; } }
  function gravarStore(o) { try { fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(STORE, JSON.stringify(o, null, 1), { mode: 0o600 }); } catch (_) {} }

  const sp = (sftp, fn, ...a) => new Promise((res, rej) => sftp[fn](...a, (e, r) => (e ? rej(e) : res(r))));
  const ehDir = (mode) => (mode & 0o170000) === 0o040000;
  const ehLink = (mode) => (mode & 0o170000) === 0o120000;
  function permStr(mode) {
    const t = ehDir(mode) ? 'd' : ehLink(mode) ? 'l' : '-';
    const b = 'rwxrwxrwx';
    let s = t;
    for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? b[i] : '-';
    return s;
  }
  function pegar(m) {
    const c = conns.get(chave(m));
    if (!c || !c.ok) throw new Erro('Não conectado ao servidor.', 'desconectado');
    return c;
  }

  /* ---------- conexão ---------- */
  async function conectar(m) {
    const k = chave(m), ex = conns.get(k);
    if (ex && ex.ok) return { cwd: ex.cwd, host: ex.host, usuario: ex.user };
    const f = achar(String(m.projeto), String(m.conexao));
    if (!f) throw new Erro('Conexão não encontrada.', 'cmd');
    const alvo = await resolverSsh(f.c.cmd);

    const reais = [], protegidas = [];
    for (const arq of alvo.ids) {
      let buf; try { buf = await fsp.readFile(arq); } catch (_) { continue; }
      const frase = m.frase ? String(m.frase) : undefined;
      const r = utils.parseKey(buf, frase);
      const kk = Array.isArray(r) ? r[0] : r;
      if (kk instanceof Error) { if (/passphrase/i.test(kk.message)) protegidas.push(arq); continue; }
      reais.push({ type: 'publickey', username: alvo.user, key: buf, passphrase: frase });
    }
    const metodos = [];
    if (process.env.SSH_AUTH_SOCK) metodos.push({ type: 'agent', username: alvo.user, agent: process.env.SSH_AUTH_SOCK });
    metodos.push(...reais);
    if (m.senha) {
      metodos.push({ type: 'password', username: alvo.user, password: String(m.senha) });
      metodos.push({ type: 'keyboard-interactive', username: alvo.user, prompt: (n, i, l, prompts, fin) => fin(prompts.map(() => String(m.senha))) });
    }

    let hostErro = null, impressao = null;
    const store = lerStore();
    const storeKey = alvo.host + ':' + alvo.port;
    const client = new Client();
    const sftp = await new Promise((resolve, reject) => {
      let feito = false;
      const falha = (e) => { if (!feito) { feito = true; try { client.end(); } catch (_) {} reject(e); } };
      client.on('error', (e) => {
        if (hostErro) return falha(hostErro);
        if (e && e.level === 'client-authentication') {
          if (m.senha) return falha(new Erro('Usuário ou senha incorretos.', 'senha', { rotulo: 'Senha de ' + alvo.user + '@' + alvo.host }));
          if (protegidas.length && !m.frase) return falha(new Erro('A chave SSH tem senha.', 'frase', { rotulo: 'Senha da chave SSH' }));
          return falha(new Erro('O servidor pediu senha.', 'senha', { rotulo: 'Senha de ' + alvo.user + '@' + alvo.host }));
        }
        if (e && e.level === 'client-timeout') return falha(new Erro('O servidor não respondeu a tempo.', 'erro'));
        falha(amigavel(e));
      });
      client.on('close', () => falha(new Erro('A conexão foi encerrada pelo servidor.', 'erro')));
      client.on('ready', () => {
        client.sftp((e, s) => (e ? falha(new Erro('O servidor não oferece SFTP para este usuário.', 'erro')) : (feito = true, resolve(s))));
      });
      client.connect({
        host: alvo.host, port: alvo.port, username: alvo.user, readyTimeout: 15000, keepaliveInterval: 15000, keepaliveCountMax: 4,
        hostHash: 'sha256',
        hostVerifier: (hex, cb) => {
          impressao = 'SHA256:' + b64(hex);
          conhecidos(alvo.host, alvo.port).then((lista) => {
            const mine = lista.length ? [] : (store[storeKey] || []);
            const sabe = lista.length || mine.length;
            if (lista.includes(b64(hex)) || mine.includes(b64(hex))) return cb(true);
            if (sabe) { hostErro = new Erro('A chave do servidor mudou. Por segurança não conectei. Se o servidor foi reinstalado, remova a linha antiga do ~/.ssh/known_hosts (ssh-keygen -R ' + alvo.host + ') e tente de novo.', 'host-mudou'); return cb(false); }
            if (m.confiar && m.confiar === impressao) { store[storeKey] = [b64(hex)]; gravarStore(store); return cb(true); }
            hostErro = new Erro('Primeira conexão com este servidor.', 'host-novo', { impressao, host: alvo.host });
            cb(false);
          });
        },
        authHandler: (restam, parcial, cb) => cb(metodos.shift() || false),
      });
    });

    const cwd = await sp(sftp, 'realpath', '.').catch(() => '/');
    const c = { client, sftp, ok: true, cwd, host: alvo.host, user: alvo.user, projeto: String(m.projeto), conexao: String(m.conexao) };
    conns.set(k, c);
    client.on('close', () => {
      if (conns.get(k) === c) { c.ok = false; conns.delete(k); broadcast({ t: 'fs-estado', projeto: c.projeto, conexao: c.conexao, conectado: false }); }
    });
    client.on('error', () => {});
    broadcast({ t: 'fs-estado', projeto: c.projeto, conexao: c.conexao, conectado: true, host: c.host, usuario: c.user });
    return { cwd, host: c.host, usuario: c.user };
  }
  function desconectar(m) {
    const c = conns.get(chave(m));
    if (c) { try { c.client.end(); } catch (_) {} conns.delete(chave(m)); broadcast({ t: 'fs-estado', projeto: c.projeto, conexao: c.conexao, conectado: false }); }
    return {};
  }

  /* ---------- listagem ---------- */
  const loc = (p) => path.resolve(expandir(String(p || '~')));
  async function listar(m) {
    if (m.lado === 'local') {
      const dir = loc(m.caminho);
      const nomes = await fsp.readdir(dir);
      const itens = [];
      await Promise.all(nomes.slice(0, 5000).map(async (nome) => {
        try {
          const l = await fsp.lstat(path.join(dir, nome));
          let st = l;
          if (l.isSymbolicLink()) { try { st = await fsp.stat(path.join(dir, nome)); } catch (_) { /* link quebrado */ } }
          itens.push({ nome, tipo: st.isDirectory() ? 'dir' : 'arq', link: l.isSymbolicLink(), tam: st.isDirectory() ? 0 : st.size, mod: st.mtimeMs, perm: permStr(st.mode) });
        } catch (_) {}
      }));
      return { caminho: dir, itens };
    }
    const c = pegar(m);
    let dir = String(m.caminho || '~');
    dir = dir === '~' ? c.cwd : dir.startsWith('~/') ? posix.join(c.cwd, dir.slice(2)) : dir;
    dir = await sp(c.sftp, 'realpath', dir);
    const lista = await sp(c.sftp, 'readdir', dir);
    const itens = await Promise.all(lista.slice(0, 5000).map(async (e) => {
      const mode = e.attrs.mode; let dirOk = ehDir(mode), link = ehLink(mode);
      if (link) { try { dirOk = ehDir((await sp(c.sftp, 'stat', posix.join(dir, e.filename))).mode); } catch (_) {} }
      const t = String(e.longname || '').split(/\s+/);
      return { nome: e.filename, tipo: dirOk ? 'dir' : 'arq', link, tam: dirOk ? 0 : e.attrs.size, mod: e.attrs.mtime * 1000, perm: permStr(mode), dono: t[2] ? t[2] + ' ' + (t[3] || '') : '' };
    }));
    return { caminho: dir, itens: itens.filter((i) => i.nome !== '.' && i.nome !== '..') };
  }

  /* ---------- criar, renomear, apagar ---------- */
  async function existe(m) {
    const nomes = (Array.isArray(m.caminhos) ? m.caminhos : []).map(String).slice(0, 2000);
    const achados = [];
    if (m.lado === 'local') {
      for (const p of nomes) { try { await fsp.lstat(loc(p)); achados.push(p); } catch (_) {} }
    } else {
      const c = pegar(m);
      for (const p of nomes) { try { await sp(c.sftp, 'lstat', p); achados.push(p); } catch (_) {} }
    }
    return { existentes: achados };
  }
  async function mkdir(m) {
    const nome = String(m.caminho || '');
    if (m.lado === 'local') await fsp.mkdir(loc(nome));
    else await sp(pegar(m).sftp, 'mkdir', nome);
    return {};
  }
  async function renomear(m) {
    if (m.lado === 'local') {
      const de = loc(m.de), para = loc(m.para);
      try { await fsp.lstat(para); throw new Erro('Já existe um item com esse nome.'); } catch (e) { if (e instanceof Erro) throw e; }
      await fsp.rename(de, para);
    } else {
      const c = pegar(m);
      try { await sp(c.sftp, 'lstat', String(m.para)); throw new Erro('Já existe um item com esse nome.'); } catch (e) { if (e instanceof Erro) throw e; }
      await sp(c.sftp, 'rename', String(m.de), String(m.para));
    }
    return {};
  }
  async function rmRemoto(sftp, p) {
    const st = await sp(sftp, 'lstat', p);
    if (ehDir(st.mode)) {
      for (const e of await sp(sftp, 'readdir', p)) await rmRemoto(sftp, posix.join(p, e.filename));
      await sp(sftp, 'rmdir', p);
    } else await sp(sftp, 'unlink', p);
  }
  async function apagar(m) {
    const alvos = (Array.isArray(m.caminhos) ? m.caminhos : []).map(String).slice(0, 500);
    if (!alvos.length) return {};
    if (m.lado === 'local') {
      for (const a of alvos) {
        const p = loc(a);
        if (p === '/' || p === home || path.dirname(p) === '/' ) throw new Erro('Por segurança, não apago esta pasta pelo painel: ' + p);
        await fsp.rm(p, { recursive: true, force: false });
      }
    } else {
      const c = pegar(m);
      for (const a of alvos) {
        const p = posix.normalize(a);
        if (p === '/' || p === '.' || p === c.cwd || posix.dirname(p) === '/') throw new Erro('Por segurança, não apago esta pasta pelo painel: ' + p);
        await rmRemoto(c.sftp, p);
      }
    }
    return {};
  }

  /* ---------- transferências ---------- */
  const pubJob = (j) => ({ id: j.id, projeto: j.projeto, conexao: j.conexao, direcao: j.direcao, nome: j.nome, total: j.total, feito: j.feito, status: j.status, erro: j.erro, fim: j.fim });
  function tick(j) { j.sujo = true; if (!timer) timer = setInterval(emitir, 250); }
  function emitir() {
    let alguem = false;
    for (const j of jobs.values()) if (j.sujo) { j.sujo = false; alguem = true; broadcast({ t: 'fs-job', job: pubJob(j) }); }
    if (!alguem && !ativos && timer) { clearInterval(timer); timer = null; }
  }
  function pipe(j, rs, ws) {
    return new Promise((resolve, reject) => {
      j.streams.add(rs); j.streams.add(ws);
      j.abort = () => { reject(new Cancelado()); };
      rs.on('data', (ch) => { j.feito += ch.length; tick(j); });
      rs.on('error', (e) => { ws.destroy(); reject(e); });
      ws.on('error', (e) => { rs.destroy(); reject(e); });
      ws.on('close', () => resolve());
      rs.pipe(ws);
    }).finally(() => { j.streams.delete(rs); j.streams.delete(ws); j.abort = null; });
  }
  async function tamanhoLocal(p) {
    const st = await fsp.stat(p);
    if (!st.isDirectory()) return st.size;
    let t = 0;
    for (const n of await fsp.readdir(p)) { try { t += await tamanhoLocal(path.join(p, n)); } catch (_) {} }
    return t;
  }
  async function tamanhoRemoto(sftp, p) {
    const st = await sp(sftp, 'stat', p);
    if (!ehDir(st.mode)) return st.size;
    let t = 0;
    for (const e of await sp(sftp, 'readdir', p)) { try { t += await tamanhoRemoto(sftp, posix.join(p, e.filename)); } catch (_) {} }
    return t;
  }
  const flags = (j) => (j.sobrescrever ? 'w' : 'wx');
  async function enviar(j, sftp, local, remoto) {
    if (j.cancel) throw new Cancelado();
    const st = await fsp.stat(local);
    if (st.isDirectory()) {
      let ja = false; try { ja = ehDir((await sp(sftp, 'stat', remoto)).mode); } catch (_) {}
      if (!ja) await sp(sftp, 'mkdir', remoto, { mode: st.mode & 0o777 });
      for (const n of await fsp.readdir(local)) await enviar(j, sftp, path.join(local, n), posix.join(remoto, n));
      return;
    }
    const ws = sftp.createWriteStream(remoto, { flags: flags(j), mode: st.mode & 0o777 });
    let criado = false; ws.on('open', () => { criado = true; });
    try { await pipe(j, fs.createReadStream(local), ws); }
    catch (e) { if (criado) { try { await sp(sftp, 'unlink', remoto); } catch (_) {} } throw e; }
    if (j.sobrescrever) { try { await sp(sftp, 'chmod', remoto, st.mode & 0o777); } catch (_) {} }
  }
  async function baixar(j, sftp, remoto, local) {
    if (j.cancel) throw new Cancelado();
    const st = await sp(sftp, 'stat', remoto);
    if (ehDir(st.mode)) {
      await fsp.mkdir(local, { recursive: true });
      for (const e of await sp(sftp, 'readdir', remoto)) await baixar(j, sftp, posix.join(remoto, e.filename), path.join(local, e.filename));
      return;
    }
    const ws = fs.createWriteStream(local, { flags: flags(j) });
    let criado = false; ws.on('open', () => { criado = true; });
    try { await pipe(j, sftp.createReadStream(remoto), ws); }
    catch (e) { if (criado) { try { await fsp.unlink(local); } catch (_) {} } throw e; }
    try { await fsp.chmod(local, st.mode & 0o777); } catch (_) {}
  }
  async function executar(j) {
    j.status = 'andando'; tick(j);
    try {
      const c = conns.get(j.projeto + ':' + j.conexao);
      if (!c || !c.ok) throw new Erro('Não conectado ao servidor.');
      if (j.direcao === 'enviar') { j.total = await tamanhoLocal(j.origem); tick(j); await enviar(j, c.sftp, j.origem, j.destino); }
      else { j.total = await tamanhoRemoto(c.sftp, j.origem); tick(j); await baixar(j, c.sftp, j.origem, j.destino); }
      j.status = 'ok'; j.feito = j.total;
    } catch (e) {
      if (e instanceof Cancelado || j.cancel) { j.status = 'cancelado'; }
      else { j.status = 'erro'; j.erro = amigavel(e).message; }
    }
    j.fim = Date.now();
    broadcast({ t: 'fs-job', job: pubJob(j) });
  }
  function andar() {
    while (ativos < MAX && fila.length) {
      const j = fila.shift();
      if (j.cancel) { j.status = 'cancelado'; j.fim = Date.now(); broadcast({ t: 'fs-job', job: pubJob(j) }); continue; }
      ativos++;
      executar(j).finally(() => { ativos--; andar(); });
    }
  }
  function transferir(m) {
    pegar(m);
    const dir = m.direcao === 'baixar' ? 'baixar' : 'enviar';
    const itens = (Array.isArray(m.itens) ? m.itens : []).slice(0, 500);
    const criados = [];
    for (const it of itens) {
      const origem = String(it.origem), destino = String(it.destino);
      const j = {
        id: crypto.randomBytes(5).toString('hex'), projeto: String(m.projeto), conexao: String(m.conexao), direcao: dir,
        nome: (dir === 'enviar' ? path.basename(origem) : posix.basename(origem)),
        origem: dir === 'enviar' ? loc(origem) : origem, destino: dir === 'enviar' ? destino : loc(destino),
        sobrescrever: !!m.sobrescrever, total: 0, feito: 0, status: 'fila', erro: '', cancel: false, streams: new Set(), fim: 0, sujo: false,
      };
      jobs.set(j.id, j); fila.push(j); criados.push(j.id);
      broadcast({ t: 'fs-job', job: pubJob(j) });
    }
    andar();
    return { jobs: criados };
  }
  function cancelar(m) {
    const j = jobs.get(String(m.job));
    if (j && (j.status === 'fila' || j.status === 'andando')) {
      j.cancel = true;
      for (const s of j.streams) { try { s.destroy(); } catch (_) {} }
      if (j.abort) j.abort();
    }
    return {};
  }
  function limpar() {
    for (const [id, j] of jobs) if (j.status !== 'fila' && j.status !== 'andando') jobs.delete(id);
    return {};
  }
  function lista(m) {
    return { jobs: [...jobs.values()].filter((j) => j.projeto === String(m.projeto)).map(pubJob), conectado: [...conns.values()].filter((c) => c.projeto === String(m.projeto)).map((c) => ({ conexao: c.conexao, host: c.host, usuario: c.user })) };
  }

  const OPS = { conectar, desconectar, ls: listar, existe, mkdir, renomear, apagar, transferir, cancelar, limpar, estado: lista };
  return {
    async handle(ws, m) {
      const rid = m.rid;
      const resp = (o) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ t: 'fs-r', rid }, o))); } catch (_) {} };
      const op = OPS[m.op];
      if (!op) return resp({ ok: false, erro: 'Operação desconhecida.' });
      try { resp(Object.assign({ ok: true }, await op(m))); }
      catch (e) { const a = amigavel(e); resp({ ok: false, erro: a.message, codigo: a.codigo, extra: a.extra }); }
    },
    fechar() { for (const c of conns.values()) { try { c.client.end(); } catch (_) {} } },
  };
};
