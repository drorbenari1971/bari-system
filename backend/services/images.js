// Image generation: Facebook feed (1:1, 1080x1080) + Instagram story (9:16, 1080x1920).
// Uses the OpenAI Images API when OPENAI_API_KEY is set; otherwise writes branded SVG placeholders.
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config.js';
import { MEDIA_DIR } from '../db.js';
import { PRODUCTS } from '../constants.js';

export const imagesConfigured = () => !!env('OPENAI_API_KEY');

const FORMATS = {
  feed: { width: 1080, height: 1080 },
  story: { width: 1080, height: 1920 },
};

export async function generatePostImages({ postId, prompt, product }) {
  if (!imagesConfigured()) {
    return {
      feed: writePlaceholder(postId, 'feed', product, prompt),
      story: writePlaceholder(postId, 'story', product, prompt),
      demo: true,
    };
  }
  const [feed, story] = await Promise.all([
    generateOne(postId, 'feed', prompt),
    generateOne(postId, 'story', `${prompt}. Vertical composition with the product in the lower-middle third and calm negative space at the top.`),
  ]);
  return { feed, story, demo: false };
}

async function generateOne(postId, kind, prompt) {
  const imageModel = env('IMAGE_MODEL', 'gpt-image-1');
  const isDalle3 = imageModel.startsWith('dall-e-3');
  const size = kind === 'feed' ? '1024x1024' : isDalle3 ? '1024x1792' : '1024x1536';

  const body = { model: imageModel, prompt, size, n: 1 };
  if (isDalle3) body.response_format = 'b64_json';

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`יצירת תמונה נכשלה: ${json?.error?.message ?? res.status}`);

  const item = json.data?.[0];
  let buf;
  if (item?.b64_json) buf = Buffer.from(item.b64_json, 'base64');
  else if (item?.url) buf = Buffer.from(await (await fetch(item.url)).arrayBuffer());
  else throw new Error('לא התקבלה תמונה מספק התמונות');

  buf = await fitToFormat(buf, FORMATS[kind]);
  const file = `post-${postId}-${kind}-${Date.now()}.png`;
  fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
  return `/media/${file}`;
}

// Center-crop to the exact platform ratio. If sharp is unavailable, keep the original.
async function fitToFormat(buf, { width, height }) {
  try {
    const { default: sharp } = await import('sharp');
    return await sharp(buf).resize(width, height, { fit: 'cover', position: 'centre' }).png().toBuffer();
  } catch (err) {
    console.warn('[images] sharp unavailable, keeping original size:', err.message);
    return buf;
  }
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function writePlaceholder(postId, kind, product, prompt = '') {
  const { width, height } = FORMATS[kind];
  const name = PRODUCTS[product]?.he ?? 'בריא';
  const cx = width / 2;
  const cy = height / 2;
  const jarW = 300;
  const jarH = 380;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f3f7f3"/><stop offset="1" stop-color="#c7dbc8"/>
    </linearGradient>
    <linearGradient id="jar" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e9c46a"/><stop offset="1" stop-color="#c98f3a"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <circle cx="${width * 0.85}" cy="${height * 0.12}" r="${width * 0.25}" fill="#a0c2a3" opacity="0.35"/>
  <circle cx="${width * 0.1}" cy="${height * 0.9}" r="${width * 0.3}" fill="#76a47b" opacity="0.2"/>
  <rect x="${cx - jarW / 2}" y="${cy - jarH / 2}" width="${jarW}" height="${jarH}" rx="48" fill="url(#jar)" opacity="0.92"/>
  <rect x="${cx - jarW / 2 - 12}" y="${cy - jarH / 2 - 50}" width="${jarW + 24}" height="64" rx="16" fill="#37573b"/>
  <rect x="${cx - jarW / 2 + 30}" y="${cy - 60}" width="${jarW - 60}" height="140" rx="12" fill="#fafaf7"/>
  <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-family="Heebo, Arial" font-size="52" font-weight="700" fill="#2b2f2c" direction="rtl">בריא</text>
  <text x="${cx}" y="${cy + 55}" text-anchor="middle" font-family="Heebo, Arial" font-size="32" fill="#436c48" direction="rtl">${esc(name)}</text>
  <text x="${cx}" y="${height - 90}" text-anchor="middle" font-family="Heebo, Arial" font-size="30" fill="#37573b" direction="rtl">תמונת דמו · ${kind === 'feed' ? 'פיד 1:1' : 'סטורי 9:16'}</text>
  <text x="${cx}" y="${height - 45}" text-anchor="middle" font-family="Arial" font-size="20" fill="#56875c">${esc(prompt.slice(0, 80))}${prompt.length > 80 ? '…' : ''}</text>
</svg>`;
  const file = `post-${postId}-${kind}-${Date.now()}.svg`;
  fs.writeFileSync(path.join(MEDIA_DIR, file), svg, 'utf8');
  return `/media/${file}`;
}
