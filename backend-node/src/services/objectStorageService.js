const fs = require('fs');
const path = require('path');

let clientCache = null;
let bucketEnsured = false;

function isS3Storage(storage) {
  return String(storage?.type || '').toLowerCase() === 's3';
}

function normalizeKey(key) {
  return String(key || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function getClient(storage) {
  if (!isS3Storage(storage)) return null;
  const signature = JSON.stringify({
    endpoint: storage.endpoint,
    region: storage.region,
    access_key_id: storage.access_key_id,
    force_path_style: storage.force_path_style,
    signing_host: storage.signing_host,
  });
  if (clientCache && clientCache.signature === signature) return clientCache.client;

  const { S3Client } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: storage.region || 'us-east-1',
    endpoint: storage.endpoint,
    forcePathStyle: storage.force_path_style !== false,
    credentials: {
      accessKeyId: storage.access_key_id || storage.accessKeyId || '',
      secretAccessKey: storage.secret_access_key || storage.secretAccessKey || '',
    },
  });
  configureSigningHostRewrite(client, storage);
  clientCache = { signature, client };
  bucketEnsured = false;
  return client;
}

function endpointHost(storage) {
  try {
    return new URL(storage.endpoint).host;
  } catch (_) {
    return '';
  }
}

function configureSigningHostRewrite(client, storage) {
  const signingHost = String(storage?.signing_host || storage?.signingHost || '').trim();
  const publicHost = endpointHost(storage);
  if (!signingHost || !publicHost || signingHost === publicHost) return;

  const { HttpRequest } = require('@smithy/protocol-http');
  client.middlewareStack.addRelativeTo(
    (next) => async (args) => {
      if (HttpRequest.isInstance(args.request)) {
        args.request.headers.host = signingHost;
      }
      return next(args);
    },
    {
      name: 'cloudflaredSigningHostBeforeAuth',
      relation: 'before',
      toMiddleware: 'awsAuthMiddleware',
      override: true,
    }
  );
  client.middlewareStack.addRelativeTo(
    (next) => async (args) => {
      if (HttpRequest.isInstance(args.request)) {
        args.request.headers.host = publicHost;
      }
      return next(args);
    },
    {
      name: 'cloudflaredSigningHostAfterAuth',
      relation: 'after',
      toMiddleware: 'awsAuthMiddleware',
      override: true,
    }
  );
}

function publicUrlForKey(storage, key) {
  const cleanKey = normalizeKey(key);
  if (!cleanKey) return '';
  const publicBase = storage?.public_base_url || storage?.base_url;
  if (publicBase) {
    return `${String(publicBase).replace(/\/$/, '')}/${cleanKey}`;
  }
  const endpoint = String(storage?.endpoint || '').replace(/\/$/, '');
  const bucket = storage?.bucket;
  return endpoint && bucket ? `${endpoint}/${bucket}/${cleanKey}` : '';
}

async function ensureBucket(storage, log) {
  if (!isS3Storage(storage) || bucketEnsured) return;
  const bucket = storage.bucket;
  if (!bucket) throw new Error('storage.bucket is required for s3 storage');

  const {
    HeadBucketCommand,
    CreateBucketCommand,
    PutBucketPolicyCommand,
  } = require('@aws-sdk/client-s3');
  const client = getClient(storage);
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (_) {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    log?.info?.('[storage] S3 bucket created', { bucket });
  }

  if (storage.public_read !== false) {
    try {
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${bucket}/*`],
          },
        ],
      };
      await client.send(new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify(policy),
      }));
    } catch (err) {
      log?.warn?.('[storage] S3 public-read policy skipped', { bucket, error: err.message });
    }
  }
  bucketEnsured = true;
}

async function uploadBuffer(storage, key, buffer, mimeType, log) {
  if (!isS3Storage(storage)) return '';
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const cleanKey = normalizeKey(key);
  await ensureBucket(storage, log);
  const client = getClient(storage);
  await client.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: cleanKey,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream',
  }));
  return publicUrlForKey(storage, cleanKey);
}

async function uploadFile(storage, key, filePath, mimeType, log) {
  if (!isS3Storage(storage)) return '';
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const cleanKey = normalizeKey(key);
  await ensureBucket(storage, log);
  const client = getClient(storage);
  await client.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: cleanKey,
    Body: fs.createReadStream(filePath),
    ContentType: mimeType || 'application/octet-stream',
  }));
  return publicUrlForKey(storage, cleanKey);
}

async function downloadToFile(storage, key, destPath, log) {
  if (!isS3Storage(storage)) return false;
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const cleanKey = normalizeKey(key);
  await ensureBucket(storage, log);
  const client = getClient(storage);
  const result = await client.send(new GetObjectCommand({
    Bucket: storage.bucket,
    Key: cleanKey,
  }));
  const chunks = [];
  for await (const chunk of result.Body) {
    chunks.push(Buffer.from(chunk));
  }
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(destPath, Buffer.concat(chunks));
  return true;
}

function keyFromPublicUrl(storage, rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw || !isS3Storage(storage)) return null;
  const cleanBases = [storage.public_base_url, storage.base_url]
    .filter(Boolean)
    .map((u) => String(u).replace(/\/$/, ''));
  for (const base of cleanBases) {
    if (raw.startsWith(base + '/')) {
      return normalizeKey(decodeURIComponent(raw.slice(base.length + 1)));
    }
  }
  try {
    const parsed = new URL(raw);
    const bucket = storage.bucket;
    const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === bucket) return normalizeKey(parts.slice(1).join('/'));
  } catch (_) {}
  return null;
}

module.exports = {
  isS3Storage,
  normalizeKey,
  publicUrlForKey,
  uploadBuffer,
  uploadFile,
  downloadToFile,
  keyFromPublicUrl,
  ensureBucket,
};
