#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const rootDir = path.join(__dirname, '..');
const pkg = require(path.join(rootDir, 'package.json'));

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function requiredEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function trimSlashes(value) {
  return String(value || '').trim().replace(/^\/+|\/+$/g, '');
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function normalizeUrl(value, name) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return trimTrailingSlash(new URL(withProtocol).toString());
  } catch (_) {
    throw new Error(`${name} must be a valid URL, e.g. https://oss-cn-hongkong.aliyuncs.com. Received: ${raw}`);
  }
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function numberValue(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`version must be SemVer without leading v: ${version}`);
  }
}

function joinUrl(base, key) {
  return `${trimTrailingSlash(base)}/${String(key).replace(/^\/+/, '')}`;
}

function contentTypeFor(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (lower.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.appimage')) return 'application/octet-stream';
  if (lower.endsWith('.blockmap')) return 'application/octet-stream';
  if (lower.endsWith('.7z')) return 'application/x-7z-compressed';
  return 'application/octet-stream';
}

function fileTypeFor(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.blockmap')) return 'blockmap';
  if (lower.endsWith('.7z')) return 'package';
  if (lower.endsWith('.zip')) return 'archive';
  if (lower.endsWith('.exe') || lower.endsWith('.dmg') || lower.endsWith('.appimage')) return 'installer';
  return 'full';
}

function shouldUploadFile(fileName) {
  const lower = fileName.toLowerCase();
  return (
    lower.endsWith('.exe')
    || lower.endsWith('.dmg')
    || lower.endsWith('.zip')
    || lower.endsWith('.appimage')
    || lower.endsWith('.blockmap')
    || lower.endsWith('.7z')
  );
}

function collectFiles(releaseDir) {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`release directory not found: ${releaseDir}`);
  }
  return fs.readdirSync(releaseDir)
    .filter((fileName) => shouldUploadFile(fileName))
    .map((fileName) => {
      const absPath = path.join(releaseDir, fileName);
      const stat = fs.statSync(absPath);
      return stat.isFile() ? { fileName, absPath, size: stat.size } : null;
    })
    .filter(Boolean);
}

function choosePrimary(files, platform, primaryPattern) {
  if (primaryPattern) {
    const pattern = new RegExp(primaryPattern, 'i');
    const matched = files.find((file) => pattern.test(file.fileName));
    if (!matched) throw new Error(`APP_MARKET_PRIMARY_PATTERN did not match any artifact: ${primaryPattern}`);
    return matched;
  }

  const lowerPlatform = String(platform || '').toLowerCase();
  const byExt = (ext) => files.filter((file) => file.fileName.toLowerCase().endsWith(ext));
  if (lowerPlatform === 'darwin' || lowerPlatform === 'macos') {
    return byExt('.zip')[0] || byExt('.dmg')[0];
  }
  if (lowerPlatform === 'linux') {
    return byExt('.appimage')[0];
  }
  const exeFiles = byExt('.exe');
  return exeFiles.find((file) => /setup/i.test(file.fileName)) || exeFiles[0];
}

function hashesFor(filePath) {
  const buffer = fs.readFileSync(filePath);
  return {
    sha512: crypto.createHash('sha512').update(buffer).digest('base64'),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function createS3Client() {
  const endpoint = normalizeUrl(requiredEnv('OSS_ENDPOINT'), 'OSS_ENDPOINT');
  return new S3Client({
    endpoint,
    region: env('OSS_REGION', 'us-east-1'),
    forcePathStyle: boolValue(env('OSS_FORCE_PATH_STYLE'), true),
    credentials: {
      accessKeyId: requiredEnv('OSS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('OSS_ACCESS_KEY_SECRET'),
    },
  });
}

async function uploadArtifacts(files, options) {
  const client = createS3Client();
  const bucket = requiredEnv('OSS_BUCKET');
  const publicBase = normalizeUrl(
    env('OSS_PUBLIC_BASE_URL')
      || env('OSS_BASE_URL')
      || `${normalizeUrl(requiredEnv('OSS_ENDPOINT'), 'OSS_ENDPOINT')}/${bucket}`,
    'OSS_PUBLIC_BASE_URL'
  );

  for (const file of files) {
    const key = [
      trimSlashes(env('OSS_BASE_DIR', 'app-market')),
      options.appKey,
      options.channel,
      options.version,
      options.platform,
      options.arch,
      file.fileName,
    ].filter(Boolean).map(trimSlashes).join('/');

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(file.absPath),
      ContentType: contentTypeFor(file.fileName),
    }));

    Object.assign(file, hashesFor(file.absPath), {
      key,
      downloadUrl: joinUrl(publicBase, key),
      fileType: fileTypeFor(file.fileName),
    });
    console.log(`Uploaded ${file.fileName} -> ${file.downloadUrl}`);
  }
}

