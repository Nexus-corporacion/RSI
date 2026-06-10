// scan.js — Bitget Futures RSI Scanner
// Corre en GitHub Actions cada 5 min, genera signals.json

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const fs = require('fs');

const API = 'https://api.bitget.com';
const RSI_H = 75;
const RSI_L = 30;
const RSI_P = 14;
const TIMEFRAMES = ['5m', '15m', '1h'];
const DELAY_MS = 120; // delay entre calls para no saturar API

// ─── RSI CALCULATION ───────────────────────────────────────
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

function rsiLabel(rsi, type) {
  if (type === 'high') {
    if (rsi >= 95) return 'EXTREMO';
    if (rsi >= 92) return 'MUY ALTO';
    return 'ALTO';
  } else {
    if (rsi <= 5)  return 'EXTREMO';
    if (rsi <= 10) return 'MUY BAJO';
    return 'BAJO';
  }
}

function fmtPrice(p) {
  const f = parseFloat(p);
  if (f >= 1000) return f.toFixed(2);
  if (f >= 1)    return f.toFixed(4);
  if (f >= 0.01) return f.toFixed(5);
  return f.toFixed(8);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── FETCH HELPERS ─────────────────────────────────────────
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { timeout: 10000 });
    if (!r.ok) return null;
    const d = await r.json();
    return d.data || null;
  } catch (e) {
    return null;
  }
}

// ─── MAIN SCAN ─────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Iniciando scan Bitget Futures...`);

  // 1. Traer todos los tickers de una sola llamada
  const tickers = await fetchJSON(`${API}/api/v2/mix/market/tickers?productType=USDT-FUTURES`);
  if (!tickers || tickers.length === 0) {
    console.error('Error: no se obtuvieron tickers');
    process.exit(1);
  }

  console.log(`Total pares: ${tickers.length}`);

  // Mapa de tickers para acceso rápido
  const tickerMap = {};
  for (const t of tickers) {
    tickerMap[t.symbol] = t;
  }

  // Estructura de resultado
  const result = {
    updated: new Date().toISOString(),
    updated_ts: Date.now(),
    total_pairs: tickers.length,
    signals: {
      '5m':  { scanned: 0, high: [], low: [] },
      '15m': { scanned: 0, high: [], low: [] },
      '1h':  { scanned: 0, high: [], low: [] }
    }
  };

  // 2. Para cada timeframe, calcular RSI de todos los pares
  for (const tf of TIMEFRAMES) {
    console.log(`\nEscaneando TF: ${tf}`);
    let scanned = 0;
    let highArr = [];
    let lowArr  = [];

    for (let i = 0; i < tickers.length; i++) {
      const t = tickers[i];
      const sym = t.symbol;

      try {
        const kl = await fetchJSON(
          `${API}/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=${tf}&limit=50`
        );

        if (!kl || kl.length < 20) continue;

        // Bitget devuelve velas en orden desc [0] = más reciente
        const closes = kl.map(k => parseFloat(k[4])).reverse();
        const rsi = calcRSI(closes, RSI_P);
        if (rsi === null) continue;

        const rv = Math.round(rsi * 10) / 10;
        const price = parseFloat(t.lastPr || t.last || closes[closes.length - 1]);
        const change = parseFloat(t.change24h || t.priceChangePercent || 0);
        const vol = parseFloat(t.usdtVolume || t.quoteVol || 0);

        const entry = {
          sym,
          rsi: rv,
          price: fmtPrice(price),
          change: parseFloat(change.toFixed(2)),
          vol: vol,
          label: rsiLabel(rv, rv >= RSI_H ? 'high' : 'low')
        };

        if (rsi >= RSI_H) {
          highArr.push(entry);
          console.log(`  🔴 ${sym} RSI ${rv} [${tf}]`);
        } else if (rsi <= RSI_L) {
          lowArr.push(entry);
          console.log(`  🟢 ${sym} RSI ${rv} [${tf}]`);
        }

        scanned++;

      } catch (e) {
        // silencioso
      }

      // Delay cada 10 pares para no saturar
      if (i % 10 === 9) await sleep(DELAY_MS);
    }

    // Ordenar: altos de mayor a menor, bajos de menor a mayor
    highArr.sort((a, b) => b.rsi - a.rsi);
    lowArr.sort((a, b) => a.rsi - b.rsi);

    result.signals[tf] = {
      scanned,
      high: highArr,
      low:  lowArr
    };

    console.log(`  → ${tf}: ${scanned} escaneados | ${highArr.length} altos | ${lowArr.length} bajos`);
  }

  // 3. Guardar signals.json
  fs.writeFileSync('signals.json', JSON.stringify(result, null, 2));
  console.log(`\n✅ signals.json guardado — ${result.signals['5m'].high.length + result.signals['5m'].low.length} señales en 5m`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
