/* Painel de Comando: interface. JS puro, sem etapa de build. */
(() => {
'use strict';

const $ = (s) => document.querySelector(s);
function add(e, c) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) c.forEach((x) => add(e, x));
  else e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
}
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  kids.forEach((c) => add(e, c));
  return e;
}
const uid = (p) => p + Math.random().toString(36).slice(2, 8);
const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

let fonte = 13, foco = false;
try { fonte = Math.min(28, Math.max(9, +localStorage.getItem('painel-fonte') || 13)); foco = localStorage.getItem('painel-foco') === '1'; } catch (_) {}
let data = null, sessions = {}, bufs = {}, terms = {}, cur = null, activeId = {}, reveal = {}, copied = {}, ws = null, wsOk = false;
const proj = () => (data ? data.projetos.find((p) => p.id === cur) : null);
const sessionsOf = (pid) => Object.values(sessions).filter((s) => s.projeto === pid).sort((a, b) => a.inicio - b.inicio);
const filhosDe = (id) => Object.values(sessions).filter((s) => s.pai === id);
const sessFor = (pid, tipo, ref) => Object.values(sessions).find((s) => s.projeto === pid && s.tipo === tipo && s.ref === ref);

/* ---------- ícones ---------- */
const ICONS = {
  edit: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  expand: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  shrink: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
  plusbox: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z',
};
function icon(n) {
  const NS = 'http://www.w3.org/2000/svg';
  const sv = document.createElementNS(NS, 'svg');
  sv.setAttribute('viewBox', '0 0 24 24'); sv.setAttribute('width', '16'); sv.setAttribute('height', '16'); sv.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', ICONS[n]); p.setAttribute('fill', 'currentColor');
  sv.appendChild(p); return sv;
}

/* ---------- tema, avisos ---------- */
try { const t = localStorage.getItem('painel-tema'); if (t) document.documentElement.dataset.theme = t; } catch (_) {}
$('#theme').onclick = () => {
  const r = document.documentElement;
  const dark = r.dataset.theme ? r.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
  r.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('painel-tema', r.dataset.theme); } catch (_) {}
};
function toast(msg, err) {
  const d = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  $('#toasts').appendChild(d);
  setTimeout(() => d.remove(), err ? 6000 : 3500);
}