async function publishRelease(payload) {
  const apiUrl = trimTrailingSlash(requiredEnv('ORCHESTRATION_API_URL'));
  const apiKey = requiredEnv('ORCHESTRATION_API_KEY');
  const res = await fetch(`${apiUrl}/api/v1/app-market/releases/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`publish failed: HTTP ${res.status} ${text}`);
  }
  console.log(`Published release ${payload.app_key} ${payload.platform}/${payload.arch} ${payload.version}`);
  console.log(text);
}

async function main() {
  if (typeof fetch !== 'function') {
    throw new Error('Node.js global fetch is required');
  }

  const version = env('APP_MARKET_VERSION', pkg.version);
  assertSemver(version);

  const options = {
    appKey: env('APP_MARKET_APP_KEY', pkg.updateAppKey || 'overseas-drama-desktop'),
    appName: env('APP_MARKET_APP_NAME', pkg.build?.productName || pkg.name),
    appType: env('APP_MARKET_APP_TYPE', 'desktop'),
    vendor: env('APP_MARKET_VENDOR', pkg.author || 'OverseasDrama'),
    platform: env('APP_MARKET_PLATFORM', process.platform),
    arch: env('APP_MARKET_ARCH', process.arch),
    channel: env('APP_MARKET_CHANNEL', 'stable'),
    version,
    artifactKind: env('APP_MARKET_ARTIFACT_KIND', 'installer'),
  };

  const releaseDir = path.resolve(rootDir, env('APP_MARKET_RELEASE_DIR', 'release'));
  const files = collectFiles(releaseDir);
  const primary = choosePrimary(files, options.platform, env('APP_MARKET_PRIMARY_PATTERN'));
  if (!primary) throw new Error(`no primary artifact found in ${releaseDir}`);

  await uploadArtifacts(files, options);
  for (const file of files) {
    if (!/^https:\/\//i.test(file.downloadUrl)) {
      throw new Error(`download_url must be HTTPS for app-market release: ${file.downloadUrl}`);
    }
  }

  const blockmap = files.find((file) => file.fileName === `${primary.fileName}.blockmap`);
  const stagingPercentage = numberValue(env('APP_MARKET_STAGING_PERCENTAGE', env('APP_MARKET_ROLLOUT', '100')), 100);
  const releaseNotes = env('APP_MARKET_RELEASE_NOTES');
  const minSupportedVersion = env('APP_MARKET_MIN_SUPPORTED_VERSION');

  const payload = {
    app_key: options.appKey,
    app_name: options.appName,
    app_type: options.appType,
    vendor: options.vendor,
    platform: options.platform,
    arch: options.arch,
    channel: options.channel,
    version: options.version,
    download_url: primary.downloadUrl,
    file_name: primary.fileName,
    size_bytes: primary.size,
    sha512: primary.sha512,
    sha256: primary.sha256,
    blockmap_size: blockmap ? blockmap.size : undefined,
    release_notes: releaseNotes || undefined,
    commit_sha: env('APP_MARKET_COMMIT_SHA', env('GITHUB_SHA')) || undefined,
    build_number: env('APP_MARKET_BUILD_NUMBER', env('GITHUB_RUN_NUMBER')) || undefined,
    artifact_kind: options.artifactKind,
    status: env('APP_MARKET_STATUS', 'active'),
    force_update: boolValue(env('APP_MARKET_FORCE_UPDATE'), false),
    min_supported_version: minSupportedVersion || undefined,
    rollout: stagingPercentage,
    staging_percentage: stagingPercentage,
    files: files
      .filter((file) => file !== primary)
      .map((file) => ({
        file_name: file.fileName,
        file_type: file.fileType,
        download_url: file.downloadUrl,
        size_bytes: file.size,
        sha512: file.sha512,
        sha256: file.sha256,
        blockmap_size: file.fileType === 'blockmap' ? file.size : undefined,
        is_primary: false,
      })),
    metadata: {
      repository: env('GITHUB_REPOSITORY') || undefined,
      run_id: env('GITHUB_RUN_ID') || undefined,
      ref_name: env('GITHUB_REF_NAME') || undefined,
      primary_file: primary.fileName,
      oss_key: primary.key,
    },
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined || payload[key] === '') delete payload[key];
  });

  await publishRelease(payload);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
