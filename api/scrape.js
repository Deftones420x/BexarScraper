const https = require('https');

const DOC_TYPES = {
  foreclosure: { label: 'Foreclosure / Trustee Sale', category: 'foreclosure', codes: ['NOTS','SUBST','FOREC','NOSAL','NOTRS'] },
  deed: { label: 'Deeds', category: 'deed', codes: ['WARRD','QUITD','SPWRD','DEED','DEEDT'] },
  lien: { label: 'Liens', category: 'lien', codes: ['TAXLN','MECHL','HOALN','JUDLN','IRSLN','FEDTL'] },
  probate: { label: 'Probate / Heirship', category: 'probate', codes: ['PROBAT','HEIRSH','AFFH','WILL','LTTEST'] },
  lispendens: { label: 'Lis Pendens', category: 'lispendens', codes: ['LISPEN','LISPN'] },
  court: { label: 'Bankruptcy / Divorce / Eviction', category: 'court', codes: ['BANKR','DIVRC','EVICT','FED','CH7','CH13'] }
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
    if (doc.includes('bankr')) flags.push('bk');
    if (doc.includes('divorc')) flags.push('divorce');
  }
  return [...new Set(flags)];
}

function buildURL(codes, fromDate, toDate) {
  const params = new URLSearchParams({
    department: 'RP',
    docTypes: codes.join(','),
    limit: '250',
    offset: '0',
    recordedDateRange: `${fromDate},${toDate}`,
    searchType: 'advancedSearch',
    keywordSearch: 'false',
    searchOcrText: 'false'
  });
  return `https://bexar.tx.publicsearch.us/results?${params.toString()}`;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://bexar.tx.publicsearch.us/'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function parseRecords(html, category, label) {
  const records = [];
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const results = nextData?.props?.pageProps?.results || nextData?.props?.pageProps?.searchResults || [];
      results.forEach((r, i) => {
        const docType = r.docType || r.instrumentType || label;
        const parties = r.parties || [];
        const owner = Array.isArray(parties) && parties.length > 0
          ? (parties[0].name || 'Unknown').toUpperCase() : 'Unknown Owner';
        const address = (r.legalDescription || r.address || r.situs || '').toUpperCase();
        const docNum = r.documentNumber || r.instrumentNumber || '';
        const msFlags = getMSFlags(category, docType);
        records.push({
          id: `${category}-${docNum || i}-${Date.now()}`,
          address: address || 'SEE DOCUMENT',
          owner,
          category,
          docType: docType.toUpperCase(),
          date: r.recordedDate || r.instrumentDate || '',
          docNum,
          score: calcScore(msFlags),
          msFlags,
          isNew: true,
          source: 'publicsearch',
          url: `https://bexar.tx.publicsearch.us/doc/${docNum}`
        });
      });
    } catch(e) {}
  }
  return records;
}

function getDateRange() {
  const now = new Date();
  const to = now.toISOString().slice(0,10).replace(/-/g,'');
  const from = new Date(now - 7*24*60*60*1000).toISOString().slice(0,10).replace(/-/g,'');
  return { from, to };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { from, to } = getDateRange();
  const allRecords = [];
  const errors = [];
  const summary = {};

  for (const [key, docGroup] of Object.entries(DOC_TYPES)) {
    try {
      const url = buildURL(docGroup.codes, from, to);
      const response = await httpGet(url);
      if (response.status === 200) {
        const records = parseRecords(response.body, docGroup.category, docGroup.label);
        allRecords.push(...records);
        summary[key] = records.length;
      } else {
        errors.push(`${key}: HTTP ${response.status}`);
        summary[key] = 0;
      }
      await new Promise(r => setTimeout(r, 1500));
    } catch(err) {
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
    summary,
    errors,
    records: deduped
  });
};
