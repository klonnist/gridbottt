"""
Entry point for one bot "tick". Run by the GitHub Actions schedule (or
locally with `python -m bot.main`).

Each run: fetch current prices for every configured coin -> advance each
coin's grid state -> record any simulated trades -> persist state/trades/
equity-history JSON files. Failures for an individual coin (bad network,
missing data, OKX hiccup) are caught and logged so the whole run never
crashes -- other coins still get processed and the previous state is kept
for the failing one.
"""

import time
from datetime import datetime, timezone

from . import config
from . import okx_client
from . import storage
from .grid_engine import compute_grid_bounds, init_coin_state, migrate_legacy_cells, process_price_update


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_coin_initialized(symbol: str, inst_id: str, coins_state: dict) -> bool:
    """Makes sure coins_state[symbol] exists with a grid set up. Returns False
    if initialization could not be completed this run (e.g. API failure)."""
    if symbol in coins_state:
        return True

    candles = None
    if config.GRID_METHOD == "auto":
        bars_needed = max(1, (config.LOOKBACK_DAYS * 24) // 4)  # matches 4H default bar
        candles = okx_client.get_candles(inst_id, config.CANDLE_BAR, bars_needed)
        if not candles:
            print(f"[main] WARN: no candles for {symbol} yet, will retry next run")
            return False

    try:
        lower, upper = compute_grid_bounds(symbol, candles)
    except ValueError as exc:
        print(f"[main] WARN: could not compute grid bounds for {symbol}: {exc}")
        return False

    coins_state[symbol] = init_coin_state(symbol, inst_id, lower, upper)
    print(f"[main] Initialized grid for {symbol}: lower={lower:.6g} upper={upper:.6g}")
    return True


def run_once() -> None:
    state = storage.load_json(config.STATE_FILE, default={})
    trades = storage.load_json(config.TRADES_FILE, default=[])
    equity_history = storage.load_json(config.EQUITY_HISTORY_FILE, default=[])

    if "meta" not in state:
        state["meta"] = {
            "started_at": now_iso(),
            "initial_balance_usd": config.INITIAL_BALANCE_USD,
            "leverage": config.LEVERAGE,
            "next_trade_id": 1,
        }
    if "coins" not in state:
        state["coins"] = {}

    coins_state = state["coins"]
    run_timestamp = now_iso()
    new_trades = []
    per_coin_summary = {}

    for symbol, inst_id in config.SYMBOLS.items():
        try:
            if not ensure_coin_initialized(symbol, inst_id, coins_state):
                continue

            price = okx_client.get_last_price(inst_id)
            if price is None:
                print(f"[main] WARN: skipping {symbol} this run, no price data")
                continue

            coin_state = coins_state[symbol]
            migrate_legacy_cells(coin_state)
            result = process_price_update(symbol, coin_state, price, run_timestamp)
            coin_state["unrealized_pnl"] = result.unrealized_pnl
            coin_state["balance"] = coin_state["margin_usd"] + coin_state["realized_pnl"]
            coin_state["equity"] = coin_state["balance"] + result.unrealized_pnl

            for trade in result.trades:
                trade["id"] = state["meta"]["next_trade_id"]
                state["meta"]["next_trade_id"] += 1
                trade["balance_after"] = coin_state["balance"]
                new_trades.append(trade)

            per_coin_summary[symbol] = {
                "price": price,
                "realized_pnl": coin_state["realized_pnl"],
                "unrealized_pnl": result.unrealized_pnl,
                "trades_this_run": len(result.trades),
            }

        except Exception as exc:  # noqa: BLE001 - never let one coin crash the run
            print(f"[main] ERROR processing {symbol}: {exc}")
            continue

    trades.extend(new_trades)
    if len(trades) > config.MAX_TRADES_KEPT:
        trades = trades[-config.MAX_TRADES_KEPT :]

    total_realized = sum(c.get("realized_pnl", 0.0) for c in coins_state.values())
    total_unrealized = sum(c.get("unrealized_pnl", 0.0) for c in coins_state.values())
    total_equity = config.INITIAL_BALANCE_USD + total_realized + total_unrealized

    equity_history.append(
        {
            "timestamp": run_timestamp,
            "total_equity": total_equity,
            "total_realized_pnl": total_realized,
            "total_unrealized_pnl": total_unrealized,
            "per_coin_equity": {
                sym: c.get("balance", c["margin_usd"]) + c.get("unrealized_pnl", 0.0)
                for sym, c in coins_state.items()
            },
        }
    )
    if len(equity_history) > config.MAX_EQUITY_HISTORY_POINTS:
        equity_history = equity_history[-config.MAX_EQUITY_HISTORY_POINTS :]

    state["meta"]["last_run_at"] = run_timestamp
    state["meta"]["total_equity"] = total_equity
    state["meta"]["total_realized_pnl"] = total_realized
    state["meta"]["total_unrealized_pnl"] = total_unrealized

    storage.save_json(config.STATE_FILE, state)
    storage.save_json(config.TRADES_FILE, trades)
    storage.save_json(config.EQUITY_HISTORY_FILE, equity_history)

    print(f"[main] Run complete at {run_timestamp}")
    print(f"[main] Total equity: {total_equity:.2f} USD ({len(new_trades)} new trades)")
    for symbol, summary in per_coin_summary.items():
        print(f"       {symbol}: price={summary['price']:.6g} "
              f"realized={summary['realized_pnl']:.2f} unrealized={summary['unrealized_pnl']:.2f} "
              f"trades_this_run={summary['trades_this_run']}")


if __name__ == "__main__":
    start = time.time()
    run_once()
    print(f"[main] Done in {time.time() - start:.2f}s")
