/* Painel de Comando: aba Arquivos (gerenciador SFTP, duas colunas). Carregado antes do app.js, que chama Arquivos.init(api). */
(() => {
'use strict';
let A = null;
const S = {};
let pid = null, rid = 0;
const pend = new Map();
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) {} return null; };
const junta = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
const pai = (p) => { const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
function fmtTam(b) {
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < 3);
  return nf.format(b) + ' ' + u[i];
}
const p2 = (n) => String(n).padStart(2, '0');
function fmtData(ms) { if (!ms) return ''; const d = new Date(ms); return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); }

const lado0 = () => ({ caminho: '', itens: [], sel: new Set(), ordem: { k: 'nome', asc: true }, ancora: null, carregando: false, carregado: false });
function st(id) {
  if (!S[id]) S[id] = { conexao: LS('painel-arq-conn-' + id), conectados: new Set(), jobs: new Map(), local: lado0(), remoto: lado0(), erro: '', fila: true };
  return S[id];
}
const proj = () => A.proj();
const cx = () => { const p = proj(), s = p && st(p.id); return p && s ? p.conexoes.find((c) => c.id === s.conexao) || null : null; };
const conectado = () => { const p = proj(); return !!(p && st(p.id).conectados.has(st(p.id).conexao)); };
const AMB = { homologacao: 'homologação', producao: 'produção' };

/* ---------- comunicação ---------- */
function req(op, args) {
  const p = proj(), s = st(p.id);
  return new Promise((resolve) => {
    const id = ++rid;
    pend.set(id, resolve);
    const ok = A.sendOk(Object.assign({ t: 'fs', rid: id, op, projeto: p.id, conexao: s.conexao }, args));
    if (!ok) { pend.delete(id); resolve({ ok: false, erro: 'Sem conexão com o serviço do painel.' }); }
  });
}

/* ---------- elementos fixos ---------- */
let root, barEl, panesEl, queueEl, paneEl = {}, listEl = {}, pathEl = {}, footEl = {};
const h = (...a) => A.h(...a);

