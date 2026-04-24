/**
 * Cloudflare Pages Function: /functions/fmp.js
 * Handles all stock data API requests via Alpha Vantage.
 *
 * Environment variable required (set in CF Pages dashboard):
 *   AV_API_KEY = your Alpha Vantage API key (free at alphavantage.co)
 *
 * Routes handled:
 *   GET /fmp?action=test              → connectivity check
 *   GET /fmp?action=history&ticker=X&period=1m|3m|1y  → price history
 *   GET /fmp?ticker=X                 → full stock fundamentals
 */

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Preflight
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase().trim();
  const period = url.searchParams.get('period') || '3m';

  const key = env.AV_API_KEY;
  if (!key) {
    return json({ error: 'AV_API_KEY environment variable not set' }, 500, corsHeaders);
  }

  try {
    // ── 1. Connection test ──────────────────────────────────
    if (action === 'test') {
      const data = await avFetch(
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=AAPL&apikey=${key}`
      );
      const ok = !!(data?.['Global Quote']?.['05. price']);
      return json({ ok }, 200, corsHeaders);
    }

    // ── 2. Price history ────────────────────────────────────
    if (action === 'history') {
      if (!ticker) return json({ error: 'ticker required' }, 400, corsHeaders);

      const outputsize = period === '1m' ? 'compact' : 'full';
      const data = await avFetch(
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=${outputsize}&apikey=${key}`
      );

      const ts = data?.['Time Series (Daily)'];
      if (!ts) return json([], 200, corsHeaders);

      const days = period === '1m' ? 30 : period === '3m' ? 90 : 365;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);

      const result = Object.entries(ts)
        .filter(([date]) => new Date(date) >= cutoff)
        .map(([date, v]) => ({ date, close: parseFloat(v['4. close']) }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      return json(result, 200, corsHeaders);
    }

    // ── 3. Full fundamentals ────────────────────────────────
    if (!ticker) return json({ error: 'ticker required' }, 400, corsHeaders);

    const [quoteData, overviewData, cashFlowData] = await Promise.all([
      avFetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${key}`),
      avFetch(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${key}`),
      avFetch(`https://www.alphavantage.co/query?function=CASH_FLOW&symbol=${ticker}&apikey=${key}`),
    ]);

    const quote = quoteData?.['Global Quote'];
    if (!quote?.['05. price']) {
      return json({ error: 'Ticker not found or API limit reached' }, 404, corsHeaders);
    }

    const ov = overviewData || {};
    const cf = cashFlowData?.annualReports?.[0] || {};

    const price    = parseFloat(quote['05. price'])            || 0;
    const eps      = parseFloat(ov['EPS'])                     || 0;
    const div      = parseFloat(ov['DividendPerShare'])        || 0;
    const beta     = parseFloat(ov['Beta'])                    || 1.2;
    const shares   = (parseFloat(ov['SharesOutstanding']) / 1e6) || 0;
    const pe       = parseFloat(ov['PERatio'])                 || 25;
    const evEbitda = parseFloat(ov['EVToEBITDA'])              || 15;
    const revGrowth = parseFloat(ov['QuarterlyRevenueGrowthYOY']) || 0.08;

    // Free cash flow: operating CF minus capex, converted to $M
    const operatingCF = parseFloat(cf['operatingCashflow'])   || 0;
    const capex       = Math.abs(parseFloat(cf['capitalExpenditures']) || 0);
    const fcf         = Math.max((operatingCF - capex) / 1e6, 0);

    // Net debt proxy from balance sheet if available
    const totalDebt   = parseFloat(cf['capitalExpenditures'])  || 0;

    const g1 = Math.min(Math.max(revGrowth * 100, 2), 30);
    const g2 = Math.min(Math.max(revGrowth * 50,  2), 20);

    const result = {
      name:     ov['Name']     || ticker,
      sector:   ov['Sector']   || '',
      industry: ov['Industry'] || '',
      price,
      eps,
      div,
      fcf,
      shares,
      debt:  totalDebt / 1e6 || 0,
      beta,
      // DCF params
      g1,
      g2,
      tg:   2.5,
      wacc: 9,
      fcfm: 22,
      // PER / EV params
      perT: Math.min(Math.max(pe, 10), 80),
      perG: Math.round(g1),
      evM:  Math.min(Math.max(evEbitda, 5), 50),
      evMg: 30,
      // Graham params
      grG: Math.round(g1 * 0.8),
      grY: 4.5,
      // DDM params
      ddmG: div > 0 ? Math.min(g1 * 0.5, 8) : 0,
      ddmR: 8,
      fromApi:   true,
      fetchedAt: Date.now(),
    };

    return json(result, 200, corsHeaders);

  } catch (err) {
    return json({ error: err.message || 'Internal error' }, 500, corsHeaders);
  }
}

// ── Helpers ──────────────────────────────────────────────────

async function avFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from Alpha Vantage`);
  return res.json();
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