/* ---------- dados ---------- */
function save() {
  return fetch('/api/dados', { method: 'PUT', headers: { 'X-Painel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    .then((r) => { if (!r.ok) throw new Error(); })
    .catch(() => toast('Não consegui salvar. O serviço do painel está rodando?', true));
}

/* ---------- conexão com o serviço ---------- */
function send(o) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
  else if (o.t === 'rodar') toast('Sem conexão com o serviço do painel. Tentando reconectar…', true);
}
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { wsOk = true; $('#lost').hidden = true; drawFoot(); };
  ws.onmessage = (ev) => { try { onMsg(JSON.parse(ev.data)); } catch (_) {} };
  ws.onclose = () => { wsOk = false; $('#lost').hidden = false; drawFoot(); setTimeout(connect, 1500); };
}
function onMsg(m) {
  if (m.t === 'init') {
    const novos = {};
    m.sessoes.forEach((s) => { novos[s.id] = s; });
    Object.keys(terms).forEach((id) => { if (!novos[id]) dispose(id); });
    sessions = novos;
    bufs = {};
    m.sessoes.forEach((s) => { bufs[s.id] = ''; });
    redrawAll();
  } else if (m.t === 'hist') {
    bufs[m.id] = m.d;
    if (terms[m.id]) { terms[m.id].term.reset(); terms[m.id].term.write(m.d); }
  } else if (m.t === 'dado') {
    bufs[m.id] = ((bufs[m.id] || '') + m.d).slice(-400000);
    if (terms[m.id]) terms[m.id].term.write(m.d);
  } else if (m.t === 'sessao') {
    const novo = !sessions[m.s.id];
    sessions[m.s.id] = m.s;
    if (novo && bufs[m.s.id] == null) bufs[m.s.id] = '';
    if (novo && m.s.projeto === cur && (!m.s.pai || !filhosDe(m.s.pai).some((x) => x.id !== m.s.id && activeId[cur] === x.id))) activeId[cur] = m.s.id;
    redrawAll(novo && m.s.projeto === cur);
    if (!novo && m.s.status === 'encerrado' && m.s.tipo === 'acao' && !m.s.parada && !filhosDe(m.s.id).length) {
      if (m.s.code === 0) toast('“' + m.s.titulo + '” concluído.');
      else toast('“' + m.s.titulo + '” falhou (código ' + m.s.code + ').', true);
    }
  } else if (m.t === 'removida') {
    delete sessions[m.id]; delete bufs[m.id]; dispose(m.id);
    redrawAll();
  } else if (m.t === 'erro') toast(m.msg, true);
}
const rodar = (pid, tipo, ref) => send({ t: 'rodar', projeto: pid, tipo, ref });

/* ---------- janelas de diálogo ---------- */
function modal(o) {
  const root = $('#modal'), prev = document.activeElement, inputs = {};
  const err = h('div', { class: 'fail', role: 'alert' });
  const fields = (o.fields || []).map((f) => {
    const id = 'f-' + f.id;
    let el;
    if (f.type === 'textarea') { el = h('textarea', { id, rows: f.rows || 3, class: f.mono ? 'mono' : null, spellcheck: 'false' }); el.value = f.value || ''; }
    else if (f.type === 'select') { el = h('select', { id }, f.options.map(([v, l]) => h('option', { value: v }, l))); el.value = f.value || f.options[0][0]; }
    else { el = h('input', { id, type: f.type || 'text', autocomplete: 'off', spellcheck: 'false' }); el.value = f.value || ''; }
    inputs[f.id] = el;
    return h('div', { class: 'field', id: 'w-' + f.id }, h('label', { for: id }, f.label), el, f.hint ? h('small', { class: 'hint' }, f.hint) : null);
  });
  let kd;
  const close = () => {
    root.classList.remove('open'); root.setAttribute('aria-hidden', 'true'); root.replaceChildren();
    document.removeEventListener('keydown', kd, true);
    if (prev && document.contains(prev)) prev.focus();
  };
  const submit = (e) => {
    if (e) e.preventDefault();
    const v = {};
    for (const k in inputs) v[k] = inputs[k].value;
    for (const f of o.fields || []) {
      if (f.required && !String(v[f.id]).trim()) { err.textContent = 'Preencha “' + f.label + '”.'; inputs[f.id].focus(); return; }
    }
    close();
    if (o.onSubmit) o.onSubmit(v);
  };
  const cls = { prod: 'danger', hml: 'warn', danger: 'danger' }[o.tone] || 'primary';
  const no = h('button', { type: 'button', class: 'btn', onclick: close }, o.no || 'Cancelar');
  const btns = h('div', { class: 'btns' },
    o.extra ? h('button', { type: 'button', class: 'btn stop left', onclick: () => { close(); o.extra.onClick(); } }, o.extra.label) : null,
    no, h('button', { type: 'submit', class: 'btn ' + cls }, o.yes || 'Salvar'));
  const box = h('form', { class: 'dialog ' + (o.tone || ''), role: o.fields ? 'dialog' : 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'dt', novalidate: true, onsubmit: submit },
    h('h2', { id: 'dt' }, o.title), o.text ? h('p', null, o.text) : null, fields, err, btns);
  root.replaceChildren(box);
  root.classList.add('open'); root.setAttribute('aria-hidden', 'false');
  kd = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') {
      const f = [...box.querySelectorAll('input,textarea,select,button')].filter((x) => !x.disabled);
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  };
  document.addEventListener('keydown', kd, true);
  if (o.onReady) o.onReady(inputs);
  (o.fields && o.fields.length ? inputs[o.fields[0].id] : no).focus();
}
const confirmar = (o, fn) => modal(Object.assign({ onSubmit: fn }, o));

function remover(titulo, texto, fn) {
  confirmar({ tone: 'danger', title: titulo, text: texto || 'Isso não pode ser desfeito.', yes: 'Remover', no: 'Manter' }, fn);
}