function montar() {
  barEl = h('div', { class: 'fbar' });
  const mk = (lado) => {
    const titulo = lado === 'local' ? 'Seu computador' : 'Servidor';
    pathEl[lado] = h('input', { type: 'text', class: 'fpath mono', spellcheck: 'false', 'aria-label': 'Caminho no ' + (lado === 'local' ? 'seu computador' : 'servidor'), onkeydown: (e) => { if (e.key === 'Enter') ir(lado, pathEl[lado].value.trim() || '~'); } });
    listEl[lado] = h('div', { class: 'flist', tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Arquivos: ' + titulo, onkeydown: (e) => tecla(lado, e) });
    footEl[lado] = h('div', { class: 'ffoot' });
    const ic = (n, label, fn, cls) => h('button', { type: 'button', class: 'icon ' + (cls || ''), title: label, 'aria-label': label, onclick: fn }, A.icon(n));
    paneEl[lado] = h('section', { class: 'fpane', 'data-lado': lado, 'aria-label': titulo },
      h('div', { class: 'fhead' }, h('span', { class: 'ftitle', id: 'ft-' + lado }, titulo),
        lado === 'local'
          ? h('button', { type: 'button', class: 'btn sm primary', 'data-k': 'enviar', onclick: () => acaoTransf('enviar') }, A.icon('upload'), 'Enviar')
          : h('button', { type: 'button', class: 'btn sm', 'data-k': 'baixar', onclick: () => acaoTransf('baixar') }, A.icon('download'), 'Baixar')),
      h('div', { class: 'fnav' }, ic('up', 'Pasta acima', () => subir(lado)), pathEl[lado], ic('refresh', 'Atualizar', () => ir(lado, st(proj().id)[lado].caminho || '~')),
        ic('newfolder', 'Nova pasta', () => novaPasta(lado)), ic('edit', 'Renomear (F2)', () => renomear(lado)), ic('trash', 'Excluir (Delete)', () => apagar(lado), 'del')),
      listEl[lado], footEl[lado]);
    // soltar arquivos arrastados do outro lado
    const li = listEl[lado];
    li.addEventListener('dragover', (e) => { if (arrasto && arrasto.lado !== lado) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; paneEl[lado].classList.add('alvo'); const r = e.target.closest('.frow'); marcaAlvo(r && r.dataset.dir === '1' ? r : null, li); } });
    li.addEventListener('dragleave', (e) => { if (!li.contains(e.relatedTarget)) { paneEl[lado].classList.remove('alvo'); marcaAlvo(null, li); } });
    li.addEventListener('drop', (e) => {
      paneEl[lado].classList.remove('alvo'); marcaAlvo(null, li);
      if (!arrasto || arrasto.lado === lado) return;
      e.preventDefault();
      const s = st(proj().id), r = e.target.closest('.frow');
      const destDir = r && r.dataset.dir === '1' ? (r.dataset.nome === '..' ? pai(s[lado].caminho) : junta(s[lado].caminho, r.dataset.nome)) : s[lado].caminho;
      const nomes = arrasto.nomes; const dir = arrasto.lado === 'local' ? 'enviar' : 'baixar';
      arrasto = null;
      transferir(dir, nomes, destDir);
    });
  };
  mk('local'); mk('remoto');
  panesEl = h('div', { class: 'fpanes' }, paneEl.local, paneEl.remoto);
  queueEl = h('section', { class: 'fqueue', 'aria-label': 'Transferências' });
  root.replaceChildren(barEl, panesEl, queueEl);
  montaDivisor(); carregaCols();
}
let arrasto = null;
function marcaAlvo(row, li) { li.querySelectorAll('.frow.alvo').forEach((x) => x.classList.remove('alvo')); if (row) row.classList.add('alvo'); }

/* ---------- barra de conexão ---------- */
function drawBar() {
  const p = proj(); if (!p) return;
  const s = st(p.id);
  if (!p.conexoes.length) {
    barEl.replaceChildren(h('span', { class: 'fmsg' }, 'Este projeto não tem conexão SSH. Cadastre uma na coluna lateral para usar o gerenciador de arquivos.'));
    return;
  }
  if (!s.conexao || !p.conexoes.some((c) => c.id === s.conexao)) s.conexao = p.conexoes[0].id;
  const c = cx(), on = conectado();
  const sel = h('select', { 'aria-label': 'Conexão', onchange: () => { s.conexao = sel.value; LS('painel-arq-conn-' + p.id, s.conexao); s.remoto = lado0(); s.erro = ''; drawBar(); drawPane('remoto'); if (conectado()) ir('remoto', salvoRemoto() || '~'); } },
    p.conexoes.map((x) => h('option', { value: x.id }, x.rotulo)));
  sel.value = s.conexao;
  barEl.replaceChildren(...[
    h('label', { class: 'flab' }, 'Servidor'), sel,
    on ? h('button', { type: 'button', class: 'btn sm', onclick: desconectar }, 'Desconectar') : h('button', { type: 'button', class: 'btn sm primary', 'data-k': 'conectar', onclick: () => conectar({}) }, 'Conectar'),
    h('span', { class: 'chip ' + (on ? 'ok' : '') }, on ? '● Conectado' : '○ Desconectado'),
    c && c.ambiente ? h('span', { class: 'pill ' + (c.ambiente === 'producao' ? 'prod' : 'hml') }, c.ambiente === 'producao' ? 'Produção' : 'Homologação') : null,
    s.erro ? h('span', { class: 'fmsg err', role: 'alert' }, s.erro) : null].filter(Boolean));
}
const salvoRemoto = () => { const s = st(proj().id); return LS('painel-arq-r-' + proj().id + '-' + s.conexao); };

async function conectar(extra) {
  const p = proj(), s = st(p.id);
  s.erro = ''; drawBar();
  const botao = barEl.querySelector('[data-k=conectar]'); if (botao) { botao.disabled = true; botao.textContent = 'Conectando…'; }
  const r = await req('conectar', extra);
  if (!proj() || proj().id !== p.id) return;
  if (r.ok) {
    s.conectados.add(s.conexao); drawBar(); drawPane('remoto');
    ir('remoto', salvoRemoto() || '~');
    return;
  }
  if (r.codigo === 'host-novo') {
    A.confirmar({ tone: 'hml', title: 'Primeira conexão com este servidor', text: 'Confirme que a impressão digital abaixo é a do seu servidor (no servidor: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub).\n\n' + r.extra.impressao, yes: 'Confiar e conectar', no: 'Cancelar' }, () => conectar(Object.assign({}, extra, { confiar: r.extra.impressao })));
    drawBar(); return;
  }
  if (r.codigo === 'senha' || r.codigo === 'frase') {
    A.modal({ title: r.codigo === 'frase' ? 'Senha da chave SSH' : 'Senha do servidor', text: (extra.senha || extra.frase ? r.erro + ' ' : '') + 'Fica só na memória do painel enquanto ele estiver aberto. Não é gravada.', fields: [{ id: 'senha', label: r.extra && r.extra.rotulo || 'Senha', type: 'password', required: true }], yes: 'Conectar', onSubmit: (v) => conectar(Object.assign({}, extra, r.codigo === 'frase' ? { frase: v.senha } : { senha: v.senha })) });
    drawBar(); return;
  }
  s.erro = r.erro || 'Não consegui conectar.'; drawBar();
}
async function desconectar() { const s = st(proj().id); await req('desconectar', {}); s.conectados.delete(s.conexao); s.remoto = lado0(); drawBar(); drawPane('remoto'); }

/* ---------- largura das colunas e divisor entre os painéis ---------- */
const COL = { tam: [84, 50, 220], mod: [118, 70, 260], perm: [92, 60, 160] };
function aplicaCol(lado, k, px) { paneEl[lado].style.setProperty('--c-' + k, px + 'px'); }
function carregaCols() {
  for (const lado of ['local', 'remoto']) for (const k of Object.keys(COL)) { const v = +LS('painel-arq-col-' + lado + '-' + k); if (v) aplicaCol(lado, k, Math.min(COL[k][2], Math.max(COL[k][1], v))); }
}
function grip(lado, k) {
  return h('span', { class: 'fgrip', title: 'Arraste para ajustar a largura. Duplo clique restaura', 'aria-hidden': 'true',
    onclick: (e) => e.stopPropagation(),
    ondblclick: (e) => { e.stopPropagation(); paneEl[lado].style.removeProperty('--c-' + k); LS('painel-arq-col-' + lado + '-' + k, '0'); },
    onpointerdown: (e) => {
      e.preventDefault(); e.stopPropagation();
      const g = e.currentTarget, cel = g.parentElement, x0 = e.clientX, w0 = cel.getBoundingClientRect().width;
      g.setPointerCapture(e.pointerId); g.classList.add('drag');
      let w = w0;
      const mv = (ev) => { w = Math.round(Math.min(COL[k][2], Math.max(COL[k][1], w0 + (x0 - ev.clientX)))); aplicaCol(lado, k, w); };
      const up = () => { g.classList.remove('drag'); g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); LS('painel-arq-col-' + lado + '-' + k, String(w)); };
      g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up);
    } });
}
function aplicaDivisao(r) {
  r = Math.min(0.8, Math.max(0.2, r));
  panesEl.style.setProperty('--fp-a', (r * 100).toFixed(1) + 'fr');
  panesEl.style.setProperty('--fp-b', ((1 - r) * 100).toFixed(1) + 'fr');
  splitEl.setAttribute('aria-valuenow', String(Math.round(r * 100)));
  return r;
}
let splitEl, razao = 0.5;
function montaDivisor() {
  splitEl = h('div', { class: 'fsplit', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', 'aria-label': 'Largura dos painéis: seu computador e servidor. Setas esquerda e direita ajustam, Home restaura', 'aria-valuemin': '20', 'aria-valuemax': '80', 'aria-valuenow': '50', title: 'Arraste para ajustar. Duplo clique restaura' });
  panesEl.insertBefore(splitEl, paneEl.remoto);
  const salva = () => LS('painel-arq-split', String(razao));
  razao = +LS('painel-arq-split') || 0.5; razao = aplicaDivisao(razao);
  splitEl.addEventListener('pointerdown', (e) => {
    e.preventDefault(); splitEl.setPointerCapture(e.pointerId); splitEl.classList.add('drag');
    const mv = (ev) => { const r = panesEl.getBoundingClientRect(); razao = aplicaDivisao((ev.clientX - r.left) / r.width); };
    const up = () => { splitEl.classList.remove('drag'); splitEl.removeEventListener('pointermove', mv); splitEl.removeEventListener('pointerup', up); salva(); };
    splitEl.addEventListener('pointermove', mv); splitEl.addEventListener('pointerup', up);
  });
  splitEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); razao = aplicaDivisao(razao + (e.key === 'ArrowRight' ? 0.03 : -0.03)); salva(); }
    else if (e.key === 'Home') { e.preventDefault(); razao = aplicaDivisao(0.5); salva(); }
  });
  splitEl.addEventListener('dblclick', () => { razao = aplicaDivisao(0.5); salva(); });
}

