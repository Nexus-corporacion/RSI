// scan.js — Bitget Futures RSI Scanner
// Corre en GitHub Actions cada 5 min, genera signals.json

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const fs = require('fs');

const API = 'https://api.bitget.com';
const RSI_H = 90;
const RSI_L = 15;
const RSI_P = 14;
const TIMEFRAMES = ['5m', '15m', '1H'];
const BATCH_SIZE = 5;
const DELAY_BATCH = 300;  // ms entre batches
const DELAY_TF = 3000;    // ms entre timeframes

// Headers que simulan browser real
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://www.bitget.com',
  'Referer': 'https://www.bitget.com/',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive'
};

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

function rsiLabel(rsi) {
  if (rsi >= 95) return 'EXTREMO';
  if (rsi >= 92) return 'MUY ALTO';
  if (rsi >= RSI_H) return 'ALTO';
  if (rsi <= 5)  return 'EXTREMO';
  if (rsi <= 10) return 'MUY BAJO';
  return 'BAJO';
}

function fmtPrice(p) {
  const f = parseFloat(p);
  if (f >= 1000) return f.toFixed(2);
  if (f >= 1)    return f.toFixed(4);
  if (f >= 0.01) return f.toFixed(5);
  return f.toFixed(8);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(url, {
        headers: HEADERS,
        timeout: 12000
      });
      if (r.status === 429) {
        console.log(`  Rate limit en ${url} — esperando 5s...`);
        await sleep(5000);
        continue;
      }
      if (!r.ok) {
        if (attempt < retries - 1) await sleep(1000);
        continue;
      }
      const d = await r.json();
      return d.data || null;
    } catch (e) {
      if (attempt < retries - 1) await sleep(1500);
    }
  }
  return null;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Iniciando scan Bitget Futures...`);

  // Traer todos los tickers
  const tickers = await fetchJSON(`${API}/api/v2/mix/market/tickers?productType=USDT-FUTURES`);
  if (!tickers || tickers.length === 0) {
    console.error('Error: no se obtuvieron tickers — Bitget puede estar bloqueando');

    // Si ya existe signals.json, mantenerlo y solo actualizar timestamp
    if (fs.existsSync('signals.json')) {
      const existing = JSON.parse(fs.readFileSync('signals.json', 'utf8'));
      existing.last_attempt = new Date().toISOString();
      existing.error = 'No se pudo conectar a Bitget';
      fs.writeFileSync('signals.json', JSON.stringify(existing, null, 2));
      console.log('signals.json existente mantenido');
    }
    process.exit(0); // exit 0 para no marcar el Action como fallido
  }

  console.log(`✅ Tickers obtenidos: ${tickers.length} pares`);

  const result = {
    updated: new Date().toISOString(),
    updated_ts: Date.now(),
    total_pairs: tickers.length,
    signals: {
      '5m':  { scanned: 0, high: [], low: [] },
      '15m': { scanned: 0, high: [], low: [] },
      '1H':  { scanned: 0, high: [], low: [] }
    }
  };

  for (const tf of TIMEFRAMES) {
    console.log(`\n📊 Escaneando TF: ${tf}`);
    let scanned = 0;
    let highArr = [];
    let lowArr  = [];

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (t) => {
        const sym = t.symbol;
        try {
          const kl = await fetchJSON(
            `${API}/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=${tf}&limit=50`
          );
          if (!kl || kl.length < 20) return;

          const closes = kl.map(k => parseFloat(k[4])).reverse();
          const rsi = calcRSI(closes, RSI_P);
          if (rsi === null) return;

          const rv = Math.round(rsi * 10) / 10;
          const price = parseFloat(t.lastPr || t.last || closes[closes.length - 1]);
          const change = parseFloat(t.change24h || t.priceChangePercent || 0);
          const vol = parseFloat(t.usdtVolume || t.quoteVol || 0);

          const entry = {
            sym,
            rsi: rv,
            price: fmtPrice(price),
            change: parseFloat(change.toFixed(2)),
            vol,
            label: rsiLabel(rv)
          };

          if (rsi >= RSI_H) {
            highArr.push(entry);
            console.log(`  🔴 ${sym} RSI ${rv} [${tf}]`);
          } else if (rsi <= RSI_L) {
            lowArr.push(entry);
            console.log(`  🟢 ${sym} RSI ${rv} [${tf}]`);
          }
          scanned++;
        } catch (e) {}
      }));

      await sleep(DELAY_BATCH);

      // Log progreso cada 50 pares
      if (i % 50 === 0 && i > 0) {
        console.log(`  Progreso ${tf}: ${i}/${tickers.length} — ${highArr.length}H ${lowArr.length}L`);
      }
    }

    highArr.sort((a, b) => b.rsi - a.rsi);
    lowArr.sort((a, b) => a.rsi - b.rsi);

    result.signals[tf] = { scanned, high: highArr, low: lowArr };
    console.log(`  ✅ ${tf}: ${scanned} escaneados | ${highArr.length} altos | ${lowArr.length} bajos`);

    if (tf !== TIMEFRAMES[TIMEFRAMES.length - 1]) await sleep(DELAY_TF);
  }

  fs.writeFileSync('signals.json', JSON.stringify(result, null, 2));
  const total5m = result.signals['5m'].high.length + result.signals['5m'].low.length;
  console.log(`\n✅ signals.json guardado — ${total5m} señales en 5m`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(0); // exit 0 para no romper el workflow
});