/* ---------- formulários ---------- */
function formProjeto(p) {
  modal({
    title: p ? 'Editar projeto' : 'Novo projeto',
    fields: [
      { id: 'nome', label: 'Nome', value: p ? p.nome : '', required: true },
      { id: 'pasta', label: 'Pasta do projeto', value: p ? p.pasta : '~/projetos/', required: true, hint: 'É nela que as ações rodam. Exemplo: ~/projetos/indica-monorepo' },
    ],
    yes: p ? 'Salvar' : 'Criar projeto',
    extra: p ? { label: 'Excluir projeto', onClick: () => confirmar({ tone: 'danger', title: 'Excluir “' + p.nome + '”?', text: 'Isso remove ações, conexões, senhas e anotações deste projeto. Não pode ser desfeito.', yes: 'Excluir', no: 'Manter' }, () => {
      sessionsOf(p.id).forEach((s) => send({ t: 'fechar', id: s.id }));
      data.projetos = data.projetos.filter((x) => x.id !== p.id);
      cur = data.projetos[0] ? data.projetos[0].id : null;
      save(); redrawAll(); drawNotes();
    }) } : null,
    onSubmit: (v) => {
      if (p) { p.nome = v.nome.trim(); p.pasta = v.pasta.trim(); }
      else { const np = { id: uid('p'), nome: v.nome.trim(), pasta: v.pasta.trim(), acoes: [], conexoes: [], info: [], notas: '' }; data.projetos.push(np); cur = np.id; }
      save(); redrawAll(); drawNotes();
    },
  });
}
function formAcao(p, a) {
  modal({
    title: a ? 'Editar ação' : 'Nova ação',
    fields: [
      { id: 'rotulo', label: 'Nome do botão', value: a ? a.rotulo : '', required: true, hint: 'Exemplo: Rodar ambiente local' },
      { id: 'cmd', label: 'Comando', type: 'textarea', mono: true, rows: 3, value: a ? a.cmd : '', required: true, hint: 'Roda numa shell de login, dentro da pasta do projeto. Exemplo: ./scripts/dev.sh' },
      { id: 'tipo', label: 'Como roda', type: 'select', value: a ? a.tipo : 'continua', options: [['continua', 'Fica rodando (tem botão Parar)'], ['unica', 'Roda até terminar']] },
      { id: 'ambiente', label: 'Ambiente', type: 'select', value: a ? a.ambiente : '', options: [['', 'Nenhum (ação comum)'], ['homologacao', 'Homologação (pede confirmação)'], ['producao', 'Produção (pede confirmação)']] },
      { id: 'destino', label: 'Destino (aparece na confirmação)', value: a ? a.destino : '', hint: 'Exemplo: hml.exemplo.com.br' },
    ],
    extra: a ? { label: 'Remover ação', onClick: () => delAcao(p, a) } : null,
    onSubmit: (v) => {
      const novo = { id: a ? a.id : uid('a'), rotulo: v.rotulo.trim(), cmd: v.cmd.trim(), tipo: v.tipo, ambiente: v.ambiente, destino: v.destino.trim() };
      if (a) Object.assign(a, novo); else p.acoes.push(novo);
      save(); redrawAll();
    },
  });
}
function formConexao(p, c) {
  modal({
    title: c ? 'Editar conexão' : 'Nova conexão',
    fields: [
      { id: 'rotulo', label: 'Nome', value: c ? c.rotulo : '', required: true, hint: 'Exemplo: Servidor (SSH)' },
      { id: 'cmd', label: 'Comando', type: 'textarea', mono: true, rows: 2, value: c ? c.cmd : '', required: true, hint: 'Exemplo: ssh usuario@servidor' },
    ],
    extra: c ? { label: 'Remover conexão', onClick: () => delConexao(p, c) } : null,
    onSubmit: (v) => {
      const novo = { id: c ? c.id : uid('c'), rotulo: v.rotulo.trim(), cmd: v.cmd.trim() };
      if (c) Object.assign(c, novo); else p.conexoes.push(novo);
      save(); redrawAll();
    },
  });
}
function formInfo(p, it) {
  const tipo0 = it ? it.tipo : 'usuario';
  modal({
    title: it ? 'Editar informação' : 'Nova informação',
    fields: [
      { id: 'tipo', label: 'Tipo', type: 'select', value: tipo0, options: [['usuario', 'Usuário e senha'], ['texto', 'Texto'], ['link', 'Link'], ['segredo', 'Segredo (aparece oculto)']] },
      { id: 'rotulo', label: 'Nome', value: it ? it.rotulo : '', required: true, hint: 'Exemplo: Painel do servidor' },
      { id: 'valor', label: 'Valor', value: it ? it.valor : '' },
      { id: 'senha', label: 'Senha', type: 'password', value: it ? it.senha || '' : '' },
    ],
    onReady: (inp) => {
      const lv = $('#w-valor label'), ls = $('#w-senha');
      const mk = (campo) => {
        const w = $('#w-' + campo);
        const b = h('button', { type: 'button', class: 'link', style: 'align-self:flex-start', onclick: () => { const o = inp[campo].type === 'password'; inp[campo].type = o ? 'text' : 'password'; b.textContent = o ? 'Ocultar ao digitar' : 'Mostrar ao digitar'; } }, 'Mostrar ao digitar');
        w.appendChild(b); return b;
      };
      const bv = mk('valor'), bs = mk('senha');
      const sync = () => {
        const t = inp.tipo.value;
        lv.textContent = t === 'usuario' ? 'Usuário (login)' : 'Valor';
        ls.hidden = t !== 'usuario';
        inp.valor.type = t === 'segredo' ? 'password' : 'text';
        inp.senha.type = 'password';
        bv.hidden = t !== 'segredo'; bv.textContent = 'Mostrar ao digitar'; bs.textContent = 'Mostrar ao digitar';
      };
      inp.tipo.addEventListener('change', sync); sync();
    },
    extra: it ? { label: 'Remover', onClick: () => remover('Remover “' + it.rotulo + '”?', null, () => { p.info = p.info.filter((x) => x.id !== it.id); save(); redrawAll(); }) } : null,
    onSubmit: (v) => {
      const novo = { id: it ? it.id : uid('i'), rotulo: v.rotulo.trim(), tipo: v.tipo, valor: v.valor, senha: v.tipo === 'usuario' ? v.senha : '' };
      if (it) Object.assign(it, novo); else p.info.push(novo);
      save(); redrawAll();
    },
  });
}

