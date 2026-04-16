#!/usr/bin/env bash
# ============================================================
#  Outdoor Patio Supplies — Dashboard Installer
#  Target: Raspberry Pi OS (Debian/Ubuntu-based Linux)
#  Usage : bash install-linux-rasp.sh
# ============================================================
set -e

DASHBOARD_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PORT=3000

# Guard: must be Linux
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "❌  Este script é para Linux/Raspberry Pi."
  echo "    Para macOS use: bash install-macos.sh"
  exit 1
fi

echo "============================================================"
echo "  Outdoor Patio Supplies — Dashboard Installer (Linux/RPi)"
echo "============================================================"
echo ""

# ── 1. System update ──────────────────────────────────────────────────────────
echo "[1/6] Atualizando sistema (apt update + upgrade)..."
sudo apt-get update -y
sudo apt-get upgrade -y

# ── 2. System dependencies ────────────────────────────────────────────────────
echo "[2/6] Instalando dependências do sistema..."
sudo apt-get install -y \
  curl \
  ca-certificates \
  gnupg \
  chromium-browser \
  unclutter

# ── 3. Node.js 20 LTS (via NodeSource) ───────────────────────────────────────
echo "[3/6] Instalando Node.js 20 LTS..."
if ! command -v node &>/dev/null || [[ "$(node -e 'process.exit(+process.versions.node.split(".")[0])')" -ne 0 && "$(node --version | cut -d. -f1 | tr -d 'v')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "   Node.js $(node --version) já instalado — OK"
fi

# ── 4. PM2 ───────────────────────────────────────────────────────────────────
echo "[4/6] Instalando PM2..."
sudo npm install -g pm2

# ── 5. Dependências do projeto ────────────────────────────────────────────────
echo "[5/6] Instalando dependências do projeto..."
cd "$DASHBOARD_DIR"
npm install

# Iniciar / reiniciar app com PM2
pm2 describe patio-dashboard &>/dev/null && pm2 restart patio-dashboard || \
  pm2 start server.js --name patio-dashboard

# Salvar lista de processos e configurar autostart no boot
pm2 save
sudo env PATH="$PATH:/usr/bin" \
  pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | sudo bash || true

echo ""
echo "[5/6] PM2 configurado. Status:"
pm2 status patio-dashboard

# ── 6. Chromium kiosk (autostart via LXDE / systemd) ─────────────────────────
echo "[6/6] Configurando Chromium kiosk..."

# Aguarda o servidor subir
MAX_WAIT=30
ELAPSED=0
until curl -sf "http://localhost:${APP_PORT}/healthz" &>/dev/null; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  if [[ $ELAPSED -ge $MAX_WAIT ]]; then
    echo "   Aviso: servidor ainda não respondeu após ${MAX_WAIT}s — continuando mesmo assim."
    break
  fi
done

# LXDE autostart (Raspberry Pi OS com desktop)
AUTOSTART_DIR="$HOME/.config/lxsession/LXDE-pi"
AUTOSTART_FILE="$AUTOSTART_DIR/autostart"

mkdir -p "$AUTOSTART_DIR"

# Remove entradas antigas do kiosk se existirem
if [[ -f "$AUTOSTART_FILE" ]]; then
  sed -i '/unclutter/d;/chromium/d' "$AUTOSTART_FILE"
fi

cat >> "$AUTOSTART_FILE" <<EOF

# Patio Dashboard kiosk
@unclutter -idle 0.5 -root
@chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --disable-session-crashed-bubble --disable-restore-session-state \
  --check-for-update-interval=604800 \
  http://localhost:${APP_PORT}
EOF

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
echo "  O Chromium abrirá automaticamente no próximo boot."
echo "  Para abrir agora (ambiente desktop):"
echo "    chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:${APP_PORT}"
echo ""
