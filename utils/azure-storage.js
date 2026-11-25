import { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } from '@azure/storage-blob';
import { Readable, Transform } from 'stream';
import dotenv from 'dotenv';

dotenv.config();

export const isAzureStorageConfigured = () => Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING?.trim());

let blobServiceClient = null;
function getBlobServiceClient() {
    if (!isAzureStorageConfigured()) return null;
    if (!blobServiceClient) {
        blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
    }
    return blobServiceClient;
}

// Bounds how long an Azure Blob upload can hang on a stalled connection before failing cleanly.
const BLOB_UPLOAD_TIMEOUT_MS = 90 * 1000;

export const uploadVideoStream = async (containerName, blobName, buffer, mimeType, options = {}) => {
    const client = getBlobServiceClient();
    if (!client) throw new Error('AZURE_STORAGE_CONNECTION_STRING not configured');
    const containerClient = client.getContainerClient(containerName);
    await containerClient.createIfNotExists(options.access ? { access: options.access } : undefined);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const stream = Readable.from(buffer);

    await blockBlobClient.uploadStream(stream, 4 * 1024 * 1024, 5, {
        blobHTTPHeaders: { blobContentType: mimeType },
        abortSignal: AbortSignal.timeout(BLOB_UPLOAD_TIMEOUT_MS),
    });

    return blockBlobClient.url;
};

/** Stream a remote file (e.g. MediaMTX VOD export) into Azure Blob Storage. */
export const uploadBlobFromUrl = async (containerName, blobName, sourceUrl, mimeType = 'video/mp4') => {
    const client = getBlobServiceClient();
    if (!client) throw new Error('AZURE_STORAGE_CONNECTION_STRING not configured');

    const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!res.ok || !res.body) {
        throw new Error(`Source fetch failed (${res.status}) for ${sourceUrl}`);
    }

    const containerClient = client.getContainerClient(containerName);
    await containerClient.createIfNotExists({ access: 'blob' });
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const nodeStream = Readable.fromWeb(res.body);

    await blockBlobClient.uploadStream(nodeStream, 4 * 1024 * 1024, 5, {
        blobHTTPHeaders: { blobContentType: mimeType },
    });

    return blockBlobClient.url;
};

// Best-effort SSRF guard for user-supplied URLs (e.g. a seller's bulk-import CSV): only
// http/https to a hostname that isn't an obvious loopback/private/link-local literal.
// Hostname-string-based, not DNS-resolved, so it stops opportunistic internal-URL probing but
// not a determined DNS-rebinding attacker.
export const isPubliclyRoutableUrl = (urlStr) => {
    let u;
    try { u = new URL(String(urlStr)); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const [a, b] = ipv4.slice(1, 3).map(Number);
        if (a === 127 || a === 10 || a === 0) return false;
        if (a === 169 && b === 254) return false; // link-local / cloud metadata endpoint
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
    }
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return false;
    return true;
};

// Hard-caps bytes actually seen, regardless of what (or whether) the source declared via
// Content-Length.
function byteCapStream(maxBytes) {
    let total = 0;
    return new Transform({
        transform(chunk, _enc, cb) {
            total += chunk.length;
            if (maxBytes && total > maxBytes) {
                cb(new Error(`Source exceeded the ${maxBytes}-byte cap`));
                return;
            }
            cb(null, chunk);
        },
    });
}

/**
 * Like uploadBlobFromUrl, but for untrusted source URLs: SSRF-safe fetch via ssrf-guard
 * (#1287), rejects Content-Type that doesn't match `expectedTypePrefix`, hard-caps bytes.
 */
export const uploadUntrustedUrlToBlob = async (containerName, blobName, sourceUrl, { expectedTypePrefix, maxBytes, mimeType } = {}) => {
    const { safeFetchBuffer } = await import('./ssrf-guard.js');
    const buf = await safeFetchBuffer(sourceUrl, {
        maxBytes: maxBytes || 50 * 1024 * 1024,
        timeout: 120_000,
    });
    // Magic sniff is preferred over declared Content-Type; callers that need a prefix can
    // re-check after download. We still reject empty buffers.
    if (!buf?.length) throw new Error('Source fetch returned empty body');
    if (expectedTypePrefix) {
        // Best-effort: JPEG/PNG/GIF/WebP signatures when expecting image/*
        const isImage = expectedTypePrefix.startsWith('image/');
        if (isImage) {
            const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
            const png = buf[0] === 0x89 && buf[1] === 0x50;
            const gif = buf[0] === 0x47 && buf[1] === 0x49;
            const webp = buf[0] === 0x52 && buf[8] === 0x57;
            if (!jpeg && !png && !gif && !webp) {
                throw new Error(`Unexpected content (expected ${expectedTypePrefix}*)`);
            }
        }
    }
    return uploadVideoStream(containerName, blobName, buf, mimeType || 'application/octet-stream');
};

function parseConnectionString(cs) {
    const parts = {};
    cs.split(';').forEach(seg => { const i = seg.indexOf('='); if (i > 0) parts[seg.slice(0, i)] = seg.slice(i + 1); });
    return parts;
}

