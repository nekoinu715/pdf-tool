const fetch = require('node-fetch');

let accessToken = null;
let tokenExpiry = null;

const CLIENT_ID = process.env.ADOBE_CLIENT_ID;
const CLIENT_SECRET = process.env.ADOBE_CLIENT_SECRET;
const BASE_URL = 'https://pdf-services.adobe.io';

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) return accessToken;
  const res = await fetch('https://pdf-services.adobe.io/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Auth failed');
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return accessToken;
}

async function uploadAsset(token, buffer, mimeType) {
  const res = await fetch(`${BASE_URL}/assets`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-API-Key': CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mediaType: mimeType }),
  });
  const { uploadUri, assetID } = await res.json();
  await fetch(uploadUri, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: buffer });
  return assetID;
}

async function pollJob(token, location, maxWait = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res = await fetch(location, {
      headers: { 'Authorization': `Bearer ${token}`, 'X-API-Key': CLIENT_ID },
    });
    const data = await res.json();
    if (data.status === 'done') return data;
    if (data.status === 'failed') throw new Error(data.error?.message || 'Job failed');
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Job timed out');
}

async function downloadAsset(token, assetID) {
  const res = await fetch(`${BASE_URL}/assets/${assetID}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'X-API-Key': CLIENT_ID },
  });
  const { downloadUri } = await res.json();
  const fileRes = await fetch(downloadUri);
  return fileRes.buffer();
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const Busboy = require('busboy');
    const bb = Busboy({ headers: req.headers });
    const fields = {};
    let fileBuffer = null;
    let fileName = '';
    let fileMime = '';

    bb.on('file', (name, file, info) => {
      fileName = info.filename;
      fileMime = info.mimeType;
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('finish', () => resolve({ fileBuffer, fileName, fileMime, fields }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

module.exports = { getAccessToken, uploadAsset, pollJob, downloadAsset, parseMultipart, CLIENT_ID, BASE_URL };
