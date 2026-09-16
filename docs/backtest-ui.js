const UI_SYMBOLS = window.GridBacktest.SYMBOLS;
const UI_ALL_BARS = window.GridBacktest.ALL_BARS;

const fmtUsd = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const pnlClass = (n) => (n >= 0 ? "positive" : "negative");
const fmtDate = (ts) => new Date(ts).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });

function buildCoinCheckboxes() {
  const wrap = document.getElementById("coinCheckboxes");
  wrap.innerHTML = Object.keys(UI_SYMBOLS)
    .map(
      (s) => `<label class="coin-check"><input type="checkbox" value="${s}" checked /> ${s}</label>`
    )
    .join("");
}

function selectedCoins() {
  return Array.from(document.querySelectorAll("#coinCheckboxes input:checked")).map((el) => el.value);
}

function setDefaultDates() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  document.getElementById("startDate").value = start.toISOString().slice(0, 10);
  document.getElementById("endDate").value = end.toISOString().slice(0, 10);
}

function setStatus(text) {
  document.getElementById("runStatus").textContent = text;
}

function setRunning(isRunning) {
  document.getElementById("runBtn").disabled = isRunning;
  document.getElementById("runBtn").textContent = isRunning ? "Calisiyor..." : "▶ Calistir";
}

let resultChart;

