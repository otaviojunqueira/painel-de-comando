'use strict';
/*
 * Janela nativa do Painel de Comando (Electron).
 * O serviço (terminais, dados) continua sendo o server/server.js, rodando por fora desta janela:
 * fechar a janela não derruba os terminais. Esta janela só carrega http://127.0.0.1:PORTA com a chave de acesso.
 */
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const cp = require('child_process');

// Em muitas instalações do Ubuntu o sandbox SUID do Electron não está configurado.
// A janela só carrega conteúdo local (127.0.0.1) e bloqueia navegação externa, então rodamos sem ele.
app.commandLine.appendSwitch('no-sandbox');
app.setName('painel-de-comando');

const PORT = Number(process.env.PAINEL_PORT) || 4777;
const CFG = process.env.PAINEL_HOME || path.join(os.homedir(), '.config', 'painel');
const ROOT = path.join(__dirname, '..');
const BASE = `http://127.0.0.1:${PORT}`;

const noAr = () => new Promise((res) => {
  const s = net.connect(PORT, '127.0.0.1');
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
});
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function garantirServico() {
  if (await noAr()) return true;
  const ch = cp.spawn(path.join(ROOT, 'bin', 'painel'), ['--servidor'], { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '' }) });
  ch.unref();
  for (let i = 0; i < 80; i++) { if (await noAr()) return true; await espera(100); }
  return false;
}

let win = null;
function abrir(token) {
  win = new BrowserWindow({
    width: 1360, height: 840, minWidth: 900, minHeight: 560,
    backgroundColor: '#0F1115', title: 'Painel de Comando',
    icon: path.join(ROOT, 'public', 'icone.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  Menu.setApplicationMenu(null);
  win.loadURL(`${BASE}/?t=${token}`);
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(BASE)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const ctrl = i.control || i.meta;
    if (i.key === 'F5' || (ctrl && i.key.toLowerCase() === 'r' && !i.shift)) { e.preventDefault(); win.webContents.reload(); }
    else if (i.key === 'F12' || (ctrl && i.shift && i.key.toLowerCase() === 'i')) { e.preventDefault(); win.webContents.toggleDevTools(); }
  });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    if (!(await garantirServico())) {
      console.error('O serviço do painel não subiu. Veja o log em ' + path.join(CFG, 'painel.log'));
      app.exit(1);
      return;
    }
    let token = '';
    try { token = fs.readFileSync(path.join(CFG, 'token'), 'utf8').trim(); } catch (_) {}
    abrir(token);
  });
  app.on('window-all-closed', () => app.quit());
}
