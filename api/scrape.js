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
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Parse BCAD Exempts field + owner name into MS flags
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
  if (ex.includes('HS')) flags.push('homestead');
  if (ex.includes('OA') || ex.includes('OVER') || ex.includes('65')) flags.push('over65');
  if (ex.includes('DP') && !ex.match(/DPV|DP1|DP2/)) flags.push('disabled');
  if (ex.match(/DV\d|DVH|DVHS/)) flags.push('veteran');
  if (owner.match(/\bLLC\b|\bCORP\b|\bINC\b|\bLTD\b|L\.L\.C/)) flags.push('llc');

  return [...new Set(flags)];
}

function buildRecord(a, queryLabel, idx) {
  const owner = (a.Owner || '').toUpperCase().trim();
  const situs = (a.Situs || '').toUpperCase().trim();
  if (!situs && !owner) return null;

  const mailStreet = (a.AddrLn1 || a.AddrLn2 || situs).toUpperCase().trim();
  const mailCity = (a.AddrCity || 'San Antonio').trim();
  const mailState = (a.AddrSt || 'TX').trim();
  const mailZip = String(a.Zip || '').trim();
  const isAbsentee = mailStreet && situs && mailStreet.slice(0,8) !== situs.slice(0,8);

  const flags = parseExemptions(a.Exempts, owner);
  if (!flags.includes('probate') && queryLabel === 'probate') flags.push('probate');
  if (!flags.includes('over65') && queryLabel === 'over65') flags.push('over65');
  if (!flags.includes('disabled') && queryLabel === 'disabled') flags.push('disabled');
  if (!flags.includes('veteran') && queryLabel === 'veteran') flags.push('veteran');
  if (isAbsentee) flags.push('absentee');

  const acct = String(a.AcctNumb || '');
  let propCity = 'San Antonio', propZip = '';
  const sm = situs.match(/\s+([A-Z ]+)\s+TX\s+(\d{5})/);
  if (sm) { propCity = sm[1].trim(); propZip = sm[2]; }

  const docTypeLabel = flags.includes('probate') ? 'BCAD — Probate/Estate' :
    flags.includes('over65') ? 'BCAD — Senior 65+' :
    flags.includes('disabled') ? 'BCAD — Disabled Owner' :
    flags.includes('veteran') ? 'BCAD — Veteran Owner' : 'BCAD — Parcel';

  return {
    id: `bcad-${queryLabel}-${acct || idx}`,
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
    category: queryLabel === 'probate' ? 'probate' : 'tax',
    docType: docTypeLabel,
    date: '',
    docNum: acct,
    amount: parseFloat(a.TotVal || 0) || 0,
    score: calcScore([...new Set(flags)]),
    msFlags: [...new Set(flags)],
    exemptionType: queryLabel,
    exemptCodes: a.Exempts || '',
    isNew: false,
    source: 'BCAD Parcels (ArcGIS)',
    url: `https://esearch.bcad.org/Property/Details?PropertyID=${acct}`
  };
}

// Fetch a single BCAD query — just first page (1000 records) to stay within timeout
async function fetchBCADQuery(where, label) {
  const BASE = 'https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0/query';
  const FIELDS = 'Owner,Situs,AddrLn1,AddrLn2,AddrCity,AddrSt,Zip,AcctNumb,Exempts,TotVal';
  const params = new URLSearchParams({
    where,
    outFields: FIELDS,
    returnGeometry: 'false',
    f: 'json',
    resultRecordCount: '1000',
    resultOffset: '0',
    orderByFields: 'OBJECTID ASC'
  });
  const r = await httpGet(`${BASE}?${params.toString()}`);
  const d = JSON.parse(r.body);
  const records = (d.features || [])
    .map((f, i) => buildRecord(f.attributes, label, i))
    .filter(Boolean);
  console.log(`BCAD ${label}: ${records.length} records (status ${r.status})`);
  return records;
}

// Foreclosures from ArcGIS
async function fetchForeclosures() {
  const records = [];
  const urls = [
    { url: 'https://maps.bexar.org/arcgis/rest/services/CC/ForeclosuresProd/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&f=json&resultRecordCount=1000', type: 'NOTICE OF TRUSTEE SALE', flags: ['fc'] },
    { url: 'https://maps.bexar.org/arcgis/rest/services/CC/ForeclosuresProd/MapServer/1/query?where=1%3D1&outFields=*&returnGeometry=false&f=json&resultRecordCount=1000', type: 'TAX FORECLOSURE NOTICE', flags: ['fc','taxdel'] }
  ];
  for (const {url, type, flags} of urls) {
    try {
      const r = await httpGet(url);
      const d = JSON.parse(r.body);
      (d.features || []).forEach((f, i) => {
        const a = f.attributes || {};
        const addr = (a.ADDRESS || '').toUpperCase().trim();
        if (!addr) return;
        records.push({
          id: `fc-${type}-${a.DOCNUM || i}`,
          address: addr, mailingAddress: addr,
          mailingCity: 'San Antonio', mailingState: 'TX', mailingZip: '',
          city: 'San Antonio', zip: '',
          owner: (a.GRANTOR || a.OWNER || 'SEE DOCUMENT').toUpperCase(),
          firstName: '', lastName: '',
          category: 'foreclosure', docType: type,
          date: a.SALEDATE ? new Date(a.SALEDATE).toISOString().slice(0,10) : '',
          docNum: String(a.DOCNUM || ''),
          amount: parseFloat(a.AMOUNT || 0) || 0,
          score: calcScore(flags), msFlags: [...flags],
          exemptionType: 'fc', isNew: true,
          source: 'Bexar County Foreclosure Map (ArcGIS)',
          url: 'https://maps.bexar.org/foreclosures/'
        });
      });
    } catch(e) { console.log(`FC error: ${e.message}`); }
  }
  console.log(`Foreclosures: ${records.length}`);
  return records;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  console.log('Starting parallel Bexar County scrape...');

  // Run ALL queries in parallel — much faster, stays within timeout
  const [fcRes, probateRes, over65Res, disabledRes, veteranRes] = await Promise.allSettled([
    fetchForeclosures(),
    fetchBCADQuery("Owner LIKE '%EST OF%' OR Owner LIKE '%ESTATE OF%' OR Owner LIKE '%HEIRS%' OR Owner LIKE '% ETAL%'", 'probate'),
    fetchBCADQuery("Exempts LIKE '%OA%' OR Exempts LIKE '%OVER%' OR Exempts LIKE '%65%'", 'over65'),
    fetchBCADQuery("Exempts LIKE '%DP%'", 'disabled'),
    fetchBCADQuery("Exempts LIKE '%DV%'", 'veteran')
  ]);

  const allRecords = [
    ...(fcRes.value || []),
    ...(probateRes.value || []),
    ...(over65Res.value || []),
    ...(disabledRes.value || []),
    ...(veteranRes.value || [])
  ];

  // Deduplicate by account number
  const seen = new Set();
  const deduped = allRecords.filter(r => {
    const k = (r.docNum && r.docNum.length > 3) ? `acct-${r.docNum}` : `addr-${r.address}`;
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

  console.log('Done:', JSON.stringify(summary));

  return res.status(200).json({
    success: true,
    lastUpdated: new Date().toISOString(),
    totalRecords: deduped.length,
    summary,
    errors: [],
    records: deduped
  });
};
