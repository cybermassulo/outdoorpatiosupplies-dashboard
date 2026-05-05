#!/usr/bin/env bash
# ============================================================
#  Outdoor Patio Supplies — Dashboard Installer
#  Target: macOS (Homebrew)
#  Usage : bash install-macos.sh
# ============================================================
set -e

DASHBOARD_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PORT=3000

# Guard: must be macOS
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌  Este script é para macOS."
  echo "    Para Linux/Raspberry Pi use: bash install-linux-rasp.sh"
  exit 1
fi

echo "============================================================"
echo "  Outdoor Patio Supplies — Dashboard Installer (macOS)"
echo "============================================================"
echo ""

# ── 0. Atualizar código do repositório ───────────────────────────────────────
echo "[0/5] Atualizando código (git pull)..."
cd "$DASHBOARD_DIR"
if git rev-parse --is-inside-work-tree &>/dev/null; then
  git pull --ff-only || echo "   ⚠️  git pull falhou — continuando com o código atual."
else
  echo "   Diretório não é um repositório git — pulando."
fi

# ── 1. Homebrew ───────────────────────────────────────────────────────────────
echo "[1/5] Verificando Homebrew..."
if ! command -v brew &>/dev/null; then
  echo "   Homebrew não encontrado — instalando..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for Apple Silicon
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
else
  echo "   Homebrew $(brew --version | head -1) — OK"
fi

# ── 2. Node.js 20 LTS ─────────────────────────────────────────────────────────
echo "[2/5] Verificando Node.js 20+..."
NODE_MAJOR=0
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node --version | cut -d. -f1 | tr -d 'v')
fi

if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "   Instalando Node.js 20 LTS via Homebrew..."
  brew install node@20
  # Link if not already linked
  brew link --overwrite node@20 2>/dev/null || true
  # Add to PATH for this session
  export PATH="$(brew --prefix node@20)/bin:$PATH"
else
  echo "   Node.js $(node --version) — OK"
fi

# ── 3. PM2 ───────────────────────────────────────────────────────────────────
echo "[3/5] Instalando PM2..."
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
else
  echo "   PM2 $(pm2 --version) — OK"
fi

# ── 4. Dependências do projeto ────────────────────────────────────────────────
echo "[4/5] Instalando dependências do projeto..."
cd "$DASHBOARD_DIR"
npm install

# Verificar .env
if [[ ! -f "$DASHBOARD_DIR/.env" ]]; then
  echo ""
  echo "⚠️   Arquivo .env não encontrado!"
  echo "    Copie .env.example para .env e preencha ECWID_STORE_ID e ECWID_TOKEN."
  echo "    O servidor não vai iniciar sem essas variáveis."
  echo ""
fi

# Iniciar / reiniciar com PM2
pm2 describe patio-dashboard &>/dev/null \
  && pm2 restart patio-dashboard \
  || pm2 start "$DASHBOARD_DIR/server.js" --name patio-dashboard

# Salvar lista de processos
pm2 save

# Configurar autostart no boot (launchd)
echo ""
echo "   Configurando PM2 para iniciar no boot (launchd)..."
pm2 startup launchd 2>/dev/null | tail -1 | bash || echo "   ⚠️  Autostart não configurado — execute manualmente: pm2 startup launchd"

echo ""
echo "   Status PM2:"
pm2 status patio-dashboard

# ── 5. Abrir no browser ───────────────────────────────────────────────────────
echo "[5/5] Aguardando servidor iniciar..."
MAX_WAIT=30
ELAPSED=0
until curl -sf "http://localhost:${APP_PORT}/healthz" &>/dev/null; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  if [[ $ELAPSED -ge $MAX_WAIT ]]; then
    echo "   ⚠️  Servidor ainda não respondeu após ${MAX_WAIT}s."
    echo "      Verifique: pm2 logs patio-dashboard"
    break
  fi
done

if curl -sf "http://localhost:${APP_PORT}/healthz" &>/dev/null; then
  echo "   Servidor OK — abrindo no browser..."
  open "http://localhost:${APP_PORT}"
fi

echo ""
echo "============================================================"
echo "  Instalação concluída!"
echo "============================================================"
echo ""
echo "  Dashboard  : http://localhost:${APP_PORT}"
echo "  Telemetria : http://localhost:${APP_PORT}/telemetry.html"
echo "  PM2 status : pm2 status"
echo "  PM2 logs   : pm2 logs patio-dashboard"
echo ""
echo "  Para parar : pm2 stop patio-dashboard"
echo "  Para reiniciar depois de editar server.js:"
echo "               pm2 restart patio-dashboard"
echo ""
echo "  ⚠️  Lembre de criar o .env com ECWID_STORE_ID e ECWID_TOKEN"
echo "     (e opcionalmente GA4_PROPERTY_ID + ga4-credentials.json)"
