const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// ─── Adobe PDF Services Auth ────────────────────────────────────────────────
const CLIENT_ID = process.env.ADOBE_CLIENT_ID || 'YOUR_CLIENT_ID';
const CLIENT_SECRET = process.env.ADOBE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const BASE_URL = 'https://pdf-services.adobe.io';

let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }
  const res = await fetch('https://pdf-services.adobe.io/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Auth failed');
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return accessToken;
}

// ─── Helper: Upload asset to Adobe ─────────────────────────────────────────
async function uploadAsset(token, filePath, mimeType) {
  // 1. Get upload URI
  const initRes = await fetch(`${BASE_URL}/assets`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-API-Key': CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mediaType: mimeType }),
  });
  const initData = await initRes.json();
  const { uploadUri, assetID } = initData;

  // 2. Upload file
  const fileBuffer = fs.readFileSync(filePath);
  await fetch(uploadUri, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: fileBuffer,
  });

  return assetID;
}

// ─── Helper: Poll job until done ────────────────────────────────────────────
async function pollJob(token, location, maxWait = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res = await fetch(location, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-API-Key': CLIENT_ID,
      },
    });
    const data = await res.json();
    if (data.status === 'done') return data;
    if (data.status === 'failed') throw new Error(data.error?.message || 'Job failed');
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Job timed out');
}

// ─── Helper: Download result ────────────────────────────────────────────────
async function downloadResult(token, assetID, outPath) {
  const res = await fetch(`${BASE_URL}/assets/${assetID}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-API-Key': CLIENT_ID,
    },
  });
  const { downloadUri } = await res.json();
  const fileRes = await fetch(downloadUri);
  const buffer = await fileRes.buffer();
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

// ─── Cleanup helper ──────────────────────────────────────────────────────────
function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'PDF Tool Server running' });
});

// Convert to PDF (Word, PowerPoint, Excel → PDF)
app.post('/api/convert-to-pdf', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  const ext = path.extname(file.originalname).toLowerCase();
  const mimeMap = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
  };
  const mime = mimeMap[ext];
  if (!mime) return res.status(400).json({ error: 'Unsupported file type' });

  const outPath = `uploads/output_${Date.now()}.pdf`;
  try {
    const token = await getAccessToken();
    const assetID = await uploadAsset(token, file.path, mime);

    const jobRes = await fetch(`${BASE_URL}/operation/createpdf`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-API-Key': CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assetID }),
    });
    const { location } = await jobRes.headers.raw ? { location: jobRes.headers.get('location') } : jobRes.json();
    const loc = jobRes.headers.get('location');
    const job = await pollJob(token, loc);
    await downloadResult(token, job.asset.assetID, outPath);

    res.download(outPath, `${path.basename(file.originalname, ext)}.pdf`, () => cleanup(file.path, outPath));
  } catch (e) {
    cleanup(file.path, outPath);
    res.status(500).json({ error: e.message });
  }
});

// Export PDF to PowerPoint
app.post('/api/pdf-to-pptx', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  const outPath = `uploads/output_${Date.now()}.pptx`;
  try {
    const token = await getAccessToken();
    const assetID = await uploadAsset(token, file.path, 'application/pdf');

    const jobRes = await fetch(`${BASE_URL}/operation/exportpdf`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-API-Key': CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assetID, targetFormat: 'pptx' }),
    });
    const loc = jobRes.headers.get('location');
    const job = await pollJob(token, loc);
    await downloadResult(token, job.asset.assetID, outPath);

    res.download(outPath, `output_${Date.now()}.pptx`, () => cleanup(file.path, outPath));
  } catch (e) {
    cleanup(file.path, outPath);
    res.status(500).json({ error: e.message });
  }
});

// Export PDF to Word
app.post('/api/pdf-to-docx', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  const outPath = `uploads/output_${Date.now()}.docx`;
  try {
    const token = await getAccessToken();
    const assetID = await uploadAsset(token, file.path, 'application/pdf');

    const jobRes = await fetch(`${BASE_URL}/operation/exportpdf`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-API-Key': CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assetID, targetFormat: 'docx' }),
    });
    const loc = jobRes.headers.get('location');
    const job = await pollJob(token, loc);
    await downloadResult(token, job.asset.assetID, outPath);

    res.download(outPath, `output_${Date.now()}.docx`, () => cleanup(file.path, outPath));
  } catch (e) {
    cleanup(file.path, outPath);
    res.status(500).json({ error: e.message });
  }
});

// Password protect PDF
app.post('/api/protect-pdf', upload.single('file'), async (req, res) => {
  const file = req.file;
  const { password, ownerPassword } = req.body;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  if (!password) return res.status(400).json({ error: 'Password required' });

  const outPath = `uploads/output_${Date.now()}.pdf`;
  try {
    const token = await getAccessToken();
    const assetID = await uploadAsset(token, file.path, 'application/pdf');

    const jobRes = await fetch(`${BASE_URL}/operation/protectpdf`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-API-Key': CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assetID,
        passwordProtection: {
          userPassword: password,
          ownerPassword: ownerPassword || password,
        },
        encryptionAlgorithm: 'AES_256',
      }),
    });
    const loc = jobRes.headers.get('location');
    const job = await pollJob(token, loc);
    await downloadResult(token, job.asset.assetID, outPath);

    res.download(outPath, 'protected.pdf', () => cleanup(file.path, outPath));
  } catch (e) {
    cleanup(file.path, outPath);
    res.status(500).json({ error: e.message });
  }
});

// Check if PDF is password protected
app.post('/api/check-protection', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    // Try to read PDF properties - if it's protected, we'll get an indication
    const token = await getAccessToken();

    // Use Get PDF Properties operation
    const assetID = await uploadAsset(token, file.path, 'application/pdf');
    const jobRes = await fetch(`${BASE_URL}/operation/pdfproperties`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-API-Key': CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assetID, includePageLevelProperties: true }),
    });
    const loc = jobRes.headers.get('location');
    const job = await pollJob(token, loc);

    cleanup(file.path);
    res.json({
      protected: job.content?.document?.IsEncrypted || false,
      info: {
        pageCount: job.content?.document?.PDFVersion,
        pages: job.content?.pages?.length || 0,
        properties: job.content?.document || {},
      }
    });
  } catch (e) {
    cleanup(file.path);
    // If we get a specific error about encryption, it's protected
    const isProtected = e.message?.toLowerCase().includes('encrypt') ||
                        e.message?.toLowerCase().includes('password');
    res.json({ protected: isProtected, error: e.message });
  }
});

// Remove metadata from PDF
app.post('/api/remove-metadata', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  const outPath = `uploads/output_${Date.now()}.pdf`;
  try {
    const token = await getAccessToken();
    const assetID = await uploadAsset(token, file.path, 'application/pdf');

    // Use linearize (optimize) which cleans up metadata
    const jobRes = await fetch(`${BASE_URL}/operation/linearizepdf`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-API-Key': CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assetID }),
    });
    const loc = jobRes.headers.get('location');
    const job = await pollJob(token, loc);
    await downloadResult(token, job.asset.assetID, outPath);

    cleanup(file.path);
    res.download(outPath, 'cleaned.pdf', () => cleanup(outPath));
  } catch (e) {
    cleanup(file.path, outPath);
    res.status(500).json({ error: e.message });
  }
});

// Delete / reorder pages
app.post('/api/organize-pages', upload.single('file'), async (req, res) => {
  const file = req.file;
  let { pagesOrder } = req.body; // e.g. "1,3,2" for reorder or "1,3" to keep only those
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  if (!pagesOrder) return res.status(400).json({ error: 'pagesOrder required' });

  const outPath = `uploads/output_${Date.now()}.pdf`;
  try {
    const token = await getAccessToken();
    const assetID = await uploadAsset(token, file.path, 'application/pdf');

    // Parse page ranges
    const pages = pagesOrder.split(',').map(p => parseInt(p.trim()) - 1); // 0-indexed

    const jobRes = await fetch(`${BASE_URL}/operation/reorderpages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-API-Key': CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assetID,
        pageRanges: pages.map(p => ({ start: p, end: p })),
      }),
    });
    const loc = jobRes.headers.get('location');
    const job = await pollJob(token, loc);
    await downloadResult(token, job.asset.assetID, outPath);

    cleanup(file.path);
    res.download(outPath, 'organized.pdf', () => cleanup(outPath));
  } catch (e) {
    cleanup(file.path, outPath);
    res.status(500).json({ error: e.message });
  }
});

