const { getAccessToken, uploadAsset, pollJob, parseMultipart, CLIENT_ID, BASE_URL } = require('./_helpers');
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { fileBuffer } = await parseMultipart(req);
    const token = await getAccessToken();
    const assetID = await uploadAsset(token, fileBuffer, 'application/pdf');
    const jobRes = await fetch(`${BASE_URL}/operation/pdfproperties`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'X-API-Key': CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetID, includePageLevelProperties: false }),
    });
    const job = await pollJob(token, jobRes.headers.get('location'));
    res.json({
      protected: job.content?.document?.IsEncrypted || false,
      info: { pages: job.content?.pages?.length || 0, properties: job.content?.document || {} },
    });
  } catch (e) {
    const isProtected = e.message?.toLowerCase().includes('encrypt') || e.message?.toLowerCase().includes('password');
    res.json({ protected: isProtected, error: e.message });
  }
};
