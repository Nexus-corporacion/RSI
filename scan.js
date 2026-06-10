// scan.js — Bitget Futures RSI Scanner
// Corre en GitHub Actions cada 5 min, genera signals.json

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const fs = require('fs');

const API = 'https://api.bitget.com';
const RSI_H = 75;
const RSI_L = 30;
const RSI_P = 14;
const TIMEFRAMES = ['5m', '15m', '1h']; // '1h' en minúscula para concordar con HTML
const DELAY_MS = 60; // Pausa entre cada par para evitar bloqueos de IP (429 Error)

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

function fmtPrice(p) {
  const f = parseFloat(p);
  if (f >= 1000) return f.toFixed(2);
  if (f >= 1)    return f.toFixed(4);
  return f.toFixed(6);
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

  const tickers = await fetchJSON(`${API}/api/v2/mix/market/tickers?productType=USDT-FUTURES`);
  if (!tickers || tickers.length === 0) {
    console.error('Error: no se obtuvieron tickers');
    process.exit(1);
  }

  console.log(`Pares encontrados: ${tickers.length}`);

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

  for (const tf of TIMEFRAMES) {
    console.log(`\nEscaneando Timeframe: ${tf}`);
    let highArr = [];
    let lowArr  = [];
    let scanned = 0;

    for (let i = 0; i < tickers.length; i++) {
      const t = tickers[i];
      const sym = t.symbol;

      try {
        const kl = await fetchJSON(
          `${API}/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=${tf}&limit=50`
        );

        if (!kl || kl.length < 25) continue;

        const closes = kl.map(k => parseFloat(k[4])).reverse();
        const rsi = calcRSI(closes, RSI_P);
        
        if (rsi !== null) {
          const rv = Math.round(rsi * 10) / 10;
          const entry = {
            sym: sym,
            rsi: rv,
            price: fmtPrice(t.lastPr || closes[closes.length - 1]),
            change: parseFloat(parseFloat(t.change24h || 0).toFixed(2))
          };

          if (rv >= RSI_H) highArr.push(entry);
          else if (rv <= RSI_L) lowArr.push(entry);
          scanned++;
        }
      } catch (e) {
        // Error individual de par, continuar con el siguiente
      }

      // Pausa obligatoria por cada par para no ser bloqueado por la API
      await sleep(DELAY_MS);
      
      if (i % 50 === 0 && i > 0) console.log(`... procesados ${i}/${tickers.length} pares`);
    }

    result.signals[tf] = {
      scanned,
      high: highArr.sort((a, b) => b.rsi - a.rsi),
      low:  lowArr.sort((a, b) => a.rsi - b.rsi)
    };
    
    console.log(`Terminado ${tf}: ${highArr.length} Altos, ${lowArr.length} Bajos`);
  }

  fs.writeFileSync('signals.json', JSON.stringify(result, null, 2));
  console.log(`\n✅ Proceso finalizado. signals.json actualizado.`);
}

main().catch(err => {
  console.error('Error fatal en el script:', err);
  process.exit(1);
});
