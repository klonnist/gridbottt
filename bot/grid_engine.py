"""
Core grid trading logic (paper trading only -- no real orders are ever sent).

Strategy model
--------------
Each coin gets its own price grid between a lower and upper bound, split into
GRID_LEVELS equal-width cells. A cell "fills" (simulated BUY / long open) when
price drops through the line at its bottom, and "closes" (simulated SELL /
long close, realizing PnL) when price rises back through the line at its top.
This is the standard long-biased "futures grid" mode offered by exchanges'
own grid bots: it uses a perpetual instrument with leverage, but only ever
holds long lots -- there is no separate short-side grid. See README for the
reasoning and how to extend it.

Nothing here calls a broker: every "trade" is just a dict appended to a list
and a balance/position number updated in memory.
"""

import time
from dataclasses import dataclass, field

from . import config


def compute_grid_bounds(symbol: str, candles: list[dict] | None) -> tuple[float, float]:
    """Returns (lower, upper) bounds for a coin's grid.

    "auto": padded recent high/low over the configured lookback window.
    "manual": fixed values from config.MANUAL_GRID_BOUNDS.
    """
    if config.GRID_METHOD == "manual":
        return config.MANUAL_GRID_BOUNDS[symbol]

    if not candles:
        raise ValueError(f"auto grid method needs candles for {symbol} but none were fetched")

    recent_high = max(c["high"] for c in candles)
    recent_low = min(c["low"] for c in candles)
    pad = config.GRID_RANGE_PAD
    lower = recent_low * (1 - pad)
    upper = recent_high * (1 + pad)
    return lower, upper


def build_grid_lines(lower: float, upper: float, levels: int) -> list[float]:
    step = (upper - lower) / levels
    return [lower + i * step for i in range(levels + 1)]


def init_coin_state(symbol: str, inst_id: str, lower: float, upper: float) -> dict:
    lines = build_grid_lines(lower, upper, config.GRID_LEVELS)
    notional_per_cell = (config.MARGIN_PER_COIN_USD * config.LEVERAGE) / config.GRID_LEVELS
    return {
        "inst_id": inst_id,
        "lower": lower,
        "upper": upper,
        "grid_levels": config.GRID_LEVELS,
        "grid_lines": lines,
        "notional_per_cell_usd": notional_per_cell,
        "margin_usd": config.MARGIN_PER_COIN_USD,
        "leverage": config.LEVERAGE,
        "cells": [{"status": "empty", "entry_price": None, "qty": None} for _ in range(config.GRID_LEVELS)],
        "last_price": None,
        "realized_pnl": 0.0,
        "trades_count": 0,
        "wins": 0,
        "losses": 0,
        "grid_initialized_at": int(time.time()),
    }


@dataclass
class RunResult:
    trades: list[dict] = field(default_factory=list)
    unrealized_pnl: float = 0.0


def process_price_update(symbol: str, coin_state: dict, current_price: float) -> RunResult:
    """Advances one coin's grid state given a new price tick and returns any
    trades that fired. Mutates coin_state in place."""
    result = RunResult()
    previous_price = coin_state["last_price"]

    if previous_price is None:
        # First observation after grid init: nothing to compare against yet.
        coin_state["last_price"] = current_price
        return result

    lines = coin_state["grid_lines"]
    cells = coin_state["cells"]
    notional = coin_state["notional_per_cell_usd"]

    if current_price < previous_price:
        # Price fell: fill any empty cell whose bottom line was crossed downward.
        for i in range(len(cells)):
            line = lines[i]
            if current_price <= line < previous_price and cells[i]["status"] == "empty":
                qty = notional / line
                cells[i] = {"status": "filled", "entry_price": line, "qty": qty}
                coin_state["trades_count"] += 1
                result.trades.append(
                    {
                        "coin": symbol,
                        "side": "buy",
                        "price": line,
                        "qty": qty,
                        "pnl": None,
                        "reason": "grid_buy",
                    }
                )

    elif current_price > previous_price:
        # Price rose: close any filled cell whose top line was crossed upward.
        for j in range(1, len(lines)):
            line = lines[j]
            cell_idx = j - 1
            if previous_price < line <= current_price and cells[cell_idx]["status"] == "filled":
                cell = cells[cell_idx]
                pnl = cell["qty"] * (line - cell["entry_price"])
                coin_state["realized_pnl"] += pnl
                coin_state["trades_count"] += 1
                if pnl >= 0:
                    coin_state["wins"] += 1
                else:
                    coin_state["losses"] += 1
                result.trades.append(
                    {
                        "coin": symbol,
                        "side": "sell",
                        "price": line,
                        "qty": cell["qty"],
                        "pnl": pnl,
                        "reason": "grid_sell",
                    }
                )
                cells[cell_idx] = {"status": "empty", "entry_price": None, "qty": None}

    coin_state["last_price"] = current_price
    result.unrealized_pnl = sum(
        c["qty"] * (current_price - c["entry_price"]) for c in cells if c["status"] == "filled"
    )
    return result
