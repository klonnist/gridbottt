/*
 * Client-side grid-strategy backtester. Runs entirely in the browser: fetches
 * historical OKX perp candles (public, no key) for the chosen date range and
 * replays the exact same grid logic as bot/grid_engine.py (ported to JS here)
 * against them. Nothing is persisted -- every run is a fresh in-memory
 * simulation triggered by the "Calistir" button.
 */

const SYMBOLS = {
  BTC: "BTC-USDT-SWAP",
  ETH: "ETH-USDT-SWAP",
  XRP: "XRP-USDT-SWAP",
  AVAX: "AVAX-USDT-SWAP",
  SOL: "SOL-USDT-SWAP",
  DOT: "DOT-USDT-SWAP",
  NEAR: "NEAR-USDT-SWAP",
  ETHFI: "ETHFI-USDT-SWAP",
};

const OKX_BASE = "https://www.okx.com";
const BAR_MS = { "15m": 15 * 60_000, "1H": 60 * 60_000, "4H": 4 * 60 * 60_000, "1D": 24 * 60 * 60_000 };
const ALL_BARS = ["15m", "1H", "4H", "1D"];
const MAX_PAGES_PER_COIN = 300; // safety cap ~= 30,000 candles per coin per run
const PAGE_CONCURRENCY = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// OKX fetch layer
// ---------------------------------------------------------------------------

async function fetchJsonRetry(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      const body = await res.json();
      if (body.code !== "0") throw new Error(body.msg || `OKX error code ${body.code}`);
      return body;
    } catch (err) {
      lastErr = err;
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

/** Fetches every candle in [fetchStartTs, endTs] for instId/bar, oldest->newest. */
async function fetchHistoryCandlesRange(instId, bar, fetchStartTs, endTs, onProgress) {
  const ms = BAR_MS[bar];
  const estimatedCandles = Math.ceil((endTs - fetchStartTs) / ms) + 5;
  const pages = Math.max(1, Math.ceil(estimatedCandles / 100));
  if (pages > MAX_PAGES_PER_COIN) {
    throw new Error(
      `Tarih araligi bu zaman dilimi icin cok uzun (${pages} istek gerekir). Daha kisa bir araligi veya daha buyuk bir zaman dilimini deneyin.`
    );
  }

  const cursors = [];
  let cursor = endTs + ms;
  for (let i = 0; i < pages; i++) {
    cursors.push(cursor);
    cursor -= 100 * ms;
  }

  const found = new Map();
  let nextIdx = 0;
  let completed = 0;

  async function worker() {
    while (nextIdx < cursors.length) {
      const myIdx = nextIdx++;
      const after = cursors[myIdx];
      const url = `${OKX_BASE}/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=100&after=${after}`;
      try {
        const body = await fetchJsonRetry(url);
        for (const row of body.data) {
          const ts = Number(row[0]);
          if (ts >= fetchStartTs && ts <= endTs) {
            found.set(ts, { ts, open: +row[1], high: +row[2], low: +row[3], close: +row[4] });
          }
        }
      } catch (err) {
        console.warn(`Candle page failed for ${instId} ${bar}`, err);
      }
      completed++;
      if (onProgress) onProgress(completed, cursors.length);
    }
  }

  await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, worker));
  return Array.from(found.values()).sort((a, b) => a.ts - b.ts);
}

// ---------------------------------------------------------------------------
// Grid engine (mirrors bot/grid_engine.py)
// ---------------------------------------------------------------------------

function buildGridLines(lower, upper, levels) {
  const step = (upper - lower) / levels;
  return Array.from({ length: levels + 1 }, (_, i) => lower + i * step);
}

function computeGridBounds(lookbackCandles, pad) {
  const highs = lookbackCandles.map((c) => c.high);
  const lows = lookbackCandles.map((c) => c.low);
  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  return { lower: recentLow * (1 - pad), upper: recentHigh * (1 + pad) };
}

function initCoinState(lower, upper, levels, marginUsd, leverage) {
  return {
    lower,
    upper,
    gridLevels: levels,
    gridLines: buildGridLines(lower, upper, levels),
    notionalPerCell: (marginUsd * leverage) / levels,
    marginUsd,
    leverage,
    cells: Array.from({ length: levels }, () => ({ status: "empty", entryPrice: null, qty: null, openedAt: null })),
    lastPrice: null,
    realizedPnl: 0,
    tradesCount: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
  };
}

/** Advances state by one price tick. Opening a cell is not a trade record --
 * one round-trip (buy+sell) is pushed into tradesOut only when it closes. */
function processTick(symbol, state, price, ts, tradesOut) {
  const prev = state.lastPrice;
  if (prev === null) {
    state.lastPrice = price;
    return;
  }
  const { gridLines: lines, cells, notionalPerCell: notional } = state;

  if (price < prev) {
    for (let i = 0; i < cells.length; i++) {
      const line = lines[i];
      if (price <= line && line < prev && cells[i].status === "empty") {
        const qty = notional / line;
        cells[i] = { status: "filled", entryPrice: line, qty, openedAt: ts };
      }
    }
  } else if (price > prev) {
    for (let j = 1; j < lines.length; j++) {
      const line = lines[j];
      const idx = j - 1;
      if (prev < line && line <= price && cells[idx].status === "filled") {
        const cell = cells[idx];
        const pnl = cell.qty * (line - cell.entryPrice);
        state.realizedPnl += pnl;
        state.tradesCount++;
        if (pnl > 0) state.wins++;
        else if (pnl < 0) state.losses++;
        else state.breakeven++;
        tradesOut.push({
          coin: symbol,
          side: "long",
          entryPrice: cell.entryPrice,
          exitPrice: line,
          qty: cell.qty,
          pnl,
          openedAt: cell.openedAt,
          closedAt: ts,
        });
        cells[idx] = { status: "empty", entryPrice: null, qty: null, openedAt: null };
      }
    }
  }
  state.lastPrice = price;
}