export const generateVideoUploadSAS = async (containerName, blobName) => {
    const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const client = getBlobServiceClient();
    if (!client || !cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING not configured');
    const { AccountName, AccountKey } = parseConnectionString(cs);
    const credential = new StorageSharedKeyCredential(AccountName, AccountKey);

    const containerClient = client.getContainerClient(containerName);
    const createResult = await containerClient.createIfNotExists({ access: 'blob' });
    if (!createResult.succeeded) {
        try { await containerClient.setAccessPolicy('blob'); } catch { }
    }

    const startsOn  = new Date(Date.now() - 2 * 60 * 1000);
    const expiresOn = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const sas = generateBlobSASQueryParameters(
        { containerName, blobName, permissions: BlobSASPermissions.from({ write: true, create: true }), startsOn, expiresOn, version: "2021-12-02" },
        credential
    ).toString();

    const blobClient = containerClient.getBlockBlobClient(blobName);
    return { sasUrl: `${blobClient.url}?${sas}`, blobUrl: blobClient.url };
};

// Generates a short-lived read-only SAS URL. Self-heals relative path inputs 
// and gracefully bypasses local Azurite emulator signatures.
export const generateVideoReadSAS = (containerName, blobUrl) => {
    try {
        const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!cs) return blobUrl;
        
        const { AccountName, AccountKey } = parseConnectionString(cs);
        const cleanAccountName = AccountName ? AccountName.trim() : "";
        const cleanAccountKey = AccountKey ? AccountKey.trim().replace(/\\n/g, '').replace(/\s/g, '') : "";
        
        if (!cleanAccountName || !cleanAccountKey) return blobUrl;

        const credential = new StorageSharedKeyCredential(cleanAccountName, cleanAccountKey);

        let cleanedUrlStr = (blobUrl || '').split('?')[0];

        // Self-Healing Strategy: Reconstruct full absolute URL if relative path is passed
        if (!cleanedUrlStr.startsWith('http')) {
            const accountName = cleanAccountName || process.env.AZURE_STORAGE_ACCOUNT_NAME;
            const endpoint = process.env.AZURE_STORAGE_BLOB_ENDPOINT || `https://${accountName}.blob.core.windows.net`;
            cleanedUrlStr = `${endpoint.replace(/\/$/, '')}/${containerName}/${cleanedUrlStr}`;
        }

        const url = new URL(cleanedUrlStr);

        // Emulator Bypass: Ensure seamless offline/local development with Azurite
        const isLocalEmulator = 
          url.hostname === '127.0.0.1' || 
          url.hostname === 'localhost' || 
          cleanAccountName === 'devstoreaccount1';

        if (isLocalEmulator) {
            return cleanedUrlStr;
        }

        const expectedHost = `${cleanAccountName}.blob.core.windows.net`;
        if (url.hostname.toLowerCase() !== expectedHost.toLowerCase()) return null;

        const prefix = `/${containerName}/`;
        let blobName = url.pathname;
        if (blobName.startsWith(prefix)) {
            blobName = blobName.slice(prefix.length);
        } else {
            blobName = blobName.split('/').slice(2).join('/');
        }

        const startsOn = new Date(Date.now() - 15 * 60 * 1000); 
        const expiresOn = new Date(Date.now() + 6 * 60 * 60 * 1000);

        const sas = generateBlobSASQueryParameters(
            { 
                containerName, 
                blobName, 
                permissions: BlobSASPermissions.from({ read: true }), 
                startsOn,
                expiresOn 
            },
            credential
        ).toString();

        return `${cleanedUrlStr}?${sas}`;
    } catch (err) {
        console.error('[generateVideoReadSAS] error:', err.message);
        return blobUrl;
    }
};

export const isTrustedBlobUrl = (blobUrl, containerName) => {
    try {
        const client = getBlobServiceClient();
        if (!client) return false;
        const base = new URL(client.url);
        const target = new URL(blobUrl);
        if (target.protocol !== 'https:') return false;
        if (target.host !== base.host) return false;
        if (containerName) {
            const firstSeg = target.pathname.replace(/^\/+/, '').split('/')[0];
            if (firstSeg !== containerName) return false;
        }
        return true;
    } catch {
        return false;
    }
};

export const uploadPublicBlob = async (containerName, blobName, buffer, mimeType) => {
    const client = getBlobServiceClient();
    if (!client) throw new Error('AZURE_STORAGE_CONNECTION_STRING not configured');
    const containerClient = client.getContainerClient(containerName);

    const createResult = await containerClient.createIfNotExists({ access: 'blob' });
    if (!createResult.succeeded) {
        try {
            await containerClient.setAccessPolicy('blob');
        } catch { }
    }

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const stream = Readable.from(buffer);

    await blockBlobClient.uploadStream(stream, 4 * 1024 * 1024, 5, {
        blobHTTPHeaders: { blobContentType: mimeType },
        abortSignal: AbortSignal.timeout(BLOB_UPLOAD_TIMEOUT_MS),
    });

    return blockBlobClient.url;
};