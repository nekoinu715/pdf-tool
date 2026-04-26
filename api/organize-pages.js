const { getAccessToken, uploadAsset, pollJob, downloadAsset, parseMultipart, CLIENT_ID, BASE_URL } = require('./_helpers');
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { fileBuffer, fields } = await parseMultipart(req);
    const pages = fields.pagesOrder.split(',').map(p => parseInt(p.trim()) - 1);

    const token = await getAccessToken();
    const assetID = await uploadAsset(token, fileBuffer, 'application/pdf');
    const jobRes = await fetch(`${BASE_URL}/operation/reorderpages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'X-API-Key': CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetID, pageRanges: pages.map(p => ({ start: p, end: p })) }),
    });
    const job = await pollJob(token, jobRes.headers.get('location'));
    const buf = await downloadAsset(token, job.asset.assetID);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="organized.pdf"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