/* ---------- painéis ---------- */
function ordenados(L) {
  const { k, asc } = L.ordem, f = asc ? 1 : -1;
  return L.itens.slice().sort((a, b) => {
    if ((a.tipo === 'dir') !== (b.tipo === 'dir')) return a.tipo === 'dir' ? -1 : 1;
    let r;
    if (k === 'tam') r = a.tam - b.tam; else if (k === 'mod') r = a.mod - b.mod; else r = a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true, sensitivity: 'base' });
    return (r || a.nome.localeCompare(b.nome, 'pt-BR')) * f;
  });
}
function drawPane(lado) {
  const p = proj(); if (!p) return;
  const s = st(p.id), L = s[lado], el = listEl[lado];
  const foco = document.activeElement === el;
  pathEl[lado].value = L.caminho || '';
  paneEl[lado].querySelector('[data-k=enviar],[data-k=baixar]').disabled = !L.sel.size || (lado === 'local' ? false : false);
  if (lado === 'remoto' && !conectado()) {
    el.replaceChildren(h('div', { class: 'fempty' }, h('p', null, cx() ? 'Conecte ao servidor para ver e enviar arquivos.' : 'Sem conexão cadastrada.'), cx() ? h('button', { type: 'button', class: 'btn primary', onclick: () => conectar({}) }, 'Conectar') : null));
    footEl[lado].textContent = ''; return;
  }
  const cab = h('div', { class: 'frow fcab', role: 'presentation' },
    ...[['nome', 'Nome'], ['tam', 'Tamanho'], ['mod', 'Modificado']].map(([k, t]) => h('div', { class: 'fhc ' + k },
      h('button', { type: 'button', class: 'fcol ' + k, 'aria-sort': L.ordem.k === k ? (L.ordem.asc ? 'ascending' : 'descending') : 'none', onclick: () => { L.ordem = { k, asc: L.ordem.k === k ? !L.ordem.asc : true }; drawPane(lado); } }, t, L.ordem.k === k ? (L.ordem.asc ? ' ▲' : ' ▼') : ''),
      k === 'nome' ? null : grip(lado, k))),
    lado === 'remoto' ? h('div', { class: 'fhc perm' }, h('span', { class: 'fcol perm' }, 'Permissões'), grip(lado, 'perm')) : null);
  const linhas = ordenados(L).map((it) => {
    const sel = L.sel.has(it.nome);
    return h('div', { class: 'frow' + (sel ? ' sel' : ''), role: 'option', 'aria-selected': String(sel), draggable: 'true', 'data-nome': it.nome, 'data-dir': it.tipo === 'dir' ? '1' : '0',
      onclick: (e) => clique(lado, it.nome, e), ondblclick: () => { if (it.tipo === 'dir') ir(lado, junta(L.caminho, it.nome)); },
      ondragstart: (e) => {
        if (!L.sel.has(it.nome)) { L.sel = new Set([it.nome]); drawPane(lado); }
        arrasto = { lado, nomes: [...L.sel] };
        e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', arrasto.nomes.join('\n'));
      }, ondragend: () => { arrasto = null; paneEl.local.classList.remove('alvo'); paneEl.remoto.classList.remove('alvo'); } },
      h('span', { class: 'fcol nome' }, h('span', { class: 'fic ' + it.tipo }, A.icon(it.tipo === 'dir' ? 'folder' : 'file')), h('span', { class: 'fnome' }, it.nome, it.link ? h('span', { class: 'flink', title: 'Atalho (link simbólico)' }, ' ↪') : null)),
      h('span', { class: 'fcol tam' }, it.tipo === 'dir' ? '' : fmtTam(it.tam)),
      h('span', { class: 'fcol mod' }, fmtData(it.mod)),
      lado === 'remoto' ? h('span', { class: 'fcol perm mono' }, it.perm) : null);
  });
  const acima = L.caminho && L.caminho !== '/' ? h('div', { class: 'frow fup', role: 'option', 'aria-selected': 'false', 'data-nome': '..', 'data-dir': '1', title: 'Voltar para a pasta anterior (duplo clique ou Backspace)', ondblclick: () => subir(lado), onclick: () => { L.sel = new Set(); L.ancora = null; drawPane(lado); } },
    h('span', { class: 'fcol nome' }, h('span', { class: 'fic dir' }, A.icon('folder')), h('span', { class: 'fnome' }, '..')), h('span', { class: 'fcol tam' }), h('span', { class: 'fcol mod' }), lado === 'remoto' ? h('span', { class: 'fcol perm' }) : null) : null;
  const corpo = [cab, acima, ...linhas].filter(Boolean);
  if (L.carregando) corpo.push(h('div', { class: 'fmsg' }, 'Carregando…'));
  else if (!L.itens.length && L.carregado) corpo.push(h('div', { class: 'fmsg' }, 'Pasta vazia.'));
  const rolagem = el.scrollTop;
  el.replaceChildren(...corpo);
  el.scrollTop = rolagem;
  if (foco) el.focus();
  const nd = L.itens.filter((i) => i.tipo === 'dir').length;
  footEl[lado].textContent = L.itens.length + ' itens (' + nd + ' pastas)' + (L.sel.size ? ' · ' + L.sel.size + ' selecionado' + (L.sel.size > 1 ? 's' : '') : '');
}
function clique(lado, nome, e) {
  const L = st(proj().id)[lado];
  const ord = ordenados(L).map((i) => i.nome);
  if (e.shiftKey && L.ancora && ord.includes(L.ancora)) {
    const a = ord.indexOf(L.ancora), b = ord.indexOf(nome);
    L.sel = new Set(ord.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (e.ctrlKey || e.metaKey) { if (L.sel.has(nome)) L.sel.delete(nome); else L.sel.add(nome); L.ancora = nome; }
  else { L.sel = new Set([nome]); L.ancora = nome; }
  drawPane(lado);
}
async function ir(lado, caminho) {
  const p = proj(); if (!p) return;
  const s = st(p.id), L = s[lado];
  L.carregando = true; drawPane(lado);
  const r = await req('ls', { lado, caminho });
  if (!proj() || proj().id !== p.id) return;
  L.carregando = false;
  if (r.ok) {
    L.caminho = r.caminho; L.itens = r.itens; L.sel = new Set(); L.ancora = null; L.carregado = true;
    LS(lado === 'local' ? 'painel-arq-l-' + p.id : 'painel-arq-r-' + p.id + '-' + s.conexao, r.caminho);
  } else if (r.codigo === 'desconectado') { s.conectados.delete(s.conexao); drawBar(); }
  else A.toast(r.erro || 'Não consegui abrir essa pasta.', true);
  drawPane(lado);
}
const subir = (lado) => { const L = st(proj().id)[lado]; if (L.caminho) ir(lado, pai(L.caminho)); };
function tecla(lado, e) {
  const L = st(proj().id)[lado];
  const ord = ordenados(L), uni = ord.find((i) => L.sel.has(i.nome));
  if (e.key === 'Enter' && uni && uni.tipo === 'dir' && L.sel.size === 1) { e.preventDefault(); ir(lado, junta(L.caminho, uni.nome)); }
  else if (e.key === 'Backspace') { e.preventDefault(); subir(lado); }
  else if (e.key === 'Delete') { e.preventDefault(); apagar(lado); }
  else if (e.key === 'F2') { e.preventDefault(); renomear(lado); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); L.sel = new Set(L.itens.map((i) => i.nome)); drawPane(lado); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!ord.length) return;
    const i = ord.findIndex((x) => x.nome === L.ancora);
    const n = Math.max(0, Math.min(ord.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)));
    const nome = ord[n].nome;
    if (e.shiftKey && L.ancora) { const a = ord.findIndex((x) => x.nome === L.ancora); L.sel = new Set(ord.slice(Math.min(a, n), Math.max(a, n) + 1).map((x) => x.nome)); }
    else { L.sel = new Set([nome]); L.ancora = nome; }
    drawPane(lado);
    const row = listEl[lado].querySelector('[data-nome="' + CSS.escape(nome) + '"]'); if (row) row.scrollIntoView({ block: 'nearest' });
  }
}

