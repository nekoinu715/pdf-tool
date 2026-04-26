const { getAccessToken, uploadAsset, pollJob, downloadAsset, parseMultipart, CLIENT_ID, BASE_URL } = require('./_helpers');
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { fileBuffer, fields } = await parseMultipart(req);
    const { password, ownerPassword } = fields;
    if (!password) return res.status(400).json({ error: 'Password required' });

    const token = await getAccessToken();
    const assetID = await uploadAsset(token, fileBuffer, 'application/pdf');
    const jobRes = await fetch(`${BASE_URL}/operation/protectpdf`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'X-API-Key': CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetID,
        passwordProtection: { userPassword: password, ownerPassword: ownerPassword || password },
        encryptionAlgorithm: 'AES_256',
      }),
    });
    const job = await pollJob(token, jobRes.headers.get('location'));
    const buf = await downloadAsset(token, job.asset.assetID);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="protected.pdf"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
