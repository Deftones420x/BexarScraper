const https = require('https');

const MS_WEIGHTS = {
  taxdel:30, probate:28, fc:22, lispendens:15,
  over65:14, disabled:12, veteran:10, bk:10,
  divorce:8, judgment:8, multilien:6,
  homestead:3, absentee:5, vacant:4, llc:3
};

function calcScore(flags) {
  return Math.min(100, flags.reduce((s, f) => s + (MS_WEIGHTS[f] || 5), 0));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Parse BCAD Exempts field into MS flags
// Exempts field contains codes like "HS,OA,DV4" or "HS" or "OA,DP"
function parseExemptions(exempts, ownerName) {
  const flags = [];
  const ex = (exempts || '').toUpperCase();
  const owner = (ownerName || '').toUpperCase();

  // Probate — owner name contains estate keywords
  if (owner.match(/\bEST(ATE)?\s+(OF\b|$)/) ||
      owner.includes(' ETAL') || owner.includes('HEIRS') ||
      owner.includes('ESTATE OF') || owner.match(/\bDECD\b/)) {
    flags.push('probate');
  }

  // Homestead
  if (ex.includes('HS')) flags.push('homestead');

  // Over 65 / Senior
  if (ex.includes('OA') || ex.includes('OVER65') || ex.includes('OVER 65')) flags.push('over65');

  // Disabled Person
  if (ex.includes('DP') && !ex.includes('DPV')) flags.push('disabled');

  // Disabled Veteran (DV1-DV4, DVH, DVHS)
  if (ex.match(/\bDV\d?\b/) || ex.includes('DVH')) flags.push('veteran');

  // LLC / Corp
  if (owner.match(/\bLLC\b|\bCORP\b|\bINC\b|\bLTD\b|L\.L\.C/)) flags.push('llc');

  return [...new Set(flags)];
}

function exemptLabel(flags) {
  if (flags.includes('probate')) return 'Probate/Estate';
  if (flags.includes('over65')) return 'Senior 65+';
  if (flags.includes('disabled')) return 'Disabled';
  if (flags.includes('veteran')) return 'Veteran';
  if (flags.includes('homestead')) return 'Homestead';
  return 'Standard';
}

// ─── SOURCE 1: Foreclosures (ArcGIS live) ─────────────────────────────────────
async function fetchForeclosures() {
  const records = [];
  try {
    const urls = [
      'https://maps.bexar.org/arcgis/rest/services/CC/ForeclosuresProd/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&f=json&resultRecordCount=1000',
      'https://maps.bexar.org/arcgis/rest/services/CC/ForeclosuresProd/MapServer/1/query?where=1%3D1&outFields=*&returnGeometry=false&f=json&resultRecordCount=1000'
    ];
    const types = ['Mortgage Foreclosure', 'Tax Foreclosure'];

    for (let i = 0; i < urls.length; i++) {
      const r = await httpGet(urls[i]);
      const d = JSON.parse(r.body);
      (d.features || []).forEach((f, idx) => {
        const a = f.attributes || {};
        const addr = (a.ADDRESS || a.SITUS_ADDRESS || '').toUpperCase().trim();
        if (!addr) return;
        const flags = i === 1 ? ['fc', 'taxdel'] : ['fc'];
        records.push({
          id: `fc-${i}-${a.DOCNUM || idx}`,
          address: addr,
          mailingAddress: addr,
          mailingCity: 'San Antonio',
          mailingState: 'TX',
          mailingZip: '',
          city: 'San Antonio',
          zip: '',
          owner: (a.GRANTOR || a.OWNER || a.DEBTOR || 'SEE DOCUMENT').toUpperCase(),
          firstName: '', lastName: '',
          category: 'foreclosure',
          docType: types[i].toUpperCase(),
          date: a.SALEDATE ? new Date(a.SALEDATE).toISOString().slice(0,10) : '',
          docNum: String(a.DOCNUM || ''),
          amount: parseFloat(a.AMOUNT || 0) || 0,
          score: calcScore(flags),
          msFlags: flags,
          exemptionType: 'fc',
          isNew: true,
          source: 'Bexar County Foreclosure Map (ArcGIS)',
          url: 'https://maps.bexar.org/foreclosures/'
        });
      });
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`Foreclosures: ${records.length}`);
  } catch(e) {
    console.log(`FC error: ${e.message}`);
  }
  return records;
}

// ─── SOURCE 2: BCAD Parcels — Estate owners + exemption-flagged properties ─────
// Uses the official Bexar County ArcGIS Parcels layer
// Fields: Owner, Situs, AddrLn1, AddrCity, AddrSt, Zip, AcctNumb, Exempts, TotVal, PropUse
async function fetchBCADProbate() {
  const records = [];
  const BASE = 'https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0/query';
  const FIELDS = 'Owner,Situs,AddrLn1,AddrLn2,AddrCity,AddrSt,Zip,AcctNumb,Exempts,TotVal,PropUse,LglDesc';

  // Query 1: Estate / Probate owners by name
  const queries = [
    { where: "Owner LIKE '%EST OF%' OR Owner LIKE '%ESTATE OF%' OR Owner LIKE '%HEIRS%' OR Owner LIKE '% ETAL%'", label: 'probate' },
    { where: "Exempts LIKE '%OA%'", label: 'over65' },
    { where: "Exempts LIKE '%DP%'", label: 'disabled' },
    { where: "Exempts LIKE '%DV%'", label: 'veteran' }
  ];

  for (const q of queries) {
    try {
      let offset = 0;
      let hasMore = true;

      while (hasMore && offset < 5000) {
        const params = new URLSearchParams({
          where: q.where,
          outFields: FIELDS,
          returnGeometry: 'false',
          f: 'json',
          resultRecordCount: '1000',
          resultOffset: String(offset)
        });

        const r = await httpGet(`${BASE}?${params.toString()}`);
        const d = JSON.parse(r.body);
        const features = d.features || [];

        features.forEach((f, i) => {
          const a = f.attributes || {};
          const owner = (a.Owner || '').toUpperCase().trim();
          const situs = (a.Situs || '').toUpperCase().trim();
          if (!situs && !owner) return;

          // Mailing address from AddrLn1/AddrCity/AddrSt/Zip
          const mailStreet = (a.AddrLn1 || a.AddrLn2 || situs).toUpperCase().trim();
          const mailCity = (a.AddrCity || 'San Antonio').trim();
          const mailState = (a.AddrSt || 'TX').trim();
          const mailZip = String(a.Zip || '').trim();

          // Check if absentee (mailing differs from property)
          const isAbsentee = mailStreet && situs && !situs.startsWith(mailStreet.slice(0, 10));

          // Parse exemptions from the Exempts field
          const exemptFlags = parseExemptions(a.Exempts, owner);
          const allFlags = [...new Set([...exemptFlags])];
          if (isAbsentee) allFlags.push('absentee');
          if (!allFlags.includes('probate') && q.label === 'probate') allFlags.push('probate');
          if (!allFlags.includes('over65') && q.label === 'over65') allFlags.push('over65');
          if (!allFlags.includes('disabled') && q.label === 'disabled') allFlags.push('disabled');
          if (!allFlags.includes('veteran') && q.label === 'veteran') allFlags.push('veteran');
          allFlags.push('taxdel'); // These are from the BCAD delinquent-related parcel layer

          const score = calcScore(allFlags);
          const acct = String(a.AcctNumb || '');

          // Extract city/zip from Situs if available
          // Situs format: "1234 MAIN ST  SAN ANTONIO TX 78205"
          let propCity = 'San Antonio', propZip = '';
          const situsMatch = situs.match(/\s+([A-Z ]+)\s+TX\s+(\d{5})/);
          if (situsMatch) { propCity = situsMatch[1].trim(); propZip = situsMatch[2]; }

          records.push({
            id: `bcad-${q.label}-${acct || offset + i}`,
            address: situs,
            mailingAddress: mailStreet,
            mailingCity: mailCity,
            mailingState: mailState,
            mailingZip: mailZip,
            city: propCity,
            zip: propZip,
            owner,
            firstName: '',
            lastName: owner.split(' ')[0] || '',
            category: q.label === 'probate' ? 'probate' : 'tax',
            docType: `BCAD — ${exemptLabel(allFlags)}`,
            date: '',
            docNum: acct,
            amount: parseFloat(a.TotVal || 0) || 0,
            score,
            msFlags: allFlags,
            exemptionType: q.label,
            exemptCodes: a.Exempts || '',
            propUse: a.PropUse || '',
            legalDesc: a.LglDesc || '',
            isNew: false,
            source: 'BCAD Parcels (ArcGIS)',
            url: `https://esearch.bcad.org/Property/Details?PropertyID=${acct}`
          });
        });

        offset += features.length;
        hasMore = features.length === 1000 && !d.exceededTransferLimit === false;
        if (features.length < 1000) hasMore = false;

        await new Promise(r => setTimeout(r, 600));
      }

      console.log(`BCAD ${q.label}: ${records.filter(r => r.exemptionType === q.label).length} records`);
    } catch(e) {
      console.log(`BCAD ${q.label} error: ${e.message}`);
    }
  }

  return records;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  console.log('Starting Bexar County scrape...');

  const [fcResult, bcadResult] = await Promise.allSettled([
    fetchForeclosures(),
    fetchBCADProbate()
  ]);

  const allRecords = [
    ...(fcResult.value || []),
    ...(bcadResult.value || [])
  ];

  // Deduplicate by account number / address
  const seen = new Set();
  const deduped = allRecords.filter(r => {
    const k = (r.docNum && r.docNum !== '0') ? `acct-${r.docNum}` : `addr-${r.address}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  deduped.sort((a, b) => b.score - a.score);

  const summary = {
    foreclosure: deduped.filter(r => r.category === 'foreclosure').length,
    probate: deduped.filter(r => r.msFlags.includes('probate')).length,
    over65: deduped.filter(r => r.msFlags.includes('over65')).length,
    disabled: deduped.filter(r => r.msFlags.includes('disabled')).length,
    veteran: deduped.filter(r => r.msFlags.includes('veteran')).length,
    total: deduped.length
  };

  console.log(`Done. Total: ${deduped.length}`, summary);

  return res.status(200).json({
    success: true,
    lastUpdated: new Date().toISOString(),
    totalRecords: deduped.length,
    summary,
    errors: [],
    records: deduped
  });
};
