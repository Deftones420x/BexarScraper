const https = require('https');

// ─── ALL DATA FROM OFFICIAL BEXAR COUNTY OPEN ARCGIS ENDPOINTS ───────────────
// No authentication required — these are fully public REST APIs

const MS_WEIGHTS = {
  taxdel:28, fc:22, lispendens:15, probate:14, bk:12,
  judgment:10, divorce:10, multilien:8, absentee:7, vacant:6, llc:5
};

function calcScore(flags) {
  return Math.min(100, flags.reduce((s, f) => s + (MS_WEIGHTS[f] || 5), 0));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    }, (res) => {
      // Follow redirects
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

// ─── SOURCE 1: Foreclosures (ArcGIS — live, open, no auth) ────────────────────
async function fetchForeclosures() {
  const records = [];
  try {
    // Mortgage foreclosures
    const url1 = 'https://maps.bexar.org/arcgis/rest/services/CC/ForeclosuresProd/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&f=json&resultRecordCount=500';
    const r1 = await httpGet(url1);
    const d1 = JSON.parse(r1.body);
    (d1.features || []).forEach((f, i) => {
      const a = f.attributes || {};
      const addr = (a.ADDRESS || a.SITUS_ADDRESS || a.PROP_STREET || '').toUpperCase();
      const flags = ['fc'];
      records.push({
        id: `fc-mort-${a.DOCNUM || i}`,
        address: addr || 'SEE FILING',
        mailingAddress: addr,
        owner: (a.GRANTOR || a.OWNER || a.DEBTOR || 'See document').toUpperCase(),
        category: 'foreclosure',
        docType: 'NOTICE OF TRUSTEE SALE',
        date: a.SALEDATE ? new Date(a.SALEDATE).toISOString().slice(0,10) : '',
        docNum: String(a.DOCNUM || ''),
        amount: parseFloat(a.AMOUNT || a.AMT || 0) || 0,
        score: calcScore(flags),
        msFlags: flags,
        isNew: true,
        source: 'Bexar County Foreclosure Map (ArcGIS)',
        url: `https://maps.bexar.org/foreclosures/`
      });
    });

    // Tax foreclosures
    const url2 = 'https://maps.bexar.org/arcgis/rest/services/CC/ForeclosuresProd/MapServer/1/query?where=1%3D1&outFields=*&returnGeometry=false&f=json&resultRecordCount=500';
    const r2 = await httpGet(url2);
    const d2 = JSON.parse(r2.body);
    (d2.features || []).forEach((f, i) => {
      const a = f.attributes || {};
      const addr = (a.ADDRESS || a.SITUS_ADDRESS || '').toUpperCase();
      const flags = ['fc', 'taxdel'];
      records.push({
        id: `fc-tax-${a.DOCNUM || i}`,
        address: addr || 'SEE FILING',
        mailingAddress: addr,
        owner: (a.GRANTOR || a.OWNER || a.DEBTOR || 'See document').toUpperCase(),
        category: 'foreclosure',
        docType: 'TAX FORECLOSURE NOTICE',
        date: a.SALEDATE ? new Date(a.SALEDATE).toISOString().slice(0,10) : '',
        docNum: String(a.DOCNUM || ''),
        amount: parseFloat(a.AMOUNT || 0) || 0,
        score: calcScore(flags),
        msFlags: flags,
        isNew: true,
        source: 'Bexar County Foreclosure Map (ArcGIS)',
        url: `https://maps.bexar.org/foreclosures/`
      });
    });

    console.log(`Foreclosures: ${records.length} total`);
  } catch(e) {
    console.log(`Foreclosure error: ${e.message}`);
  }
  return records;
}

// ─── SOURCE 2: Tax Delinquent Properties (LGBS open feed) ─────────────────────
async function fetchTaxDelinquent() {
  const records = [];
  try {
    // Bexar County open data — delinquent tax properties
    const url = 'https://opendata.arcgis.com/datasets/a9f4d5a8c3e74e8b9f2c1d6e0b7a3f5c_0.geojson';
    // Try BCAD open parcel data with delinquent flag
    const url2 = 'https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0/query?where=DELQ_FLAG%3D%27Y%27&outFields=PROP_STREET,OWNER_NAME,MAILING_ADDR,MAILING_CITY,MAILING_STATE,MAILING_ZIP,DELQ_AMT,DELQ_YEAR&returnGeometry=false&f=json&resultRecordCount=500';
    const r = await httpGet(url2);
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      (d.features || []).forEach((f, i) => {
        const a = f.attributes || {};
        const flags = ['taxdel'];
        if ((a.OWNER_NAME || '').includes('ESTATE')) flags.push('probate');
        if ((a.OWNER_NAME || '').match(/LLC|CORP|INC|LTD/)) flags.push('llc');
        records.push({
          id: `taxdel-${i}`,
          address: (a.PROP_STREET || '').toUpperCase(),
          mailingAddress: [a.MAILING_ADDR, a.MAILING_CITY, a.MAILING_STATE, a.MAILING_ZIP].filter(Boolean).join(', ').toUpperCase(),
          owner: (a.OWNER_NAME || 'Unknown').toUpperCase(),
          category: 'tax',
          docType: 'TAX DELINQUENT',
          date: a.DELQ_YEAR ? `${a.DELQ_YEAR}-01-01` : '',
          docNum: String(a.PROP_ID || i),
          amount: parseFloat(a.DELQ_AMT || 0) || 0,
          score: calcScore(flags),
          msFlags: flags,
          isNew: false,
          source: 'Bexar County Parcels (ArcGIS)',
          url: 'https://bexar.acttax.com/act_webdev/bexar/index.jsp'
        });
      });
      console.log(`Tax delinquent from parcels: ${records.length}`);
    }
  } catch(e) {
    console.log(`Tax delinquent error: ${e.message}`);
  }
  return records;
}

