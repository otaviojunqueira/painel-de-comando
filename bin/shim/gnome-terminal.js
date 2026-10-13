'use strict';
// Traduz os argumentos do gnome-terminal em abas do Painel de Comando.
const http = require('http');
const args = process.argv.slice(2);
const abas = [];
let cur = null;
const nova = () => { cur = { titulo: '', cwd: '', cmd: '' }; abas.push(cur); return cur; };
const aspas = (a) => "'" + String(a).replace(/'/g, "'\\''") + "'";
let globalCwd = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--tab' || a === '--window') nova();
  else if (a.startsWith('--tab-with-profile') || a.startsWith('--window-with-profile')) { nova(); if (!a.includes('=')) i++; }
  else if (a.startsWith('--title=')) (cur || nova()).titulo = a.slice(8);
  else if (a === '--title') (cur || nova()).titulo = args[++i] || '';
  else if (a.startsWith('--working-directory=')) { const d = a.slice(20); if (cur) cur.cwd = d; else globalCwd = d; }
  else if (a === '--working-directory') { const d = args[++i] || ''; if (cur) cur.cwd = d; else globalCwd = d; }
  else if (a === '-e' || a === '--command') (cur || nova()).cmd = args[++i] || '';
  else if (a.startsWith('--command=')) (cur || nova()).cmd = a.slice(10);
  else if (a === '-x' || a === '--execute' || a === '--') { (cur || nova()).cmd = args.slice(i + 1).map(aspas).join(' '); break; }
  // demais opções (geometria, perfil, menu…) não têm efeito nas abas do painel
}
if (!abas.length) nova();
abas.forEach((t) => { if (!t.cwd) t.cwd = globalCwd; if (!t.titulo) t.titulo = 'Terminal'; });

const corpo = JSON.stringify({ id: process.env.PAINEL_SESSAO_ID, key: process.env.PAINEL_SESSAO_KEY, abas });
if (!process.env.PAINEL_SESSAO_ID) { console.error('gnome-terminal (painel): só funciona dentro de uma ação do Painel de Comando.'); process.exit(1); }
const req = http.request({ host: '127.0.0.1', port: Number(process.env.PAINEL_PORTA) || 4777, path: '/api/shim', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo), 'X-Painel-Shim': '1' } }, (res) => {
  res.resume();
  res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1));
});
req.on('error', (e) => { console.error('gnome-terminal (painel): não consegui falar com o painel: ' + e.message); process.exit(1); });
req.end(corpo);
