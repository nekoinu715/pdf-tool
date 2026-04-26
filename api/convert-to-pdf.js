const { getAccessToken, uploadAsset, pollJob, downloadAsset, parseMultipart, CLIENT_ID, BASE_URL } = require('./_helpers');
const fetch = require('node-fetch');

const MIME_MAP = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc':  'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt':  'application/vnd.ms-powerpoint',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls':  'application/vnd.ms-excel',
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { fileBuffer, fileName } = await parseMultipart(req);
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    const mime = MIME_MAP[ext];
    if (!mime) return res.status(400).json({ error: 'Unsupported file type' });

    const token = await getAccessToken();
    const assetID = await uploadAsset(token, fileBuffer, mime);
    const jobRes = await fetch(`${BASE_URL}/operation/createpdf`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'X-API-Key': CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetID }),
    });
    const job = await pollJob(token, jobRes.headers.get('location'));
    const buf = await downloadAsset(token, job.asset.assetID);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="output.pdf"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