// ─── SOURCE 3: LGBS Tax Sale List (monthly, open) ─────────────────────────────
async function fetchTaxSaleList() {
  const records = [];
  try {
    const url = 'https://taxsales.lgbs.com/api/properties?county=Bexar&state=TX&format=json&limit=500';
    const r = await httpGet(url);
    if (r.status === 200 && r.body.trim().startsWith('[') || r.body.trim().startsWith('{')) {
      const d = JSON.parse(r.body);
      const items = Array.isArray(d) ? d : d.properties || d.data || [];
      items.forEach((p, i) => {
        const flags = ['taxdel', 'fc'];
        records.push({
          id: `lgbs-${p.accountNumber || i}`,
          address: (p.propertyAddress || p.address || '').toUpperCase(),
          mailingAddress: (p.mailingAddress || p.propertyAddress || '').toUpperCase(),
          owner: (p.ownerName || p.owner || 'Unknown').toUpperCase(),
          category: 'tax',
          docType: 'TAX SALE LISTING',
          date: p.saleDate || '',
          docNum: String(p.accountNumber || p.caseNumber || i),
          amount: parseFloat(p.amountDue || p.totalDue || 0) || 0,
          score: calcScore(flags),
          msFlags: flags,
          isNew: true,
          source: 'LGBS Tax Sale List',
          url: 'https://taxsales.lgbs.com/'
        });
      });
      console.log(`LGBS tax sale: ${records.length}`);
    }
  } catch(e) {
    console.log(`LGBS error: ${e.message}`);
  }
  return records;
}

// ─── SOURCE 4: Bexar County Open Data Portal ──────────────────────────────────
async function fetchOpenData() {
  const records = [];
  try {
    // Try Bexar open data ArcGIS feature services
    const datasets = [
      {
        url: 'https://gis-bexar.opendata.arcgis.com/datasets/bexar::foreclosures.geojson?outSR=%7B%22latestWkid%22%3A3857%2C%22wkid%22%3A102100%7D&where=1%3D1&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&resultOffset=0&resultRecordCount=200&f=json',
        category: 'foreclosure',
        docType: 'FORECLOSURE',
        flags: ['fc']
      }
    ];

    for (const ds of datasets) {
      try {
        const r = await httpGet(ds.url);
        if (r.status === 200) {
          const d = JSON.parse(r.body);
          const features = d.features || d.results || [];
          features.forEach((f, i) => {
            const a = f.attributes || f.properties || {};
            const addr = Object.values(a).find(v => typeof v === 'string' && v.match(/\d+ \w/)) || '';
            records.push({
              id: `opendata-${ds.category}-${i}`,
              address: addr.toUpperCase(),
              mailingAddress: addr.toUpperCase(),
              owner: (a.OWNER || a.owner || a.GRANTOR || 'See record').toUpperCase(),
              category: ds.category,
              docType: ds.docType,
              date: a.DATE || a.RECORDED_DATE || a.date || '',
              docNum: String(a.DOCNUM || a.ID || a.id || i),
              amount: parseFloat(a.AMOUNT || a.amount || 0) || 0,
              score: calcScore(ds.flags),
              msFlags: ds.flags,
              isNew: true,
              source: 'Bexar Open Data Portal',
              url: 'https://gis-bexar.opendata.arcgis.com/'
            });
          });
        }
      } catch(e2) {}
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`Open data: ${records.length}`);
  } catch(e) {
    console.log(`Open data error: ${e.message}`);
  }
  return records;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  console.log('Starting multi-source Bexar County scrape...');

  // Run all sources in parallel for speed
  const [fcRecords, taxRecords, lgbsRecords, openRecords] = await Promise.allSettled([
    fetchForeclosures(),
    fetchTaxDelinquent(),
    fetchTaxSaleList(),
    fetchOpenData()
  ]);

  const allRecords = [
    ...(fcRecords.value || []),
    ...(taxRecords.value || []),
    ...(lgbsRecords.value || []),
    ...(openRecords.value || [])
  ];

  // Deduplicate
  const seen = new Set();
  const deduped = allRecords.filter(r => {
    const k = (r.docNum && r.docNum !== '0') ? r.docNum : r.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  deduped.sort((a, b) => b.score - a.score);

  const summary = {
    foreclosure: deduped.filter(r => r.category === 'foreclosure').length,
    tax: deduped.filter(r => r.category === 'tax').length,
    total: deduped.length
  };

  console.log(`Done. Total: ${deduped.length} records`);

  return res.status(200).json({
    success: true,
    lastUpdated: new Date().toISOString(),
    totalRecords: deduped.length,
    summary,
    errors: [],
    records: deduped
  });
};