/* ---------- criar, renomear, apagar ---------- */
function novaPasta(lado) {
  const s = st(proj().id), L = s[lado];
  if (!L.caminho) return;
  A.modal({ title: 'Nova pasta', text: 'Em ' + L.caminho, fields: [{ id: 'nome', label: 'Nome da pasta', required: true }], yes: 'Criar',
    onSubmit: async (v) => {
      const nome = v.nome.trim();
      if (nome.includes('/')) return A.toast('O nome não pode ter “/”.', true);
      const r = await req('mkdir', { lado, caminho: junta(L.caminho, nome) });
      if (!r.ok) A.toast(r.erro, true); else ir(lado, L.caminho);
    } });
}
function renomear(lado) {
  const s = st(proj().id), L = s[lado];
  if (L.sel.size !== 1) return A.toast('Selecione um item para renomear.', true);
  const antigo = [...L.sel][0];
  A.modal({ title: 'Renomear', fields: [{ id: 'nome', label: 'Novo nome', value: antigo, required: true }], yes: 'Renomear',
    onSubmit: async (v) => {
      const nome = v.nome.trim();
      if (nome === antigo) return;
      if (nome.includes('/')) return A.toast('O nome não pode ter “/”.', true);
      const r = await req('renomear', { lado, de: junta(L.caminho, antigo), para: junta(L.caminho, nome) });
      if (!r.ok) A.toast(r.erro, true); else ir(lado, L.caminho);
    } });
}
function apagar(lado) {
  const s = st(proj().id), L = s[lado], nomes = [...L.sel];
  if (!nomes.length) return A.toast('Selecione o que você quer excluir.', true);
  const c = cx(), remoto = lado === 'remoto', amb = remoto && c ? c.ambiente : '';
  const onde = remoto ? 'no servidor' + (amb ? ' de ' + AMB[amb] : '') : 'do seu computador';
  const lista = nomes.slice(0, 6).join(', ') + (nomes.length > 6 ? ' e mais ' + (nomes.length - 6) : '');
  const fazer = async () => {
    const r = await req('apagar', { lado, caminhos: nomes.map((n) => junta(L.caminho, n)) });
    if (!r.ok) A.toast(r.erro, true); else A.toast(nomes.length + (nomes.length > 1 ? ' itens excluídos.' : ' item excluído.'));
    ir(lado, L.caminho);
  };
  const dica = 'Pastas são excluídas com tudo que há dentro. Não vai para a lixeira e não dá para desfazer.';
  if (amb === 'producao') {
    A.modal({ tone: 'prod', title: 'Excluir ' + nomes.length + (nomes.length > 1 ? ' itens' : ' item') + ' ' + onde + '?', text: lista + '. ' + dica,
      fields: [{ id: 'conf', label: 'Digite apagar para confirmar', required: true, equals: 'apagar' }], yes: 'Excluir em produção', no: 'Cancelar', onSubmit: fazer });
  } else {
    A.confirmar({ tone: amb ? 'hml' : 'danger', title: 'Excluir ' + nomes.length + (nomes.length > 1 ? ' itens' : ' item') + ' ' + onde + '?', text: lista + '. ' + dica, yes: 'Excluir', no: 'Cancelar' }, fazer);
  }
}