function delAcao(p, a) { remover('Remover a ação “' + a.rotulo + '”?', null, () => { p.acoes = p.acoes.filter((x) => x.id !== a.id); save(); redrawAll(); }); }
function delConexao(p, c) { remover('Remover a conexão “' + c.rotulo + '”?', null, () => { p.conexoes = p.conexoes.filter((x) => x.id !== c.id); save(); redrawAll(); }); }
function delInfo(p, it) { remover('Remover “' + it.rotulo + '”?', null, () => { p.info = p.info.filter((x) => x.id !== it.id); save(); redrawAll(); }); }

/* ---------- ações ---------- */
function pedirRodar(p, a) {
  if (a.ambiente === 'producao') {
    confirmar({ tone: 'prod', title: a.rotulo + '?', text: 'Projeto ' + p.nome + '. Vai atuar em ' + (a.destino || 'produção') + ' e quem estiver usando o sistema pode ser afetado.', yes: 'Executar em produção', no: 'Cancelar' }, () => rodar(p.id, 'acao', a.id));
  } else if (a.ambiente === 'homologacao') {
    confirmar({ tone: 'hml', title: a.rotulo + '?', text: 'Projeto ' + p.nome + '. Vai atuar em ' + (a.destino || 'homologação') + '. O ambiente de testes será atualizado.', yes: 'Executar em homologação', no: 'Cancelar' }, () => rodar(p.id, 'acao', a.id));
  } else rodar(p.id, 'acao', a.id);
}
function pedirParar(s) {
  confirmar({ tone: 'danger', title: 'Parar “' + s.titulo + '”?', text: 'O processo será encerrado.', yes: 'Parar', no: 'Continuar rodando' }, () => send({ t: 'parar', id: s.id }));
}
function copiar(texto, rotulo, k) {
  const ok = () => { copied[k] = 1; toast(rotulo + ' copiado. Fica na área de transferência até você copiar outra coisa.'); drawSide(); setTimeout(() => { delete copied[k]; drawSide(); }, 2000); };
  const falha = () => toast('Não consegui copiar. Selecione o texto e use Ctrl+C.', true);
  if (navigator.clipboard) navigator.clipboard.writeText(texto).then(ok, falha); else falha();
}
function toggleReveal(id) {
  if (reveal[id]) { clearTimeout(reveal[id]); delete reveal[id]; }
  else reveal[id] = setTimeout(() => { delete reveal[id]; drawSide(); }, 15000);
  drawSide();
}

/* ---------- estado ---------- */
function estado(s) {
  if (!s) return { k: 'parado' };
  const fs = filhosDe(s.id), vivos = fs.filter((x) => x.status === 'rodando');
  if (s.status === 'rodando' || vivos.length) return { k: 'rodando', inicio: s.inicio, id: s.id, abas: fs.length ? vivos.length : 0 };
  const ruim = fs.find((x) => !x.parada && x.code !== 0);
  if (ruim) return { k: 'falhou', code: ruim.code, ver: ruim.id };
  if (s.parada) return { k: 'parado' };
  if (s.code === 0) return { k: 'concluido', dur: (fs.reduce((m, x) => Math.max(m, x.fim || 0), s.fim) - s.inicio) };
  return { k: 'falhou', code: s.code, ver: s.id };
}
function chip(st) {
  if (st.k === 'rodando') return h('span', { class: 'chip run', 'data-chip': st.id }, '● Rodando há ' + fmt(Date.now() - st.inicio) + (st.abas ? ' · ' + st.abas + (st.abas === 1 ? ' aba' : ' abas') : ''), st.abas ? h('span', { class: 'hid', 'data-abas': st.abas }) : null);
  if (st.k === 'concluido') return h('span', { class: 'chip ok' }, '✓ Concluído em ' + Math.max(1, Math.round(st.dur / 1000)) + ' s');
  if (st.k === 'falhou') return h('span', { class: 'chip err' }, '✕ Falhou (código ' + st.code + ')');
  return h('span', { class: 'chip' }, '○ Parado');
}
const dicaFalha = (code) => ({
  126: 'O script não tem permissão para executar. Rode chmod +x no arquivo e tente de novo.',
  127: 'Comando não encontrado. Confira o comando da ação e se o programa está instalado.',
}[code] || 'A ação terminou com erro. Veja o log no terminal.');

/* ---------- desenho: barra de projetos ---------- */
function drawTabs() {
  const kids = data.projetos.map((p, i) => {
    const ss = sessionsOf(p.id).filter((s) => s.tipo === 'acao' || s.tipo === 'aba');
    const bad = ss.some((s) => s.status !== 'rodando' && !s.parada && s.code !== 0 && s.code != null);
    const run = ss.some((s) => s.status === 'rodando');
    return h('button', { class: 'tab', role: 'tab', id: 'tab-' + p.id, 'aria-selected': String(p.id === cur), 'aria-keyshortcuts': 'Alt+' + (i + 1), 'data-k': 'tab-' + p.id, onclick: () => selectProject(p.id) },
      p.nome, bad ? h('span', { class: 'dot err', title: 'Ação com erro', 'aria-label': 'com erro' }) : run ? h('span', { class: 'dot ok', title: 'Algo rodando', 'aria-label': 'com atividade' }) : null);
  });
  kids.push(h('button', { class: 'tab', title: 'Adicionar projeto', 'aria-label': 'Adicionar projeto', 'data-k': 'addproj', onclick: () => formProjeto(null) }, '+'));
  $('#tabs').replaceChildren(...kids);
}
function selectProject(id) {
  cur = id;
  try { localStorage.setItem('painel-projeto', id); } catch (_) {}
  redrawAll(); drawNotes();
}

