#!/usr/bin/env bash
# Instala o Painel de Comando: dependências, ícone na área de trabalho, no menu e início automático.
# Uso: bash install.sh            instala
#      bash install.sh --remover  remove ícone e início automático (seus dados em ~/.config/painel ficam)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HOME/.config/painel"
APPS="$HOME/.local/share/applications"
AUTO="$HOME/.config/autostart"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
ARQ="painel-de-comando.desktop"

if [ "${1:-}" = "--remover" ]; then
  rm -f "$APPS/$ARQ" "$AUTO/$ARQ" "$DESK/$ARQ"
  echo "Removi o ícone e o início automático. Seus dados continuam em $CFG."
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "Não encontrei o Node. Instale o Node 18 ou mais novo e rode de novo."; exit 1; fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then echo "Preciso do Node 18 ou mais novo (o seu é $("$NODE_BIN" -v))."; exit 1; fi

echo "→ Instalando dependências…"
( cd "$DIR" && npm install --omit=dev --no-audit --no-fund )
chmod +x "$DIR/bin/painel" "$DIR/bin/shim/gnome-terminal"

# O Electron baixa o próprio binário na instalação; se isso falhou em silêncio, tenta de novo.
if [ ! -x "$DIR/node_modules/electron/dist/electron" ]; then
  echo "→ Baixando a janela nativa (Electron)…"
  ( cd "$DIR" && "$NODE_BIN" node_modules/electron/install.js ) || true
fi
if [ -x "$DIR/node_modules/electron/dist/electron" ]; then
  echo "✓ Janela nativa pronta."
else
  echo "! Não consegui baixar o Electron. O painel vai abrir num navegador baseado em Chromium (Chrome, Brave, Edge, Vivaldi ou Opera)."
fi

mkdir -p "$CFG" "$APPS" "$AUTO"; chmod 700 "$CFG"
printf 'PAINEL_NODE="%s"\n' "$NODE_BIN" > "$CFG/env"

conteudo() {
cat <<EOF
[Desktop Entry]
Type=Application
Name=Painel de Comando
Comment=Ações, terminais e informações de cada projeto
Exec="$DIR/bin/painel"
Icon=$DIR/public/icone.png
StartupWMClass=painel-de-comando
Terminal=false
Categories=Development;
StartupNotify=false
EOF
}
conteudo > "$APPS/$ARQ"
{ conteudo; echo "X-GNOME-Autostart-Delay=3"; } > "$AUTO/$ARQ"
if [ -d "$DESK" ]; then
  conteudo > "$DESK/$ARQ"; chmod +x "$DESK/$ARQ"
  command -v gio >/dev/null 2>&1 && gio set "$DESK/$ARQ" metadata::trusted true 2>/dev/null || true
fi
chmod +x "$APPS/$ARQ"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true

echo
echo "Pronto. O ícone “Painel de Comando” está na área de trabalho e no menu de aplicativos."
echo "Ele também abre sozinho quando você entra na sessão."
echo "Se o ícone da área de trabalho aparecer como arquivo, clique com o botão direito e escolha “Permitir execução”."
echo "Para abrir agora: $DIR/bin/painel"
