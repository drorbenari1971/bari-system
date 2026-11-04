// Cloudinary image hosting: Instagram downloads images from a public URL, so they are
// uploaded here at publish time and the local server is never exposed to the internet.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config.js';
import { MEDIA_DIR } from '../db.js';

export const cloudinaryConfigured = () =>
  !!(env('CLOUDINARY_CLOUD_NAME') && env('CLOUDINARY_API_KEY') && env('CLOUDINARY_API_SECRET'));

// Cloudinary signature: SHA-1 of the sorted "key=value&..." params followed by the API secret.
export function signParams(params, secret) {
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + secret).digest('hex');
}

// Uploads a local /media/... image and returns its public https URL (always JPEG,
// the only image format the Instagram publishing API accepts).
export async function uploadImage(mediaPath) {
  const name = path.basename(mediaPath);
  const params = {
    folder: 'bari',
    format: 'jpg',
    public_id: path.parse(name).name,
    timestamp: Math.floor(Date.now() / 1000),
  };

  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append('api_key', env('CLOUDINARY_API_KEY'));
  form.append('signature', signParams(params, env('CLOUDINARY_API_SECRET')));
  form.append('file', new Blob([fs.readFileSync(path.join(MEDIA_DIR, name))]), name);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${env('CLOUDINARY_CLOUD_NAME')}/image/upload`, { method: 'POST', body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.secure_url) throw new Error(`העלאה ל-Cloudinary נכשלה: ${json.error?.message ?? res.status}`);
  return json.secure_url;
}
