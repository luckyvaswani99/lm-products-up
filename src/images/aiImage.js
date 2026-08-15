import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { config, requireKeys } from '../config.js';
import { log } from '../logger.js';
import { readAsDataUri } from './downloader.js';

/**
 * The faithful-copy brief: the model looks at the real product photo and
 * reproduces the *same* product (same packaging, brand text, colours, form)
 * as a clean studio e-commerce shot. We deliberately ask it NOT to invent
 * new branding, so the regenerated image still represents the real product.
 */
const PROMPT =
  'Recreate this exact product as a high-resolution e-commerce catalog photo. ' +
  'Keep the SAME product: identical packaging shape, brand name text, label wording, ' +
  'colours, dosage/strength text and physical form. Do not invent new branding or text. ' +
  'Place it centered on a clean pure-white studio background with soft, even lighting, ' +
  'sharp focus, subtle shadow, 1:1 square framing. No watermarks, no extra props.';

function mimeOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
}

// ---------------- provider: Gemini (image in -> image out) ----------------
async function gemini(sourceFile, outFile) {
  requireKeys([{ name: 'GEMINI_API_KEY', value: config.image.gemini.apiKey }]);
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: config.image.gemini.apiKey });
  const data = fs.readFileSync(sourceFile).toString('base64');
  const res = await ai.models.generateContent({
    model: config.image.gemini.model,
    contents: [
      { role: 'user', parts: [{ inlineData: { mimeType: mimeOf(sourceFile), data } }, { text: PROMPT }] },
    ],
  });
  const parts = res?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) throw new Error('Gemini returned no image (check model access / safety filters)');
  await fsp.writeFile(outFile, Buffer.from(img.inlineData.data, 'base64'));
  return outFile;
}

// ---------------- provider: OpenAI gpt-image-1 edit ----------------
async function openai(sourceFile, outFile) {
  requireKeys([{ name: 'OPENAI_API_KEY', value: config.image.openai.apiKey }]);
  const OpenAI = (await import('openai')).default;
  const { toFile } = await import('openai');
  const client = new OpenAI({ apiKey: config.image.openai.apiKey });
  const image = await toFile(fs.createReadStream(sourceFile), path.basename(sourceFile));
  const res = await client.images.edit({
    model: config.image.openai.model,
    image,
    prompt: PROMPT,
    size: '1024x1024',
  });
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  await fsp.writeFile(outFile, Buffer.from(b64, 'base64'));
  return outFile;
}

// ---------------- provider: Replicate (Flux Kontext img2img) ----------------
async function replicate(sourceFile, outFile) {
  requireKeys([{ name: 'REPLICATE_API_TOKEN', value: config.image.replicate.token }]);
  const Replicate = (await import('replicate')).default;
  const client = new Replicate({ auth: config.image.replicate.token });
  const output = await client.run(config.image.replicate.model, {
    input: {
      prompt: PROMPT,
      input_image: readAsDataUri(sourceFile),
      output_format: 'png',
      aspect_ratio: '1:1',
    },
  });
  const url = Array.isArray(output) ? output[0] : output?.url ? output.url() : output;
  const res = await fetch(String(url));
  await fsp.writeFile(outFile, Buffer.from(await res.arrayBuffer()));
  return outFile;
}

const PROVIDERS = { gemini, openai, replicate };

// --- build a small valid PNG in memory (for the self-test source image) ---
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function makeTestPng(size = 256) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const p = y * stride + 1 + x * 3;
      raw[p] = 200; raw[p + 1] = 70; raw[p + 2] = 70; // dull red block
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Quick connectivity test for the configured image model. Throws on failure. */
export async function testImage() {
  const provider = PROVIDERS[config.image.provider];
  if (!provider) throw new Error(`unknown IMAGE_PROVIDER "${config.image.provider}"`);
  await fsp.mkdir(config.aiImagesDir, { recursive: true });
  const src = path.join(config.aiImagesDir, '_test_src.png');
  const out = path.join(config.aiImagesDir, '_test_out.png');
  await fsp.writeFile(src, makeTestPng(256));
  try {
    await provider(src, out);
    const bytes = fs.statSync(out).size;
    if (!bytes) throw new Error('provider produced an empty image');
    return { ok: true, provider: config.image.provider, model: config.image[config.image.provider]?.model, bytes };
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(out, { force: true });
  }
}

/**
 * Regenerate a faithful copy of the product's first downloaded image.
 * Returns the path of the AI image (or null if it could not be produced).
 */
export async function regenerateImage(product) {
  const source = product.localImages?.[0];
  if (!source || !fs.existsSync(source)) throw new Error('no downloaded source image to copy');
  await fsp.mkdir(config.aiImagesDir, { recursive: true });
  const provider = PROVIDERS[config.image.provider];
  if (!provider) throw new Error(`unknown IMAGE_PROVIDER "${config.image.provider}"`);
  const outFile = path.join(config.aiImagesDir, `${product.id}.png`);
  log.info(`  AI image (${config.image.provider}) <- ${path.basename(source)}`);
  await provider(source, outFile);
  return outFile;
}
