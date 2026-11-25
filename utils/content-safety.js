import ContentSafetyClient from '@azure-rest/ai-content-safety';
import { AzureKeyCredential } from '@azure/core-auth';
import { safeFetchBuffer } from './ssrf-guard.js';

const endpoint = process.env.AZURE_CONTENT_SAFETY_ENDPOINT;
const key = process.env.AZURE_CONTENT_SAFETY_KEY;

const client = (endpoint && key) ? ContentSafetyClient(endpoint, new AzureKeyCredential(key)) : null;

// media_url can be attacker-controlled (advertiser sets it, then triggers a scan). Fetch it
// through the SSRF guard so it can't reach cloud metadata / internal services.
async function fetchImageBuffer(url) {
  return safeFetchBuffer(url, { maxBytes: 15 * 1024 * 1024, timeout: 8000 });
}

export async function analyzeImage(imageInput) {
  if (!client) {
    return { blocked: false, sensitive: false, safety_score: 1.0, categories: {} };
  }

  try {
    let buffer;
    if (Buffer.isBuffer(imageInput)) {
      buffer = imageInput;
    } else if (typeof imageInput === 'string' && /^https?:\/\//i.test(imageInput)) {
      buffer = await fetchImageBuffer(imageInput);
    } else {
      throw new Error('Invalid image input type');
    }

    const base64Image = buffer.toString('base64');

    const response = await client.path('/image:analyze').post({
      body: {
        image: { content: base64Image }
      }
    });

    if (response.status !== '200') {
      throw new Error(`Azure Content Safety API error: ${response.status}`);
    }

    const result = response.body;
    const categoriesAnalysis = result.categoriesAnalysis || [];

    let blocked = false;
    let sensitive = false;
    let maxSeverity = 0;
    const categories = {};

    for (const cat of categoriesAnalysis) {
      const name = String(cat.category).toLowerCase();
      const severity = Number(cat.severity || 0);
      categories[name] = severity;

      if (severity > maxSeverity) {
        maxSeverity = severity;
      }

      if (severity >= 4) {
        blocked = true;
      } else if (severity >= 2) {
        sensitive = true;
      }
    }

    const safetyScore = parseFloat((1.0 - (maxSeverity / 6.0)).toFixed(2));

    return {
      blocked,
      sensitive,
      safety_score: safetyScore,
      categories
    };
  } catch (err) {
    // Azure configured but scan failed — fail closed so unsafe media cannot ship during outage.
    // When Azure is not configured (client == null), analyzeImage returns early above and stays open for local/dev.
    console.error('[content-safety] scan failed (fail-closed):', err.message);
    return {
      blocked: true,
      sensitive: true,
      safety_score: 0,
      categories: {},
      error: 'scan_unavailable',
    };
  }
}

export const analyzeImageBuffer = analyzeImage;
export const analyzeImageUrl = analyzeImage;