/* ---------- desenho: coluna lateral ---------- */
const editBtn = (label, fn) => h('button', { class: 'icon', title: label, 'aria-label': label, onclick: fn }, icon('edit'));
const delBtn = (label, fn) => h('button', { class: 'icon del', title: label, 'aria-label': label, onclick: fn }, icon('trash'));
const btnsHead = (ed, del, what) => h('span', { class: 'ibtns' }, editBtn('Editar ' + what, ed), delBtn('Remover ' + what, del));
const secHead = (title, label, fn) => h('h2', null, h('span', null, title), fn ? h('button', { class: 'addbtn', onclick: fn }, icon('plus'), label) : null);

function acaoCard(p, a) {
  const s = sessFor(p.id, 'acao', a.id), st = estado(s), rodando = st.k === 'rodando';
  let botao;
  if (rodando) botao = h('button', { class: 'btn lg stop', 'data-k': 'run-' + a.id, onclick: () => pedirParar(s) }, h('span', { 'aria-hidden': 'true' }, '■'), 'Parar');
  else {
    const cls = a.ambiente === 'producao' ? 'danger' : a.ambiente === 'homologacao' ? 'warn' : 'primary';
    botao = h('button', { class: 'btn lg ' + cls, 'data-k': 'run-' + a.id, onclick: () => pedirRodar(p, a) }, a.tipo === 'continua' && !a.ambiente ? h('span', { 'aria-hidden': 'true' }, '▶') : null, st.k === 'falhou' ? 'Tentar de novo' : a.rotulo);
  }
  return h('div', { class: 'card' },
    h('div', { class: 'head' }, h('div', null, h('div', { class: 'name' }, a.rotulo), a.ambiente ? h('span', { class: 'pill ' + (a.ambiente === 'producao' ? 'prod' : 'hml') }, a.ambiente === 'producao' ? 'Produção' : 'Homologação') : null), btnsHead(() => formAcao(p, a), () => delAcao(p, a), 'ação')),
    h('div', { class: 'row', style: 'justify-content:space-between' }, chip(st), a.destino ? h('span', { class: 'chip' }, '→ ' + a.destino) : null),
    h('div', { class: 'cmd' }, a.cmd),
    st.k === 'falhou' ? h('div', { class: 'err-box' }, dicaFalha(st.code)) : null,
    st.k === 'falhou' ? h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => showSession(st.ver || s.id, true) }, 'Ver log')) : null,
    botao);
}
function conexaoCard(p, c) {
  const s = sessFor(p.id, 'conexao', c.id), on = s && s.status === 'rodando';
  return h('div', { class: 'card' },
    h('div', { class: 'head' }, h('span', { class: 'name' }, c.rotulo), btnsHead(() => formConexao(p, c), () => delConexao(p, c), 'conexão')),
    h('div', { class: 'cmd' }, c.cmd),
    h('div', { class: 'row' }, h('button', { class: 'btn', 'data-k': 'ssh-' + c.id, onclick: () => (on ? showSession(s.id, true) : rodar(p.id, 'conexao', c.id)) }, on ? 'Ver terminal' : 'Abrir SSH')));
}
const TIPOS = { usuario: 'Usuário e senha', texto: 'Texto', link: 'Link', segredo: 'Segredo' };
function valBox(txt, rot, k, oculto, link) {
  const v = oculto ? h('span', { class: 'val', 'aria-label': rot + ', oculto' }, '••••••••••')
    : link && /^https?:\/\//i.test(txt) ? h('span', { class: 'val' }, h('a', { href: txt, target: '_blank', rel: 'noopener noreferrer' }, txt))
    : h('span', { class: 'val' }, txt || '—');
  return v;
}
function infoRow(p, it) {
  const usr = it.tipo === 'usuario', sec = it.tipo === 'segredo' || usr, shown = !!reveal[it.id];
  const corpo = [];
  if (usr) {
    corpo.push(h('div', { class: 'vrow' }, h('span', { class: 'kv' }, 'Usuário'), valBox(it.valor, it.rotulo + ' usuário', '', false, false),
      h('button', { class: 'btn sm', 'data-k': 'cu-' + it.id, onclick: () => copiar(it.valor, 'Usuário', 'u' + it.id) }, copied['u' + it.id] ? 'Copiado' : 'Copiar')));
    corpo.push(h('div', { class: 'vrow' }, h('span', { class: 'kv' }, 'Senha'), valBox(it.senha, it.rotulo + ' senha', '', !shown, false),
      h('button', { class: 'btn sm', 'data-k': 'cs-' + it.id, onclick: () => copiar(it.senha || '', 'Senha', 's' + it.id) }, copied['s' + it.id] ? 'Copiado' : 'Copiar')));
  } else {
    corpo.push(h('div', { class: 'vrow' }, valBox(it.valor, it.rotulo, '', sec && !shown, it.tipo === 'link'),
      h('button', { class: 'btn sm', 'data-k': 'cp-' + it.id, onclick: () => copiar(it.valor, it.rotulo, it.id) }, copied[it.id] ? 'Copiado' : 'Copiar')));
  }
  return h('div', { class: 'icard t-' + it.tipo },
    h('div', { class: 'ihead' }, h('div', null, h('div', { class: 'ilbl' }, it.rotulo), h('div', { class: 'cap' }, TIPOS[it.tipo] || 'Texto')), btnsHead(() => formInfo(p, it), () => delInfo(p, it), 'informação')),
    corpo,
    sec ? h('button', { class: 'link', 'aria-pressed': String(shown), 'data-k': 'rv-' + it.id, title: 'Volta a ficar oculto em 15 s', onclick: () => toggleReveal(it.id) }, shown ? 'Ocultar senha' : 'Mostrar senha') : null);
}
function drawSide() {
  const box = $('#sideMain'), p = proj();
  const af = document.activeElement, fk = af && box.contains(af) ? af.getAttribute('data-k') : null;
  if (!p) {
    box.replaceChildren(h('div', { class: 'empty' }, h('h3', null, 'Nenhum projeto ainda'), h('p', null, 'Adicione a pasta de um projeto para ter aqui os botões, terminais e informações dele.'), h('button', { class: 'btn primary', onclick: () => formProjeto(null) }, 'Adicionar projeto')));
    return;
  }
  const out = [];
  out.push(h('div', { class: 'phead' }, h('div', null, h('div', { class: 'pname' }, p.nome), h('code', { class: 'ppath' }, p.pasta)), editBtn('Editar projeto', () => formProjeto(p))));
  out.push(h('section', { class: 'sec' }, secHead('Conexões', 'Adicionar', () => formConexao(p, null)),
    p.conexoes.length ? h('div', { class: 'stack' }, p.conexoes.map((c) => conexaoCard(p, c))) : h('p', { class: 'note' }, 'Nenhuma conexão. Adicione o comando SSH do servidor.')));
  out.push(h('section', { class: 'sec' }, secHead('Ações', 'Adicionar', () => formAcao(p, null)),
    p.acoes.length ? h('div', { class: 'stack' }, p.acoes.map((a) => acaoCard(p, a)))
      : h('div', { class: 'empty' }, h('h3', null, 'Este projeto ainda não tem ações'), h('p', null, 'Ações são os scripts que você roda todo dia, como subir o ambiente local. Adicione a primeira.'), h('button', { class: 'btn primary', onclick: () => formAcao(p, null) }, 'Adicionar ação'))));
  out.push(h('section', { class: 'sec' }, secHead('Info', 'Adicionar', () => formInfo(p, null)),
    p.info.length ? [h('div', { class: 'stack' }, p.info.map((it) => infoRow(p, it))), h('p', { class: 'note' }, 'Estas informações ficam em texto simples neste computador (arquivo com acesso só seu).')]
      : h('div', { class: 'empty' }, h('h3', null, 'Nada guardado por aqui'), h('p', null, 'Guarde links, usuários e senhas que você usa todo dia neste projeto.'), h('button', { class: 'btn', onclick: () => formInfo(p, null) }, 'Adicionar informação'))));
  box.replaceChildren(...out);
  if (fk) { const el = box.querySelector('[data-k="' + fk + '"]'); if (el) el.focus(); }
}
function drawNotes() {
  const box = $('#notes'), p = proj();
  if (!p) { box.replaceChildren(); return; }
  const st = h('span', { id: 'notasSt' }, '');
  const ta = h('textarea', { id: 'notasTxt', spellcheck: 'false', placeholder: 'Anotações livres deste projeto: passos, lembretes, comandos…' });
  ta.value = p.notas;
  let t;
  ta.addEventListener('input', () => {
    const q = proj(); if (!q) return;
    q.notas = ta.value; st.textContent = 'Salvando…';
    clearTimeout(t); t = setTimeout(() => save().then(() => { st.textContent = 'Salvo'; }), 600);
  });
  box.replaceChildren(h('label', { for: 'notasTxt' }, 'Anotações', st), ta);
}

