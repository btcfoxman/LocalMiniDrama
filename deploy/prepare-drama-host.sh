#!/usr/bin/env bash
set -euo pipefail

# LocalMiniDrama deployment host initializer.
# Run on 192.168.3.6 as root:
#   sudo bash /home/btcfoxman/docker/drama/prepare-drama-host.sh
#
# This script is idempotent. It creates the drama deployment directory,
# writes docker-compose.yml, creates a production config template if missing,
# and checks the dedicated GitHub Actions runner directory.
#
# Runner convention for future repositories:
#   /home/btcfoxman/actions-runners/repo-<repo-name>
#   label: repo-<repo-name>

APP_USER="${APP_USER:-btcfoxman}"
APP_DIR="${APP_DIR:-/home/btcfoxman/docker/drama}"
RUNNER_DIR="${RUNNER_DIR:-/home/btcfoxman/actions-runners/repo-localminidrama}"
RUNNER_LABEL="${RUNNER_LABEL:-repo-localminidrama}"
RUNNER_LIB_DIR="${RUNNER_LIB_DIR:-/opt/localminidrama-runner-libs}"
LIBSTDCXX_NG_URL="${LIBSTDCXX_NG_URL:-https://conda.anaconda.org/conda-forge/linux-64/libstdcxx-ng-12.2.0-h46fd767_19.tar.bz2}"

CONFIG_DIR="${APP_DIR}/config"
DATA_DIR="${APP_DIR}/data"
STORAGE_DIR="${APP_DIR}/storage-cache"
LOG_DIR="${APP_DIR}/logs"

GHCR_OWNER="${GHCR_OWNER:-btcfoxman}"
GHCR_REPO="${GHCR_REPO:-localminidrama}"
FRONT_IMAGE="ghcr.io/${GHCR_OWNER}/${GHCR_REPO}/drama-frontweb:test-latest"
BACKEND_IMAGE="ghcr.io/${GHCR_OWNER}/${GHCR_REPO}/drama-backend:test-latest"

RUSTFS_ACCESS_KEY="${RUSTFS_ACCESS_KEY:-CHANGE_ME}"
RUSTFS_SECRET_KEY="${RUSTFS_SECRET_KEY:-CHANGE_ME}"

prepare_centos7_runner_runtime() {
  if [ ! -f /etc/centos-release ] || ! grep -q ' 7\.' /etc/centos-release; then
    return 0
  fi

  echo "Preparing CentOS 7 runtime dependencies for GitHub Actions runner..."
  yum install -y libicu krb5-libs openssl-libs zlib bzip2 >/dev/null

  if [ ! -f "${RUNNER_LIB_DIR}/libstdc++.so.6" ]; then
    local work_dir
    work_dir="$(mktemp -d /tmp/localminidrama-libstdcxx.XXXXXX)"
    mkdir -p "${RUNNER_LIB_DIR}"
    curl -fL --retry 3 --connect-timeout 20 -o "${work_dir}/libstdcxx-ng.tar.bz2" "${LIBSTDCXX_NG_URL}"
    tar -xjf "${work_dir}/libstdcxx-ng.tar.bz2" -C "${work_dir}"
    cp -f "${work_dir}/lib/libstdc++.so.6.0.30" "${RUNNER_LIB_DIR}/libstdc++.so.6.0.30"
    ln -sfn libstdc++.so.6.0.30 "${RUNNER_LIB_DIR}/libstdc++.so.6"
    chmod 755 "${RUNNER_LIB_DIR}"
    chmod 644 "${RUNNER_LIB_DIR}/libstdc++.so.6.0.30"
    rm -rf "${work_dir}"
  fi

  if [ -f "${RUNNER_DIR}/bin/Runner.Listener" ]; then
    LD_LIBRARY_PATH="${RUNNER_LIB_DIR}" "${RUNNER_DIR}/bin/Runner.Listener" --version >/dev/null
  fi
}

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: please run this script as root."
  exit 1
fi

echo "[1/10] Checking required commands..."
command -v docker >/dev/null
command -v curl >/dev/null
docker version >/dev/null
docker compose version >/dev/null

echo "[2/10] Ensuring application user exists..."
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "${APP_USER}"
fi

echo "[3/10] Ensuring docker group permission..."
if ! getent group docker >/dev/null; then
  groupadd docker
fi
if ! id -nG "${APP_USER}" | tr ' ' '\n' | grep -qx docker; then
  usermod -aG docker "${APP_USER}"
  echo "Added ${APP_USER} to docker group. Restart the runner service after registration."
fi

echo "[4/10] Checking Docker access as ${APP_USER}..."
if su -s /bin/bash -c 'docker ps >/dev/null' "${APP_USER}"; then
  echo "${APP_USER} can access Docker."
else
  echo "WARN: ${APP_USER} cannot access Docker yet. If the user was just added to docker group, restart any existing runner service."
fi

echo "[5/10] Creating deployment directories..."
mkdir -p "${CONFIG_DIR}" "${DATA_DIR}" "${STORAGE_DIR}" "${LOG_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