/* ---------- transferências ---------- */
function acaoTransf(direcao) {
  const s = st(proj().id);
  if (!conectado()) return A.toast('Conecte ao servidor primeiro.', true);
  const origem = direcao === 'enviar' ? s.local : s.remoto, destino = direcao === 'enviar' ? s.remoto : s.local;
  if (!origem.sel.size) return A.toast('Selecione o que você quer ' + (direcao === 'enviar' ? 'enviar' : 'baixar') + '.', true);
  transferir(direcao, [...origem.sel], destino.caminho);
}
async function transferir(direcao, nomes, destDir) {
  const p = proj(), s = st(p.id);
  if (!conectado()) return A.toast('Conecte ao servidor primeiro.', true);
  const origem = direcao === 'enviar' ? s.local : s.remoto;
  const itens = nomes.map((n) => ({ origem: junta(origem.caminho, n), destino: junta(destDir, n) }));
  const ladoDest = direcao === 'enviar' ? 'remoto' : 'local';
  const ex = await req('existe', { lado: ladoDest, caminhos: itens.map((i) => i.destino) });
  if (!ex.ok) return A.toast(ex.erro, true);
  const c = cx(), amb = direcao === 'enviar' && c ? c.ambiente : '';
  const sub = ex.existentes.map((x) => x.slice(x.lastIndexOf('/') + 1));
  const go = async (sobrescrever) => {
    const r = await req('transferir', { direcao, itens, sobrescrever });
    if (!r.ok) A.toast(r.erro, true); else { s.fila = true; A.toast(itens.length + (itens.length > 1 ? ' itens na fila.' : ' item na fila.')); }
  };
  const destTxt = direcao === 'enviar' ? 'no servidor' + (amb ? ' (' + AMB[amb] + ')' : '') : 'no seu computador';
  const lista = (l) => l.slice(0, 6).join(', ') + (l.length > 6 ? ' e mais ' + (l.length - 6) : '');
  if (sub.length) {
    A.confirmar({ tone: amb === 'producao' ? 'prod' : amb === 'homologacao' ? 'hml' : 'danger', title: 'Substituir ' + sub.length + (sub.length > 1 ? ' itens' : ' item') + ' ' + destTxt + '?',
      text: 'Já existe: ' + lista(sub) + '. Pastas são mescladas e arquivos com o mesmo nome são substituídos. Os outros itens do envio entram normalmente.', yes: 'Substituir', no: 'Cancelar' }, () => go(true));
  } else if (amb) {
    A.confirmar({ tone: amb === 'producao' ? 'prod' : 'hml', title: 'Enviar ' + itens.length + (itens.length > 1 ? ' itens' : ' item') + ' para ' + AMB[amb] + '?', text: lista(nomes) + ' → ' + destDir, yes: amb === 'producao' ? 'Enviar para produção' : 'Enviar para homologação', no: 'Cancelar' }, () => go(false));
  } else go(false);
}
function drawQueue() {
  const p = proj(); if (!p || !queueEl) return;
  const s = st(p.id), js = [...s.jobs.values()];
  if (!js.length) { queueEl.replaceChildren(h('div', { class: 'qhead' }, h('span', null, 'Transferências'), h('span', { class: 'qdica' }, 'Arraste arquivos de um lado para o outro, ou selecione e use Enviar / Baixar.'))); return; }
  const ativos = js.filter((j) => j.status === 'fila' || j.status === 'andando').length;
  const rows = js.slice().reverse().map((j) => {
    const pct = j.total ? Math.min(100, Math.round(j.feito / j.total * 100)) : (j.status === 'ok' ? 100 : 0);
    const txt = j.status === 'ok' ? 'Concluído · ' + fmtTam(j.total) : j.status === 'erro' ? j.erro : j.status === 'cancelado' ? 'Cancelado' : j.status === 'fila' ? 'Na fila' : pct + '% · ' + fmtTam(j.feito) + ' de ' + fmtTam(j.total);
    return h('div', { class: 'qrow ' + j.status },
      h('span', { class: 'qdir', title: j.direcao === 'enviar' ? 'Envio' : 'Download' }, A.icon(j.direcao === 'enviar' ? 'upload' : 'download')),
      h('span', { class: 'qnome' }, j.nome),
      h('div', { class: 'qbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Progresso de ' + j.nome }, h('div', { class: 'qfill', style: 'width:' + pct + '%' })),
      h('span', { class: 'qtxt' }, txt),
      j.status === 'fila' || j.status === 'andando' ? h('button', { type: 'button', class: 'icon', title: 'Cancelar', 'aria-label': 'Cancelar ' + j.nome, onclick: () => req('cancelar', { job: j.id }) }, A.icon('close')) : h('span', { class: 'qpad' }));
  });
  queueEl.replaceChildren(
    h('div', { class: 'qhead' }, h('span', null, 'Transferências' + (ativos ? ' (' + ativos + ' em andamento)' : '')),
      h('button', { type: 'button', class: 'link', onclick: async () => { await req('limpar', {}); for (const [id, j] of s.jobs) if (j.status !== 'fila' && j.status !== 'andando') s.jobs.delete(id); drawQueue(); } }, 'Limpar concluídas')),
    h('div', { class: 'qlist' }, rows));
}
const atualizar = {};
function jobMudou(j) {
  const s = st(j.projeto), antes = s.jobs.get(j.id);
  s.jobs.set(j.id, j);
  if (proj() && proj().id === j.projeto) drawQueue();
  if (antes && antes.status !== j.status && proj() && proj().id === j.projeto) {
    if (j.status === 'ok') {
      const lado = j.direcao === 'enviar' ? 'remoto' : 'local';
      clearTimeout(atualizar[lado]); atualizar[lado] = setTimeout(() => { if (proj() && proj().id === j.projeto && j.conexao === st(j.projeto).conexao) ir(lado, st(j.projeto)[lado].caminho || '~'); }, 400);
    } else if (j.status === 'erro') A.toast('Falhou: ' + j.nome + '. ' + j.erro, true);
  }
}

