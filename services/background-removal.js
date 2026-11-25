// Background removal for floor plan (and other) images, behind a swappable
// provider abstraction. Selection is driven entirely by env config:
//
//   BG_REMOVAL_PROVIDER = removebg | clipdrop | none   (default: none)
//   BG_REMOVAL_API_KEY  = <provider API key>
//
// Adding a provider = one more entry in PROVIDERS below; nothing else changes.
// Every provider takes an image buffer and returns a PNG buffer with the
// background removed (transparent). Callers must treat failures as
// non-fatal: the original image is always kept as the fallback.

const REQUEST_TIMEOUT_MS = 30 * 1000;

async function callProviderApi({ url, apiKeyHeader, apiKey, fileField, extraFields = {} }, buffer, contentType) {
    const form = new FormData();
    form.append(fileField, new Blob([buffer], { type: contentType }), 'image');
    for (const [k, v] of Object.entries(extraFields)) form.append(k, v);

    const res = await fetch(url, {
        method: 'POST',
        headers: { [apiKeyHeader]: apiKey },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Background removal API responded ${res.status}: ${body.slice(0, 300)}`);
    }

    const out = Buffer.from(await res.arrayBuffer());
    if (!out.length) throw new Error('Background removal API returned an empty body');
    return out;
}

const PROVIDERS = {
    removebg: {
        name: 'Remove.bg',
        removeBackground: (buffer, contentType, apiKey) => callProviderApi({
            url: 'https://api.remove.bg/v1.0/removebg',
            apiKeyHeader: 'X-Api-Key',
            apiKey,
            fileField: 'image_file',
            extraFields: { size: 'auto', format: 'png' },
        }, buffer, contentType),
    },
    clipdrop: {
        name: 'Clipdrop',
        removeBackground: (buffer, contentType, apiKey) => callProviderApi({
            url: 'https://clipdrop-api.co/remove-background/v1',
            apiKeyHeader: 'x-api-key',
            apiKey,
            fileField: 'image_file',
        }, buffer, contentType),
    },
};

function activeProviderId() {
    const id = String(process.env.BG_REMOVAL_PROVIDER || '').trim().toLowerCase();
    if (!id || id === 'none') return null;
    return id;
}

export function isBackgroundRemovalEnabled() {
    const id = activeProviderId();
    return Boolean(id && PROVIDERS[id] && process.env.BG_REMOVAL_API_KEY?.trim());
}

export function getBackgroundRemovalProviderName() {
    const id = activeProviderId();
    return id && PROVIDERS[id] ? PROVIDERS[id].name : null;
}

/**
 * Remove the background of an image via the configured provider.
 * Returns `{ buffer, contentType: 'image/png' }`.
 * Throws when no provider is configured or the provider call fails —
 * callers are expected to catch and fall back to the original image.
 */
export async function removeImageBackground(buffer, contentType = 'image/png') {
    const id = activeProviderId();
    if (!id) throw new Error('Background removal is not enabled (BG_REMOVAL_PROVIDER unset)');

    const provider = PROVIDERS[id];
    if (!provider) throw new Error(`Unknown background removal provider "${id}" (expected one of: ${Object.keys(PROVIDERS).join(', ')})`);

    const apiKey = process.env.BG_REMOVAL_API_KEY?.trim();
    if (!apiKey) throw new Error(`BG_REMOVAL_API_KEY is not set for provider "${id}"`);

    const out = await provider.removeBackground(buffer, contentType, apiKey);
    return { buffer: out, contentType: 'image/png' };
}
