const https = require('https');

const BASE_HOST = 'bexar.tx.publicsearch.us';

const DOC_TYPES = {
  foreclosure: { label: 'Foreclosure / Trustee Sale', category: 'foreclosure', codes: ['NOTS','SUBST','FOREC','NOSAL','NOTRS'] },
  deed:        { label: 'Deeds', category: 'deed', codes: ['WARRD','QUITD','SPWRD','DEED','DEEDT'] },
  lien:        { label: 'Liens', category: 'lien', codes: ['TAXLN','MECHL','HOALN','JUDLN','IRSLN','FEDTL'] },
  probate:     { label: 'Probate / Heirship', category: 'probate', codes: ['PROBAT','HEIRSH','AFFH','WILL','LTTEST'] },
  lispendens:  { label: 'Lis Pendens', category: 'lispendens', codes: ['LISPEN','LISPN'] },
  court:       { label: 'Bankruptcy / Divorce / Eviction', category: 'court', codes: ['BANKR','DIVRC','EVICT','FED','CH7','CH13'] }
};

const MS_WEIGHTS = {
  taxdel:28, fc:22, lispendens:15, probate:14, bk:12,
  judgment:10, divorce:10, multilien:8, absentee:7, vacant:6, llc:5
};

function calcScore(flags) {
  return Math.min(100, flags.reduce((s, f) => s + (MS_WEIGHTS[f] || 5), 0));
}

function getMSFlags(category, docType) {
  const flags = [];
  const doc = (docType || '').toLowerCase();
  if (category === 'foreclosure') flags.push('fc');
  if (category === 'lispendens') { flags.push('lispendens'); flags.push('fc'); }
  if (category === 'probate') flags.push('probate');
  if (category === 'lien') {
    if (doc.includes('tax') || doc.includes('irs') || doc.includes('federal')) flags.push('taxdel');
    if (doc.includes('judg')) flags.push('judgment');
    flags.push('multilien');
  }
  if (category === 'court') {
    if (doc.includes('bankr') || doc.includes('ch')) flags.push('bk');
    if (doc.includes('divorc')) flags.push('divorce');
  }
  return [...new Set(flags)];
}

function getDateRange() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10).replace(/-/g, '');
  const from = new Date(now - 14 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10).replace(/-/g, '');
  return { from, to };
}

function fetchAPI(codes, fromDate, toDate, offset) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      department: 'RP',
      docTypes: codes.join(','),
      limit: '200',
      offset: String(offset || 0),
      recordedDateRange: `${fromDate},${toDate}`,
      searchType: 'advancedSearch',
      keywordSearch: 'false',
      searchOcrText: 'false'
    });

    const path = `/api/search/instruments?${params.toString()}`;

    const options = {
      hostname: BASE_HOST,
      path: path,
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://bexar.tx.publicsearch.us/results',
        'Origin': 'https://bexar.tx.publicsearch.us',
        'x-requested-with': 'XMLHttpRequest'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function parseAPIResponse(body, category, label) {
  const records = [];
  try {
    const json = JSON.parse(body);
    const items = json.results || json.data || json.instruments ||
                  json.searchResults || json.items || json.records ||
                  (Array.isArray(json) ? json : null);

    if (!items || !items.length) {
      console.log(`  No items. Keys: ${Object.keys(json).join(', ')} | totalCount: ${json.totalCount || json.total || 'n/a'}`);
      return records;
    }

    items.forEach((r, i) => {
      const docType = r.docType || r.instrumentType || r.documentType || r.type || label;
      const docNum = r.documentNumber || r.instrumentNumber || r.docNum || r.id || '';
      const recDate = r.recordedDate || r.instrumentDate || r.filedDate || r.date || '';
      const parties = r.parties || r.grantors || [];
      let owner = 'Unknown Owner';
      if (Array.isArray(parties) && parties.length > 0) {
        owner = (parties[0].name || parties[0].fullName ||
          ((parties[0].lastName || '') + ' ' + (parties[0].firstName || '')).trim() ||
          'Unknown').toUpperCase().trim();
      } else if (r.grantor) { owner = String(r.grantor).toUpperCase(); }
      else if (r.owner) { owner = String(r.owner).toUpperCase(); }

      const address = (r.legalDescription || r.address || r.situs ||
                       r.propertyAddress || r.legalDesc || '').toString().toUpperCase();
      const mailingAddress = (r.mailingAddress || r.mailing_address || '').toString().toUpperCase();
      const msFlags = getMSFlags(category, docType);
      const score = calcScore(msFlags);

      records.push({
        id: `${category}-${docNum || i}-${Date.now()}`,
        address: address || 'SEE DOCUMENT',
        mailingAddress: mailingAddress || address,
        owner,
        category,
        docType: docType.toString().toUpperCase(),
        date: recDate,
        docNum: String(docNum),
        score, msFlags,
        isNew: true,
        source: 'publicsearch',
        url: `https://bexar.tx.publicsearch.us/doc/${docNum}`
      });
    });
    console.log(`  Parsed ${records.length} records`);
  } catch (e) {
    console.log(`  Parse error: ${e.message} | Body: ${body.slice(0, 300)}`);
  }
  return records;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { from, to } = getDateRange();
  const allRecords = [];
  const errors = [];
  const summary = {};
  const debug = [];

  for (const [key, docGroup] of Object.entries(DOC_TYPES)) {
    try {
      const response = await fetchAPI(docGroup.codes, from, to, 0);
      const ct = response.headers['content-type'] || '';
      debug.push({ type: key, status: response.status, ct, preview: response.body.slice(0, 200) });

      if (response.status === 200 && (ct.includes('json') || response.body.trim().startsWith('{') || response.body.trim().startsWith('['))) {
        const records = parseAPIResponse(response.body, docGroup.category, docGroup.label);
        allRecords.push(...records);
        summary[key] = records.length;
      } else {
        errors.push(`${key}: HTTP ${response.status} | ${ct} | ${response.body.slice(0,100)}`);
        summary[key] = 0;
      }
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
      summary[key] = 0;
    }
  }

  const seen = new Set();
  const deduped = allRecords.filter(r => {
    const k = r.docNum || r.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.sort((a, b) => b.score - a.score);

  return res.status(200).json({
    success: true,
    lastUpdated: new Date().toISOString(),
    fetchedFrom: `${from} to ${to}`,
    totalRecords: deduped.length,
    summary, errors, debug,
    records: deduped
  });
};
