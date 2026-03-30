// api/extension-push.js
// Receives records from the Chrome extension and stores them
// Dashboard reads from this endpoint

const fs = require('fs');
const path = require('path');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST — receive records from extension
  if (req.method === 'POST') {
    try {
      const { records, lastUpdated, source } = req.body;

      if (!records || !Array.isArray(records)) {
        return res.status(400).json({ error: 'Invalid records' });
      }

      const data = {
        lastUpdated: lastUpdated || new Date().toISOString(),
        source: source || 'chrome-extension',
        totalRecords: records.length,
        records
      };

      // In Vercel serverless, we can't write to disk permanently
      // Instead return success and store in response
      // The dashboard will cache this in sessionStorage
      console.log(`Extension push: ${records.length} records from ${source}`);

      // Store temporarily in global (lasts for this function instance)
      global._extensionRecords = data;

      return res.status(200).json({
        success: true,
        received: records.length,
        message: 'Records received successfully'
      });

    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // GET — dashboard polls for latest records
  if (req.method === 'GET') {
    const data = global._extensionRecords || {
      lastUpdated: null,
      totalRecords: 0,
      records: []
    };
    return res.status(200).json(data);
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
