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

function defaultForcePathStyle(endpoint) {
  const host = new URL(endpoint).hostname.toLowerCase();
  if (host.endsWith('.aliyuncs.com')) return false;
  return false;
}

function buildDefaultPublicBase(endpoint, bucket, forcePathStyle) {
  const bucketName = trimSlashes(bucket);
  if (forcePathStyle) return `${endpoint}/${bucketName}`;

  const url = new URL(endpoint);
  if (!url.hostname.toLowerCase().startsWith(`${bucketName.toLowerCase()}.`)) {
    url.host = `${bucketName}.${url.host}`;
  }
  return trimTrailingSlash(url.toString());
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
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.icns')) return 'image/icns';
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

function filterFiles(files, filePattern) {
  if (!filePattern) return files;
  const pattern = new RegExp(filePattern, 'i');
  const matched = files.filter((file) => pattern.test(file.fileName));
  if (!matched.length) {
    throw new Error(`APP_MARKET_FILE_PATTERN did not match any artifact: ${filePattern}`);
  }
  return matched;
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
  const endpoint = normalizeUrl(requiredEnv('S3_ENDPOINT'), 'S3_ENDPOINT');
  const forcePathStyle = boolValue(env('S3_FORCE_PATH_STYLE'), defaultForcePathStyle(endpoint));
  return new S3Client({
    endpoint,
    region: env('S3_REGION', 'us-east-1'),
    forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: requiredEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('S3_SECRET_ACCESS_KEY'),
    },
  });
}

function createUploadContext() {
  const client = createS3Client();
  const bucket = requiredEnv('S3_BUCKET');
  const endpoint = normalizeUrl(requiredEnv('S3_ENDPOINT'), 'S3_ENDPOINT');
  const forcePathStyle = boolValue(env('S3_FORCE_PATH_STYLE'), defaultForcePathStyle(endpoint));
  const publicBase = normalizeUrl(
    env('S3_PUBLIC_BASE_URL')
      || env('S3_BASE_URL')
      || buildDefaultPublicBase(endpoint, bucket, forcePathStyle),
    'S3_PUBLIC_BASE_URL'
  );
  const baseDir = trimSlashes(env('S3_BASE_DIR', 'app-market'));
  return { client, bucket, publicBase, baseDir };
}

async function putS3File(context, filePath, key, contentType) {
  const stat = fs.statSync(filePath);
  const body = fs.readFileSync(filePath);
  await context.client.send(new PutObjectCommand({
    Bucket: context.bucket,
    Key: key,
    Body: body,
    ContentLength: stat.size,
    ContentType: contentType,
  }));
  return {
    key,
    size: stat.size,
    downloadUrl: joinUrl(context.publicBase, key),
  };
}

async function uploadArtifacts(files, options, context) {
  for (const file of files) {
    const key = [
      context.baseDir,
      options.appKey,
      options.channel,
      options.version,
      options.platform,
      options.arch,
      file.fileName,
    ].filter(Boolean).map(trimSlashes).join('/');

    const uploaded = await putS3File(context, file.absPath, key, contentTypeFor(file.fileName));
    Object.assign(file, hashesFor(file.absPath), {
      key: uploaded.key,
      downloadUrl: uploaded.downloadUrl,
      fileType: fileTypeFor(file.fileName),
    });
    console.log(`Uploaded ${file.fileName} -> ${file.downloadUrl}`);
  }
}

function resolveAppIconPath() {
  const candidates = [
    env('APP_MARKET_ICON_PATH'),
    path.join(rootDir, '..', 'frontweb', 'public', 'favicon.png'),
    path.join(rootDir, 'assets', 'icons', 'icon.png'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || '';
}

async function uploadAppIcon(options, context) {
  const iconPath = resolveAppIconPath();
  if (!iconPath) return '';
  const fileName = path.basename(iconPath);
  const key = [
    context.baseDir,
    options.appKey,
    'icons',
    fileName,
  ].filter(Boolean).map(trimSlashes).join('/');
  const uploaded = await putS3File(context, iconPath, key, contentTypeFor(fileName));
  console.log(`Uploaded app icon ${fileName} -> ${uploaded.downloadUrl}`);
  return uploaded.downloadUrl;
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
  const files = filterFiles(collectFiles(releaseDir), env('APP_MARKET_FILE_PATTERN'));
  const primary = choosePrimary(files, options.platform, env('APP_MARKET_PRIMARY_PATTERN'));
  if (!primary) throw new Error(`no primary artifact found in ${releaseDir}`);

  const uploadContext = createUploadContext();
  await uploadArtifacts(files, options, uploadContext);
  const iconUrl = await uploadAppIcon(options, uploadContext);
  for (const file of files) {
    if (!/^https:\/\//i.test(file.downloadUrl)) {
      throw new Error(`download_url must be HTTPS for app-market release: ${file.downloadUrl}`);
    }
  }
  if (iconUrl && !/^https:\/\//i.test(iconUrl)) {
    throw new Error(`icon_url must be HTTPS for app-market release: ${iconUrl}`);
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
    icon_url: iconUrl || undefined,
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