echo "[6/10] Checking dedicated runner directory..."
if [ -d "${RUNNER_DIR}" ]; then
  for runner_file in config.sh run.sh; do
    if [ ! -f "${RUNNER_DIR}/${runner_file}" ]; then
      echo "WARN: ${RUNNER_DIR}/${runner_file} is missing."
    fi
  done
  if [ -f "${RUNNER_DIR}/.runner" ]; then
    if [ ! -f "${RUNNER_DIR}/svc.sh" ]; then
      echo "WARN: runner is configured but ${RUNNER_DIR}/svc.sh is missing; service install may be unavailable."
    fi
  else
    echo "Runner archive is present but not registered yet. Register it with GitHub before installing the service."
  fi
  chown -R "${APP_USER}:${APP_USER}" "${RUNNER_DIR}"
  prepare_centos7_runner_runtime
else
  echo "WARN: runner directory does not exist: ${RUNNER_DIR}"
  echo "Create one runner directory per repository, for example: /home/btcfoxman/actions-runners/repo-other"
fi

echo "[7/10] Checking port 3013..."
if ss -ltn | awk 'NR > 1 { print $4 }' | grep -Eq '(^|:)3013$'; then
  if docker ps --format '{{.Names}} {{.Ports}}' | grep -E '^drama-frontweb ' | grep -q '3013'; then
    echo "Port 3013 is already used by drama-frontweb; keeping it."
  else
    echo "ERROR: port 3013 is already in use by another process."
    ss -ltnp | grep ':3013' || true
    exit 1
  fi
fi

echo "[8/10] Checking RustFS TCP endpoint 192.168.3.6:9000..."
if timeout 3 bash -c '</dev/tcp/192.168.3.6/9000' 2>/dev/null; then
  echo "RustFS TCP endpoint is reachable."
else
  echo "WARN: RustFS TCP endpoint is not reachable from this host."
fi

echo "[9/10] Writing docker-compose.yml..."
cat > "${APP_DIR}/docker-compose.yml" <<COMPOSE
services:
  drama-backend:
    image: ${BACKEND_IMAGE}
    container_name: drama-backend
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: "5679"
      TZ: Asia/Taipei
      LOG_FILE: /app/backend-node/logs/backend.log
    volumes:
      - ./config/config.yaml:/app/backend-node/configs/config.yaml:ro
      - ./data:/app/backend-node/data
      - ./storage-cache:/app/backend-node/data/storage-cache
      - ./logs:/app/backend-node/logs
    expose:
      - "5679"
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:5679/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s

  drama-frontweb:
    image: ${FRONT_IMAGE}
    container_name: drama-frontweb
    restart: unless-stopped
    depends_on:
      drama-backend:
        condition: service_healthy
    ports:
      - "3013:80"
COMPOSE

if [ ! -f "${CONFIG_DIR}/config.yaml" ]; then
  echo "[10/10] Writing config/config.yaml template..."
  cat > "${CONFIG_DIR}/config.yaml" <<CONFIG
app:
  name: LocalMiniDrama API
  version: 1.0.0
  debug: false
  language: zh

server:
  port: 5679
  host: 0.0.0.0
  cors_origins:
    - http://192.168.3.6:3013
    - http://localhost:3013
  read_timeout: 600
  write_timeout: 600

database:
  type: sqlite
  path: ./data/drama_generator.db
  max_idle: 10
  max_open: 100

storage:
  type: s3
  local_path: ./data/storage-cache
  base_url: http://192.168.3.6:9000/localminidrama
  public_base_url: http://192.168.3.6:9000/localminidrama
  endpoint: http://192.168.3.6:9000
  bucket: localminidrama
  region: us-east-1
  force_path_style: true
  public_read: true
  access_key_id: ${RUSTFS_ACCESS_KEY}
  secret_access_key: ${RUSTFS_SECRET_KEY}

ai:
  default_text_provider: openai
  default_image_provider: openai
  default_video_provider: doubao

style:
  default_style: ''
  default_role_style: full body and face clearly visible, character centered, consistent facial features, high detail, masterpiece, best quality
  default_scene_style: wide establishing shot, highly detailed environment, sharp focus, rich atmosphere, masterpiece, best quality
  default_prop_style: object centered, clean simple background, studio lighting, sharp focus, high detail
  default_image_ratio: '16:9'
  default_video_ratio: '16:9'
  default_prop_ratio: '1:1'
  default_image_size: 1024x1024

vendor_lock:
  enabled: false
  config_file: ai-configs-qudao.json
CONFIG
  chmod 600 "${CONFIG_DIR}/config.yaml"
else
  echo "[10/10] config/config.yaml already exists; keeping it unchanged."
fi

chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

echo
echo "Done."
echo "Runner setup reminder:"
echo "  cd ${RUNNER_DIR}"
echo "  sudo bash ${APP_DIR}/configure-localminidrama-runner.sh <github-runner-token>"
echo
echo "Deployment checks:"
echo "  sudo -u ${APP_USER} docker ps"
echo "  cd ${APP_DIR} && docker compose config"
echo "  docker login ghcr.io -u <github-username>"
echo "  docker compose pull && docker compose up -d"
