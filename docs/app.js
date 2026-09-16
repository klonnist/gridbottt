const INITIAL_BALANCE = 10000.0;

const fmtUsd = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const fmtDate = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
};
const pnlClass = (n) => (n >= 0 ? "positive" : "negative");

async function fetchJson(path, fallback) {
  try {
    const res = await fetch(`${path}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`Failed to load ${path}`, err);
    return fallback;
  }
}

function computeCoinStats(symbol, coinState, trades) {
  const coinTrades = trades.filter((t) => t.coin === symbol);
  const wins = coinTrades.filter((t) => t.pnl >= 0).length;
  const losses = coinTrades.filter((t) => t.pnl < 0).length;
  const totalClosed = wins + losses;
  const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;
  const avgPnl = totalClosed > 0 ? coinState.realized_pnl / totalClosed : 0;
  const equity = (coinState.margin_usd || 0) + (coinState.realized_pnl || 0) + (coinState.unrealized_pnl || 0);
  const openLots = (coinState.cells || []).filter((c) => c.status === "filled").length;

  return {
    symbol,
    equity,
    realizedPnl: coinState.realized_pnl || 0,
    unrealizedPnl: coinState.unrealized_pnl || 0,
    wins,
    losses,
    totalClosed,
    winRate,
    avgPnl,
    openLots,
    tradesCount: coinState.trades_count || 0,
  };
}

function renderSummary(state, allTrades) {
  const coins = state.coins || {};
  const meta = state.meta || {};
  const totalEquity = meta.total_equity ?? INITIAL_BALANCE;
  const totalPnl = totalEquity - INITIAL_BALANCE;
  const totalPnlPct = (totalPnl / INITIAL_BALANCE) * 100;
  const openPositions = Object.values(coins).reduce(
    (sum, c) => sum + (c.cells || []).filter((cell) => cell.status === "filled").length,
    0
  );
  const wins = allTrades.filter((t) => t.pnl >= 0).length;
  const winRate = allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0;

  document.getElementById("statBalance").textContent = fmtUsd(totalEquity);
  document.getElementById("statBalanceSub").textContent = `Başlangıç: ${fmtUsd(INITIAL_BALANCE)}`;

  const pnlEl = document.getElementById("statPnl");
  pnlEl.textContent = fmtUsd(totalPnl);
  pnlEl.className = `stat-value ${pnlClass(totalPnl)}`;
  document.getElementById("statPnlPct").textContent = fmtPct(totalPnlPct);
  document.getElementById("statPnlPct").className = `stat-sub ${pnlClass(totalPnlPct)}`;

  document.getElementById("statOpenPositions").textContent = openPositions;
  document.getElementById("statTotalTrades").textContent = allTrades.length;
  document.getElementById("statWinRate").textContent = `Kazanma oranı: ${winRate.toFixed(1)}%`;

  document.getElementById("lastRun").textContent = `Son çalışma: ${fmtDate(meta.last_run_at)}`;
  document.getElementById("lastUpdate").textContent = `Veri güncelleme: ${fmtDate(meta.last_run_at)}`;
}

function renderCoinCards(state, trades) {
  const coins = state.coins || {};
  const stats = Object.entries(coins).map(([symbol, coinState]) => computeCoinStats(symbol, coinState, trades));
  stats.sort((a, b) => b.equity - a.equity);

  const grid = document.getElementById("coinGrid");
  grid.innerHTML = "";

  stats.forEach((s, idx) => {
    const rank = idx + 1;
    const card = document.createElement("div");
    card.className = "coin-card";
    card.innerHTML = `
      <div class="coin-card-head">
        <span class="coin-symbol">${s.symbol}</span>
        <span class="coin-rank ${rank === 1 ? "rank-1" : ""}">#${rank}</span>
      </div>
      <div class="coin-stat-row"><span>Bakiye</span><b class="${pnlClass(s.equity - (coins[s.symbol].margin_usd || 0))}">${fmtUsd(s.equity)}</b></div>
      <div class="coin-stat-row"><span>Gerçekleşen K/Z</span><b class="${pnlClass(s.realizedPnl)}">${fmtUsd(s.realizedPnl)}</b></div>
      <div class="coin-stat-row"><span>Açık K/Z (unrealized)</span><b class="${pnlClass(s.unrealizedPnl)}">${fmtUsd(s.unrealizedPnl)}</b></div>
      <div class="coin-stat-row"><span>Kazanan / Kaybeden</span><b>${s.wins} / ${s.losses}</b></div>
      <div class="coin-stat-row"><span>Kazanma oranı</span><b>${s.winRate.toFixed(1)}%</b></div>
      <div class="coin-stat-row"><span>Toplam işlem</span><b>${s.tradesCount}</b></div>
      <div class="coin-stat-row"><span>Ort. K/Z / işlem</span><b class="${pnlClass(s.avgPnl)}">${fmtUsd(s.avgPnl)}</b></div>
      <div class="coin-stat-row"><span>Açık lot sayısı</span><b>${s.openLots}</b></div>
    `;
    grid.appendChild(card);
  });
}

function populateCoinFilter(state) {
  const select = document.getElementById("coinFilter");
  const coins = Object.keys(state.coins || {});
  coins.forEach((symbol) => {
    const opt = document.createElement("option");
    opt.value = symbol;
    opt.textContent = symbol;
    select.appendChild(opt);
  });
}

function renderTrades(trades, filter) {
  const body = document.getElementById("tradesBody");
  const filtered = filter === "all" ? trades : trades.filter((t) => t.coin === filter);
  const sorted = [...filtered].sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));

  if (sorted.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="empty-row">Henüz işlem yok</td></tr>`;
    return;
  }

  body.innerHTML = sorted
    .slice(0, 300)
    .map((t) => {
      const cls = pnlClass(t.pnl);
      const outcome = t.pnl > 0 ? "KAZANÇ" : t.pnl < 0 ? "KAYIP" : "BAŞABAŞ";
      return `<tr>
        <td>${fmtDate(t.closed_at)}</td>
        <td>${t.coin}</td>
        <td class="${cls}">${outcome}</td>
        <td>${Number(t.entry_price).toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
        <td>${Number(t.exit_price).toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
        <td>${Number(t.qty).toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
        <td class="${cls}">${fmtUsd(t.pnl)}</td>
      </tr>`;
    })
    .join("");
}

let equityChart;

function renderChart(equityHistory, mode, coinSymbols) {
  const ctx = document.getElementById("equityChart").getContext("2d");
  const labels = equityHistory.map((p) => fmtDate(p.timestamp));

  let datasets;
  if (mode === "total") {
    datasets = [
      {
        label: "Toplam Bakiye (USD)",
        data: equityHistory.map((p) => p.total_equity),
        borderColor: "#5b8def",
        backgroundColor: "rgba(91,141,239,0.15)",
        fill: true,
        tension: 0.25,
        pointRadius: 0,
      },
    ];
  } else {
    const palette = ["#5b8def", "#26a69a", "#ef5350", "#f0c93a", "#af52de", "#ff9f40", "#4bc0c0", "#c9cbcf"];
    datasets = coinSymbols.map((symbol, i) => ({
      label: symbol,
      data: equityHistory.map((p) => (p.per_coin_equity ? p.per_coin_equity[symbol] : null)),
      borderColor: palette[i % palette.length],
      backgroundColor: "transparent",
      tension: 0.25,
      pointRadius: 0,
    }));
  }

  if (equityChart) equityChart.destroy();
  equityChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#8b93a7", maxTicksLimit: 8 }, grid: { color: "#232838" } },
        y: { ticks: { color: "#8b93a7" }, grid: { color: "#232838" } },
      },
      plugins: {
        legend: { labels: { color: "#e6e9f0" } },
      },
    },
  });
}

async function main() {
  const [state, trades, equityHistory] = await Promise.all([
    fetchJson("data/state.json", { coins: {}, meta: {} }),
    fetchJson("data/trades.json", []),
    fetchJson("data/equity_history.json", []),
  ]);

  renderSummary(state, trades);
  renderCoinCards(state, trades);
  populateCoinFilter(state);
  renderTrades(trades, "all");

  const coinSymbols = Object.keys(state.coins || {});
  let chartMode = "total";
  renderChart(equityHistory, chartMode, coinSymbols);

  document.getElementById("coinFilter").addEventListener("change", (e) => {
    renderTrades(trades, e.target.value);
  });

  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      chartMode = btn.dataset.mode;
      renderChart(equityHistory, chartMode, coinSymbols);
    });
  });
}

main();