function renderSummary(stats) {
  const el = document.getElementById("resultSummary");
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="stat-card"><div class="stat-label">BASLANGIC</div><div class="stat-value">${fmtUsd(stats.startBalance)}</div></div>
    <div class="stat-card"><div class="stat-label">BITIS</div><div class="stat-value">${fmtUsd(stats.endBalance)}</div></div>
    <div class="stat-card"><div class="stat-label">TOPLAM K/Z</div><div class="stat-value ${pnlClass(stats.totalPnl)}">${fmtUsd(stats.totalPnl)}</div></div>
    <div class="stat-card"><div class="stat-label">GETIRI</div><div class="stat-value ${pnlClass(stats.returnPct)}">${fmtPct(stats.returnPct)}</div></div>
    <div class="stat-card"><div class="stat-label">ISLEM</div><div class="stat-value">${stats.closedCount}</div></div>
    <div class="stat-card"><div class="stat-label">KAZANMA ORANI</div><div class="stat-value">%${stats.winRate.toFixed(1)}</div></div>
    <div class="stat-card"><div class="stat-label">BASABAS</div><div class="stat-value">${stats.breakeven}</div></div>
    <div class="stat-card"><div class="stat-label">MAX DRAWDOWN</div><div class="stat-value negative">%${stats.maxDrawdownPct.toFixed(1)}</div></div>
  `;
}

function renderChart(equityCurve, title) {
  const panel = document.getElementById("chartPanel");
  panel.classList.remove("hidden");
  document.getElementById("chartTitle").textContent = title;
  const ctx = document.getElementById("resultChart").getContext("2d");
  if (resultChart) resultChart.destroy();
  resultChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: equityCurve.map((p) => fmtDate(p.ts)),
      datasets: [
        {
          label: "Bakiye (USDT)",
          data: equityCurve.map((p) => p.equity),
          borderColor: "#5b8def",
          backgroundColor: "rgba(91,141,239,0.15)",
          fill: true,
          tension: 0.2,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: { ticks: { color: "#8b93a7", maxTicksLimit: 8 }, grid: { color: "#232838" } },
        y: { ticks: { color: "#8b93a7" }, grid: { color: "#232838" } },
      },
      plugins: { legend: { labels: { color: "#e6e9f0" } } },
    },
  });
}

function renderCoinTable(perCoinResults) {
  const panel = document.getElementById("coinTablePanel");
  panel.classList.remove("hidden");
  const rows = perCoinResults.map((r) => {
    if (r.error) {
      return `<tr><td>${r.symbol}</td><td colspan="6" class="empty-row">${r.error}</td></tr>`;
    }
    const closed = r.trades; // every recorded trade is already a closed round trip
    const wins = closed.filter((t) => t.pnl > 0).length;
    const losses = closed.filter((t) => t.pnl < 0).length;
    const breakeven = closed.filter((t) => t.pnl === 0).length;
    const winRate = closed.length ? (wins / closed.length) * 100 : 0;
    const pnl = r.state.realizedPnl;
    return `<tr>
      <td>${r.symbol}</td>
      <td>${closed.length}</td>
      <td>${wins}</td>
      <td>${breakeven}</td>
      <td>${losses}</td>
      <td>%${winRate.toFixed(1)}</td>
      <td class="${pnlClass(pnl)}">${fmtUsd(pnl)}</td>
    </tr>`;
  });
  document.getElementById("coinTableBody").innerHTML = rows.join("");
}

function tradeOutcomeLabel(t) {
  if (t.pnl > 0) return "KAZANC";
  if (t.pnl < 0) return "KAYIP";
  return "BASABAS";
}

function renderTradesTable(perCoinResults) {
  const panel = document.getElementById("tradesPanel");
  panel.classList.remove("hidden");
  const allTrades = perCoinResults.flatMap((r) => r.trades || []);
  allTrades.sort((a, b) => b.closedAt - a.closedAt);

  const filterSelect = document.getElementById("btCoinFilter");
  filterSelect.innerHTML =
    `<option value="all">Tum coinler</option>` +
    perCoinResults.map((r) => `<option value="${r.symbol}">${r.symbol}</option>`).join("");

  const render = (filter) => {
    const filtered = filter === "all" ? allTrades : allTrades.filter((t) => t.coin === filter);
    const body = document.getElementById("btTradesBody");
    if (filtered.length === 0) {
      body.innerHTML = `<tr><td colspan="7" class="empty-row">Islem yok</td></tr>`;
      return;
    }
    body.innerHTML = filtered
      .slice(0, 500)
      .map((t) => {
        const cls = pnlClass(t.pnl);
        return `<tr>
          <td>${fmtDate(t.closedAt)}</td>
          <td>${t.coin}</td>
          <td class="${cls}">${tradeOutcomeLabel(t)}</td>
          <td>${Number(t.entryPrice).toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
          <td>${Number(t.exitPrice).toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
          <td>${Number(t.qty).toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
          <td class="${cls}">${fmtUsd(t.pnl)}</td>
        </tr>`;
      })
      .join("");
  };
  filterSelect.onchange = (e) => render(e.target.value);
  render("all");
}

function renderSweepTable(rows) {
  const panel = document.getElementById("sweepPanel");
  panel.classList.remove("hidden");
  const sorted = [...rows].sort((a, b) => b.returnPct - a.returnPct);
  document.getElementById("sweepBody").innerHTML = sorted
    .map(
      (r, i) => `<tr class="${i === 0 ? "sweep-best" : ""}">
        <td>${r.gridLevels}</td>
        <td>%${(r.gridPad * 100).toFixed(0)}</td>
        <td>${r.closedCount}</td>
        <td>%${r.winRate.toFixed(1)}</td>
        <td class="${pnlClass(r.totalPnl)}">${fmtUsd(r.totalPnl)}</td>
        <td class="${pnlClass(r.returnPct)}">${fmtPct(r.returnPct)}</td>
      </tr>`
    )
    .join("");
}

function renderTimeframeComparison(rows) {
  const panel = document.getElementById("comparePanel");
  panel.classList.remove("hidden");
  const sorted = [...rows].sort((a, b) => b.stats.returnPct - a.stats.returnPct);
  document.getElementById("compareBody").innerHTML = sorted
    .map(
      (r) => `<tr>
        <td>${r.bar}</td>
        <td>${r.stats.closedCount}</td>
        <td>%${r.stats.winRate.toFixed(1)}</td>
        <td class="${pnlClass(r.stats.totalPnl)}">${fmtUsd(r.stats.totalPnl)}</td>
        <td class="${pnlClass(r.stats.returnPct)}">${fmtPct(r.stats.returnPct)}</td>
        <td class="negative">%${r.stats.maxDrawdownPct.toFixed(1)}</td>
      </tr>`
    )
    .join("");
}

function hideAllResultPanels() {
  ["resultSummary", "chartPanel", "coinTablePanel", "sweepPanel", "tradesPanel", "comparePanel"].forEach((id) =>
    document.getElementById(id).classList.add("hidden")
  );
}

function readSettings() {
  return {
    bar: document.getElementById("timeframe").value,
    startTs: new Date(`${document.getElementById("startDate").value}T00:00:00Z`).getTime(),
    endTs: Math.min(
      new Date(`${document.getElementById("endDate").value}T23:59:59Z`).getTime(),
      Date.now()
    ),
    lookbackDays: Number(document.getElementById("lookbackDays").value) || 14,
    initialBalance: Number(document.getElementById("balance").value) || 10000,
    leverage: Number(document.getElementById("leverage").value) || 3,
    gridLevels: Number(document.getElementById("gridLevels").value) || 10,
    gridPad: (Number(document.getElementById("gridPad").value) || 5) / 100,
    compareAll: document.getElementById("compareAllTimeframes").checked,
  };
}

async function handleRun() {
  const coins = selectedCoins();
  if (coins.length === 0) {
    alert("En az bir coin secmelisiniz.");
    return;
  }
  const settings = readSettings();
  if (!(settings.startTs < settings.endTs)) {
    alert("Baslangic tarihi bitis tarihinden once olmali.");
    return;
  }
  const marginUsd = settings.initialBalance / coins.length;
  const fullSettings = { ...settings, marginUsd };

  setRunning(true);
  hideAllResultPanels();

  try {
    if (settings.compareAll) {
      const compareRows = [];
      for (const bar of UI_ALL_BARS) {
        setStatus(`(${bar}) mum verisi cekiliyor...`);
        const cache = await window.GridBacktest.fetchAllCoinCandles(
          coins,
          bar,
          settings.startTs,
          settings.endTs,
          settings.lookbackDays,
          (symbol, done, total) => setStatus(`(${bar}) ${symbol}: ${done}/${total} sayfa`)
        );
        const { stats } = window.GridBacktest.runSimulationFromCache(cache, coins, fullSettings);
        compareRows.push({ bar, stats });
      }
      renderTimeframeComparison(compareRows);
      setStatus(`Tamamlandi: ${UI_ALL_BARS.join(", ")} zaman dilimleri karsilastirildi.`);
    } else {
      setStatus("Mum verisi cekiliyor...");
      const cache = await window.GridBacktest.fetchAllCoinCandles(
        coins,
        settings.bar,
        settings.startTs,
        settings.endTs,
        settings.lookbackDays,
        (symbol, done, total) => setStatus(`${symbol}: ${done}/${total} sayfa cekiliyor...`)
      );

      setStatus("Simulasyon calistiriliyor...");
      const { perCoinResults, stats } = window.GridBacktest.runSimulationFromCache(cache, coins, fullSettings);

      renderSummary(stats);
      renderChart(
        stats.equityCurve,
        `Bakiye Egrisi - grid . ${settings.bar} . ${document.getElementById("startDate").value} -> ${document.getElementById("endDate").value}`
      );
      renderCoinTable(perCoinResults);
      renderTradesTable(perCoinResults);

      setStatus("Grid ayarlari taraniyor (ayni veriyle, ag istegi yok)...");
      const sweepLevels = [6, 8, 10, 12, 15];
      const sweepPads = [0.03, 0.05, 0.08];
      const sweepRows = [];
      for (const gridLevels of sweepLevels) {
        for (const gridPad of sweepPads) {
          const { stats: sweepStats } = window.GridBacktest.runSimulationFromCache(cache, coins, {
            ...fullSettings,
            gridLevels,
            gridPad,
          });
          sweepRows.push({
            gridLevels,
            gridPad,
            closedCount: sweepStats.closedCount,
            winRate: sweepStats.winRate,
            totalPnl: sweepStats.totalPnl,
            returnPct: sweepStats.returnPct,
          });
        }
      }
      renderSweepTable(sweepRows);

      setStatus(`Tamamlandi (${new Date().toLocaleTimeString("tr-TR")}).`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Hata: ${err.message}`);
  } finally {
    setRunning(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  buildCoinCheckboxes();
  setDefaultDates();
  document.getElementById("runBtn").addEventListener("click", handleRun);
  document.getElementById("selectAllCoins").addEventListener("click", () => {
    document.querySelectorAll("#coinCheckboxes input").forEach((el) => (el.checked = true));
  });
  document.getElementById("clearAllCoins").addEventListener("click", () => {
    document.querySelectorAll("#coinCheckboxes input").forEach((el) => (el.checked = false));
  });
  document.getElementById("compareAllTimeframes").addEventListener("change", (e) => {
    document.getElementById("timeframe").disabled = e.target.checked;
  });
});
