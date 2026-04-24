/**
 * Cloudflare Pages Function: /functions/fmp.js
 * (Keep this file for when you deploy to Cloudflare Pages)
 * For local dev, use server.js instead.
 */

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response('', { status: 200, headers: corsHeaders });

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase().trim();
  const period = url.searchParams.get('period') || '3m';
  const key = env.AV_API_KEY;
  if (!key) return json({ error: 'AV_API_KEY not set' }, 500, corsHeaders);

  try {
    if (action === 'test') {
      const data = await avFetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=AAPL&apikey=${key}`);
      return json({ ok: !!(data?.['Global Quote']?.['05. price']) }, 200, corsHeaders);
    }
    if (action === 'history') {
      if (!ticker) return json({ error: 'ticker required' }, 400, corsHeaders);
      const outputsize = period === '1m' ? 'compact' : 'full';
      const data = await avFetch(`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=${outputsize}&apikey=${key}`);
      const ts = data?.['Time Series (Daily)'];
      if (!ts) return json([], 200, corsHeaders);
      const days = period === '1m' ? 30 : period === '3m' ? 90 : 365;
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
      const result = Object.entries(ts).filter(([date]) => new Date(date) >= cutoff).map(([date, v]) => ({ date, close: parseFloat(v['4. close']) })).sort((a, b) => new Date(a.date) - new Date(b.date));
      return json(result, 200, corsHeaders);
    }
    if (!ticker) return json({ error: 'ticker required' }, 400, corsHeaders);
    const quoteData = await avFetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${key}`);
    const quote = quoteData?.['Global Quote'];
    if (!quote?.['05. price']) {
      if (quoteData?.['Note'] || quoteData?.['Information']) return json({ error: 'Rate limit reached.' }, 429, corsHeaders);
      return json({ error: 'Ticker not found' }, 404, corsHeaders);
    }
    await sleep(300);
    const ov = await avFetch(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${key}`) || {};
    await sleep(300);
    const cashFlowData = await avFetch(`https://www.alphavantage.co/query?function=CASH_FLOW&symbol=${ticker}&apikey=${key}`);
    const cf = cashFlowData?.annualReports?.[0] || {};
    const price = parseFloat(quote['05. price']) || 0;
    const eps = parseFloat(ov['EPS']) || 0;
    const div = parseFloat(ov['DividendPerShare']) || 0;
    const beta = parseFloat(ov['Beta']) || 1.2;
    const shares = (parseFloat(ov['SharesOutstanding']) / 1e6) || 0;
    const pe = parseFloat(ov['PERatio']) || 25;
    const evEbitda = parseFloat(ov['EVToEBITDA']) || 15;
    const revGrowthRaw = parseFloat(ov['QuarterlyRevenueGrowthYOY']) || 0.08;
    const revGrowthPct = Math.abs(revGrowthRaw) < 2 ? revGrowthRaw * 100 : revGrowthRaw;
    const operatingCF = parseFloat(cf['operatingCashflow']) || 0;
    const capex = Math.abs(parseFloat(cf['capitalExpenditures']) || 0);
    const fcf = Math.max((operatingCF - capex) / 1e6, 0);
    const longTermDebt = parseFloat(cf['longTermDebt']) || 0;
    const shortTermDebt = parseFloat(cf['shortLongTermDebtTotal']) || 0;
    const cashAndEq = parseFloat(ov['CashAndCashEquivalentsAtCarryingValue']) || 0;
    const netDebt = Math.max(longTermDebt + shortTermDebt - cashAndEq, 0) / 1e6;
    const g1 = Math.min(Math.max(revGrowthPct, 2), 30);
    const g2 = Math.min(Math.max(revGrowthPct * 0.6, 2), 20);
    return json({ name: ov['Name'] || ticker, sector: ov['Sector'] || '', industry: ov['Industry'] || '', price, eps, div, fcf, shares, debt: netDebt, beta, g1, g2, tg: 2.5, wacc: 9, fcfm: 22, perT: Math.min(Math.max(pe, 10), 80), perG: Math.round(g1), evM: Math.min(Math.max(evEbitda, 5), 50), evMg: 30, grG: Math.round(g1 * 0.8), grY: 4.5, ddmG: div > 0 ? Math.min(g1 * 0.5, 8) : 0, ddmR: 8, fromApi: true, fetchedAt: Date.now() }, 200, corsHeaders);
  } catch (err) {
    return json({ error: err.message }, 500, corsHeaders);
  }
}

async function avFetch(url) { const res = await fetch(url); if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function json(data, status, headers) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } }); }