/* ---------- desenho: terminais ---------- */
function dispose(id) {
  const t = terms[id];
  if (!t) return;
  try { t.term.dispose(); } catch (_) {}
  t.host.remove(); delete terms[id];
}
function ensureTerm(id) {
  if (terms[id]) return terms[id];
  const host = h('div', { class: 'termhost' });
  $('#thosts').appendChild(host);
  const term = new Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(), fontSize: fonte, cursorBlink: true, scrollback: 5000, theme: { background: '#0B0D11', foreground: '#D7DAE0', cursor: '#D7DAE0', selectionBackground: '#2C3A55' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.onData((d) => send({ t: 'entrada', id, d }));
  term.onResize(({ cols, rows }) => send({ t: 'tamanho', id, cols, rows }));
  let last = 0;
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === 'keydown' && ev.ctrlKey && !ev.altKey && ['=', '+', '-', '_', '0'].includes(ev.key)) {
      ev.preventDefault(); setFonte(ev.key === '0' ? 13 : fonte + (ev.key === '-' || ev.key === '_' ? -1 : 1)); return false;
    }
    if (ev.type === 'keydown' && ev.key === 'Escape') {
      const n = Date.now();
      if (n - last < 600) { last = 0; const tb = $('#tab-' + cur); if (tb) tb.focus(); toast('Foco devolvido ao painel.'); return false; }
      last = n;
    }
    return true;
  });
  if (bufs[id]) term.write(bufs[id]);
  return (terms[id] = { term, fit, host });
}
function setFonte(n) {
  fonte = Math.min(28, Math.max(9, n));
  try { localStorage.setItem('painel-fonte', String(fonte)); } catch (_) {}
  Object.keys(terms).forEach((k) => { terms[k].term.options.fontSize = fonte; });
  const s = currentSession(); if (s) fitTerm(s.id);
  const l = $('#fontLbl'); if (l) l.textContent = fonte + ' px';
}
function setFoco(v) {
  foco = v;
  try { localStorage.setItem('painel-foco', v ? '1' : '0'); } catch (_) {}
  $('#app').classList.toggle('foco', foco);
  drawTermTabs();
}
function fitTerm(id) {
  const t = terms[id];
  if (!t || t.host.hidden || !t.host.clientWidth) return;
  try { t.fit.fit(); } catch (_) {}
  send({ t: 'tamanho', id, cols: t.term.cols, rows: t.term.rows });
}
function stateText(s) {
  if (s.status === 'rodando') return s.tipo === 'conexao' ? 'Conectado' : 'Executando';
  if (s.parada) return 'Parado';
  return s.code === 0 ? 'Concluído' : 'Encerrado (código ' + s.code + ')';
}
function currentSession() {
  const p = proj();
  if (!p) return null;
  const ss = visiveis(p.id), a = activeId[p.id] && sessions[activeId[p.id]];
  return (a && ss.includes(a) && a) || ss[0] || null;
}
function visiveis(pid) {
  return sessionsOf(pid).filter((s) => !(s.tipo === 'acao' && s.status !== 'rodando' && !s.parada && s.code === 0 && filhosDe(s.id).length));
}
function drawTermTabs() {
  const p = proj(), box = $('#ttabs');
  if (!p) { box.replaceChildren(); return; }
  const act = currentSession();
  const lista = h('div', { class: 'tlist', role: 'tablist', 'aria-label': 'Terminais do projeto' }, visiveis(p.id).map((s) => {
    const on = act && act.id === s.id;
    const fechavel = s.status !== 'rodando' || s.tipo === 'conexao' || s.tipo === 'aba' || s.tipo === 'livre';
    return h('div', { class: 'ttab' + (on ? ' on' : '') },
      h('button', { class: 't', role: 'tab', 'aria-selected': String(!!on), onclick: () => showSession(s.id, true) }, s.titulo),
      fechavel ? h('button', { class: 'x', title: 'Fechar terminal', 'aria-label': 'Fechar terminal ' + s.titulo, onclick: () => send({ t: 'fechar', id: s.id }) }, '×') : null);
  }));
  lista.appendChild(h('button', { class: 'icon newt', title: 'Novo terminal (shell livre nesta pasta)', 'aria-label': 'Novo terminal', 'data-k': 'newterm', onclick: () => send({ t: 'novo-terminal', projeto: p.id }) }, icon('plusbox')));
  const ctl = h('div', { class: 'tctl' },
    act ? h('span', { class: 'tstate' }, stateText(act)) : null,
    h('button', { class: 'icon', title: 'Diminuir a letra (Ctrl+−)', 'aria-label': 'Diminuir a letra do terminal', onclick: () => setFonte(fonte - 1) }, 'A−'),
    h('span', { class: 'flbl', id: 'fontLbl', title: 'Tamanho da letra. Ctrl+0 volta ao padrão' }, fonte + ' px'),
    h('button', { class: 'icon', title: 'Aumentar a letra (Ctrl++)', 'aria-label': 'Aumentar a letra do terminal', onclick: () => setFonte(fonte + 1) }, 'A+'),
    h('button', { class: 'icon', title: foco ? 'Mostrar a coluna lateral' : 'Ampliar o terminal (esconde a coluna lateral)', 'aria-label': foco ? 'Mostrar a coluna lateral' : 'Ampliar o terminal', 'aria-pressed': String(foco), onclick: () => setFoco(!foco) }, icon(foco ? 'shrink' : 'expand')));
  box.replaceChildren(lista, ctl);
}
function updateHosts(focus) {
  const s = currentSession(), empty = $('#tempty');
  Object.keys(terms).forEach((k) => { terms[k].host.hidden = !s || k !== s.id; });
  if (!s) {
    const p = proj();
    empty.hidden = false;
    empty.replaceChildren(h('h3', null, p ? 'Nenhum terminal aberto' : 'Nenhum projeto ainda'), h('p', null, p ? 'Rode uma ação, abra uma conexão SSH ou use o botão de novo terminal para ele aparecer aqui.' : 'Adicione um projeto para começar.'));
    return;
  }
  empty.hidden = true;
  const t = ensureTerm(s.id);
  t.host.hidden = false;
  fitTerm(s.id);
  if (focus) t.term.focus();
}
function showSession(id, focus) {
  const p = proj();
  if (!p) return;
  activeId[p.id] = id;
  drawTermTabs(); updateHosts(focus);
}
function drawFoot() {
  const n = Object.values(sessions).filter((s) => s.status === 'rodando').length;
  $('#foot').replaceChildren(h('span', null, n + (n === 1 ? ' sessão ativa' : ' sessões ativas') + (wsOk ? '' : ' · sem conexão')), h('span', null, 'Alt+1 a Alt+9 trocam de projeto · Ctrl++ e Ctrl+− mudam a letra · Esc duas vezes sai do terminal'));
}
function redrawAll(focusTerm) {
  if (!data) return;
  if (!cur || !proj()) cur = data.projetos[0] ? data.projetos[0].id : null;
  drawTabs(); drawSide(); drawTermTabs(); updateHosts(!!focusTerm); drawFoot();
}

