#!/usr/bin/env bash
set -euo pipefail

# Register and install the LocalMiniDrama self-hosted runner on CentOS 7.
# Run as root after generating a fresh GitHub runner token:
#   sudo bash configure-localminidrama-runner.sh <github-runner-token>

APP_USER="${APP_USER:-btcfoxman}"
RUNNER_DIR="${RUNNER_DIR:-/home/btcfoxman/actions-runners/repo-localminidrama}"
RUNNER_LABEL="${RUNNER_LABEL:-repo-localminidrama}"
REPO_URL="${REPO_URL:-https://github.com/btcfoxman/LocalMiniDrama}"
RUNNER_LIB_DIR="${RUNNER_LIB_DIR:-/opt/localminidrama-runner-libs}"

TOKEN="${1:-}"
if [ -z "${TOKEN}" ]; then
  echo "ERROR: missing GitHub runner token."
  echo "Usage: sudo bash $0 <github-runner-token>"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: please run as root."
  exit 1
fi

if [ ! -d "${RUNNER_DIR}" ]; then
  echo "ERROR: runner directory not found: ${RUNNER_DIR}"
  exit 1
fi

if [ ! -f "${RUNNER_LIB_DIR}/libstdc++.so.6" ]; then
  echo "ERROR: runner compatibility libstdc++ not found: ${RUNNER_LIB_DIR}/libstdc++.so.6"
  echo "Run prepare-drama-host.sh first on CentOS 7."
  exit 1
fi

cd "${RUNNER_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${RUNNER_DIR}"

echo "[1/4] Registering runner..."
set +e
register_output="$(
  su -s /bin/bash -c "LD_LIBRARY_PATH=${RUNNER_LIB_DIR} ./config.sh --unattended --replace --url ${REPO_URL} --token ${TOKEN} --name ${RUNNER_LABEL} --labels ${RUNNER_LABEL} --work _work" "${APP_USER}" 2>&1
)"
register_code=$?
set -e
printf '%s\n' "${register_output}"
if [ "${register_code}" -ne 0 ]; then
  if printf '%s\n' "${register_output}" | grep -q 'Http response code: NotFound'; then
    echo
    echo "ERROR: GitHub rejected the runner token with 404 Not Found."
    echo "Generate a fresh repository runner token from:"
    echo "  https://github.com/btcfoxman/LocalMiniDrama/settings/actions/runners/new"
    echo "Then rerun:"
    echo "  sudo bash $0 <fresh-github-runner-token>"
  fi
  exit "${register_code}"
fi

echo "[2/4] Installing service..."
if [ -f ".service" ] && [ -f "./svc.sh" ]; then
  ./svc.sh stop || true
  ./svc.sh uninstall || true
fi
./svc.sh install "${APP_USER}"

echo "[3/4] Applying CentOS 7 compatible systemd unit..."
svc_name="$(cat .service)"
unit_path="/etc/systemd/system/${svc_name}"
cp -n "${unit_path}" "${unit_path}.bak-localminidrama" || true
cat > "${unit_path}" <<UNIT
[Unit]
Description=GitHub Actions Runner (btcfoxman-LocalMiniDrama.repo-localminidrama)
After=network-online.target

[Service]
ExecStart=${RUNNER_DIR}/run.sh
User=${APP_USER}
WorkingDirectory=${RUNNER_DIR}
Environment=LD_LIBRARY_PATH=${RUNNER_LIB_DIR}
Environment=RUNNER_MANUALLY_TRAP_SIG=1
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=5min
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
chmod 664 "${unit_path}"
systemctl daemon-reload

echo "[4/4] Starting service..."
./svc.sh start
./svc.sh status