/* ---------- ligação com o app ---------- */
async function mostrar() {
  const p = proj(); if (!p) return;
  pid = p.id;
  const s = st(p.id);
  if (!barEl) montar();
  drawBar(); drawPane('local'); drawPane('remoto'); drawQueue();
  const e = await req('estado', {});
  if (e.ok && proj() && proj().id === p.id) {
    s.conectados = new Set(e.conectado.map((x) => x.conexao));
    for (const j of e.jobs) s.jobs.set(j.id, j);
    drawBar(); drawQueue();
  }
  if (!s.local.carregado) await ir('local', LS('painel-arq-l-' + p.id) || p.pasta);
  if (conectado() && !s.remoto.carregado) await ir('remoto', salvoRemoto() || '~'); else drawPane('remoto');
}
function on(m) {
  if (m.t === 'fs-r') { const f = pend.get(m.rid); if (f) { pend.delete(m.rid); f(m); } }
  else if (m.t === 'fs-job') jobMudou(m.job);
  else if (m.t === 'fs-estado') {
    const s = st(m.projeto);
    if (m.conectado) s.conectados.add(m.conexao);
    else { const eraEsta = s.conexao === m.conexao && s.conectados.has(m.conexao); s.conectados.delete(m.conexao); if (eraEsta) { s.remoto = lado0(); if (proj() && proj().id === m.projeto) A.toast('A conexão com o servidor foi encerrada.', true); } }
    if (proj() && proj().id === m.projeto && !root.hidden) { drawBar(); drawPane('remoto'); }
  }
}
window.Arquivos = { init(api) { A = api; root = api.root; }, mostrar, on, abrir(id) { const p = proj(); if (!p) return; st(p.id).conexao = id; LS('painel-arq-conn-' + p.id, id); st(p.id).remoto = lado0(); }, redraw() { if (barEl && proj()) { drawBar(); drawPane('local'); drawPane('remoto'); drawQueue(); } } };
})();