/* ---------- divisor e atalhos ---------- */
function setLateral(px, salvar) {
  px = Math.min(620, Math.max(240, Math.round(px)));
  document.documentElement.style.setProperty('--side-w', px + 'px');
  $('#split').setAttribute('aria-valuenow', String(px));
  if (salvar) { try { localStorage.setItem('painel-lateral', String(px)); } catch (_) {} }
  return px;
}
(() => {
  const sp = $('#split'); let w = 300;
  try { w = +localStorage.getItem('painel-lateral') || 300; } catch (_) {}
  w = setLateral(w, false);
  sp.addEventListener('pointerdown', (e) => {
    e.preventDefault(); sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
    const mv = (ev) => { w = setLateral(ev.clientX - $('#side').getBoundingClientRect().left, false); };
    const up = () => { sp.classList.remove('drag'); sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); setLateral(w, true); };
    sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up);
  });
  sp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); w = setLateral(w + (e.key === 'ArrowRight' ? 20 : -20), true); }
    else if (e.key === 'Home') { e.preventDefault(); w = setLateral(300, true); }
  });
  sp.addEventListener('dblclick', () => { w = setLateral(300, true); });
})();
$('#app').classList.toggle('foco', foco);
document.addEventListener('wheel', (e) => { if (e.ctrlKey && $('#termArea').contains(e.target)) { e.preventDefault(); setFonte(fonte + (e.deltaY < 0 ? 1 : -1)); } }, { passive: false, capture: true });
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.altKey && ['=', '+', '-', '_', '0'].includes(e.key) && !$('#modal').classList.contains('open')) {
    e.preventDefault(); e.stopPropagation(); setFonte(e.key === '0' ? 13 : fonte + (e.key === '-' || e.key === '_' ? -1 : 1));
  }
}, true);