// Delete specific pages
app.post('/api/delete-pages', upload.single('file'), async (req, res) => {
  const file = req.file;
  let { pagesToDelete } = req.body; // comma separated, 1-indexed
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  if (!pagesToDelete) return res.status(400).json({ error: 'pagesToDelete required' });

  const outPath = `uploads/output_${Date.now()}.pdf`;
  try {
    const token = await getAccessToken();
    const assetID = await uploadAsset(token, file.path, 'application/pdf');

    const pages = pagesToDelete.split(',').map(p => parseInt(p.trim()) - 1);

    const jobRes = await fetch(`${BASE_URL}/operation/deletepages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-API-Key': CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assetID,
        pageRanges: pages.map(p => ({ start: p, end: p })),
      }),
    });
    const loc = jobRes.headers.get('location');
    const job = await pollJob(token, loc);
    await downloadResult(token, job.asset.assetID, outPath);

    cleanup(file.path);
    res.download(outPath, 'pages_deleted.pdf', () => cleanup(outPath));
  } catch (e) {
    cleanup(file.path, outPath);
    res.status(500).json({ error: e.message });
  }
});

// Get PDF page count (for UI display)
app.post('/api/pdf-info', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const token = await getAccessToken();
    const assetID = await uploadAsset(token, file.path, 'application/pdf');

    const jobRes = await fetch(`${BASE_URL}/operation/pdfproperties`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-API-Key': CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assetID, includePageLevelProperties: false }),
    });
    const loc = jobRes.headers.get('location');
    const job = await pollJob(token, loc);

    cleanup(file.path);
    res.json({
      pages: job.content?.pages?.length || 0,
      document: job.content?.document || {},
    });
  } catch (e) {
    cleanup(file.path);
    res.status(500).json({ error: e.message });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 PDF Tool Server running at http://localhost:${PORT}`);
  console.log(`📄 Adobe Client ID: ${CLIENT_ID.slice(0, 8)}...`);
  console.log(`\nSet credentials with:`);
  console.log(`  ADOBE_CLIENT_ID=xxx ADOBE_CLIENT_SECRET=xxx node server.js\n`);
});