/** Approximates the intra-candle path so crossings aren't missed between OHLC ticks. */
function candleSubticks(candle) {
  return candle.close >= candle.open
    ? [candle.open, candle.low, candle.high, candle.close]
    : [candle.open, candle.high, candle.low, candle.close];
}

function simulateCoin(symbol, lookbackCandles, simCandles, { marginUsd, leverage, gridLevels, gridPad }) {
  if (lookbackCandles.length === 0 || simCandles.length === 0) {
    return { symbol, error: "Yeterli gecmis veri yok", trades: [], equityPoints: [], state: null };
  }
  const { lower, upper } = computeGridBounds(lookbackCandles, gridPad);
  const state = initCoinState(lower, upper, gridLevels, marginUsd, leverage);
  const trades = [];
  const equityPoints = [];

  for (const candle of simCandles) {
    for (const p of candleSubticks(candle)) processTick(symbol, state, p, candle.ts, trades);
    const unrealized = state.cells.reduce(
      (sum, c) => (c.status === "filled" ? sum + c.qty * (candle.close - c.entryPrice) : sum),
      0
    );
    equityPoints.push({ ts: candle.ts, equity: marginUsd + state.realizedPnl + unrealized });
  }

  return { symbol, trades, equityPoints, state, lower, upper };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function buildTotalEquityCurve(perCoinResults, marginUsd) {
  const tsSet = new Set();
  perCoinResults.forEach((r) => (r.equityPoints || []).forEach((p) => tsSet.add(p.ts)));
  const master = Array.from(tsSet).sort((a, b) => a - b);
  const ptrs = perCoinResults.map(() => -1);
  const lastVal = perCoinResults.map(() => marginUsd);

  return master.map((ts) => {
    let total = 0;
    perCoinResults.forEach((r, i) => {
      const pts = r.equityPoints || [];
      while (ptrs[i] + 1 < pts.length && pts[ptrs[i] + 1].ts <= ts) {
        ptrs[i]++;
        lastVal[i] = pts[ptrs[i]].equity;
      }
      total += lastVal[i];
    });
    return { ts, equity: total };
  });
}

function computeMaxDrawdownPct(curve) {
  let peak = -Infinity;
  let maxDD = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (p.equity - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }
  return Math.abs(maxDD) * 100;
}

function aggregateStats(perCoinResults, initialTotalBalance, marginUsd) {
  const allTrades = perCoinResults.flatMap((r) => r.trades || []);
  const closed = allTrades; // every recorded trade is already a closed round trip
  const wins = closed.filter((t) => t.pnl > 0).length;
  const losses = closed.filter((t) => t.pnl < 0).length;
  const breakeven = closed.filter((t) => t.pnl === 0).length;
  const totalRealized = perCoinResults.reduce((s, r) => s + (r.state ? r.state.realizedPnl : 0), 0);
  const totalUnrealized = perCoinResults.reduce((s, r) => {
    if (!r.equityPoints || !r.equityPoints.length || !r.state) return s;
    const lastPoint = r.equityPoints[r.equityPoints.length - 1];
    return s + (lastPoint.equity - marginUsd - r.state.realizedPnl);
  }, 0);
  const endBalance = initialTotalBalance + totalRealized + totalUnrealized;
  const equityCurve = buildTotalEquityCurve(perCoinResults, marginUsd);

  return {
    allTrades,
    closedCount: closed.length,
    wins,
    losses,
    breakeven,
    winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
    startBalance: initialTotalBalance,
    endBalance,
    totalPnl: endBalance - initialTotalBalance,
    returnPct: ((endBalance - initialTotalBalance) / initialTotalBalance) * 100,
    maxDrawdownPct: computeMaxDrawdownPct(equityCurve),
    equityCurve,
  };
}

// ---------------------------------------------------------------------------
// Public entry points used by backtest.html's inline UI script
// ---------------------------------------------------------------------------

async function fetchAllCoinCandles(symbols, bar, startTs, endTs, lookbackDays, onProgress) {
  const fetchStart = startTs - lookbackDays * 86_400_000;
  const perCoin = {};
  for (const symbol of symbols) {
    const instId = SYMBOLS[symbol];
    const candles = await fetchHistoryCandlesRange(instId, bar, fetchStart, endTs, (done, total) =>
      onProgress ? onProgress(symbol, done, total) : null
    );
    perCoin[symbol] = {
      lookback: candles.filter((c) => c.ts < startTs),
      sim: candles.filter((c) => c.ts >= startTs && c.ts <= endTs),
    };
  }
  return perCoin;
}

function runSimulationFromCache(cachedCandles, symbols, settings) {
  const perCoinResults = symbols.map((symbol) => {
    const data = cachedCandles[symbol] || { lookback: [], sim: [] };
    return simulateCoin(symbol, data.lookback, data.sim, settings);
  });
  const stats = aggregateStats(perCoinResults, settings.initialBalance, settings.marginUsd);
  return { perCoinResults, stats };
}

window.GridBacktest = {
  SYMBOLS,
  ALL_BARS,
  BAR_MS,
  fetchAllCoinCandles,
  runSimulationFromCache,
};