/* ---------- eventos gerais ---------- */
document.addEventListener('keydown', (e) => {
  const m = e.altKey && /^Digit([1-9])$/.exec(e.code);
  if (m && data && data.projetos[+m[1] - 1]) { e.preventDefault(); selectProject(data.projetos[+m[1] - 1].id); const t = $('#tab-' + cur); if (t) t.focus(); }
});
new ResizeObserver(() => { const s = currentSession(); if (s) fitTerm(s.id); }).observe($('#termwrap'));
setInterval(() => {
  document.querySelectorAll('[data-chip]').forEach((el) => { const s = sessions[el.getAttribute('data-chip')]; if (s && s.status === 'rodando') { const n = el.querySelector('[data-abas]'); el.firstChild.nodeValue = '● Rodando há ' + fmt(Date.now() - s.inicio) + (n ? ' · ' + n.getAttribute('data-abas') + (n.getAttribute('data-abas') === '1' ? ' aba' : ' abas') : ''); } });
}, 1000);

/* ---------- início ---------- */
fetch('/api/dados', { headers: { 'X-Painel': '1' } })
  .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
  .then((d) => {
    data = d;
    try { cur = localStorage.getItem('painel-projeto'); } catch (_) {}
    redrawAll(); drawNotes(); connect();
  })
  .catch(() => { document.body.textContent = 'Não consegui carregar os dados do painel. Abra pelo ícone Painel de Comando.'; });
})();
