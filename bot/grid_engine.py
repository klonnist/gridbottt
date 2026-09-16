"""
Core grid trading logic (paper trading only -- no real orders are ever sent).

Strategy model
--------------
Each coin gets its own price grid between a lower and upper bound, split into
GRID_LEVELS equal-width cells. This is a "neutral" grid: every cell can hold
an independent LONG lot and an independent SHORT lot at the same time.

For cell k spanning [line[k], line[k+1]]:
  - LONG leg: opens (buy) at line[k] when price falls through it, closes
    (sell) at line[k+1] when price rises back through it.
  - SHORT leg: opens (sell short) at line[k+1] when price rises through it,
    closes (buy to cover) at line[k] when price falls back through it.

Both legs realize a profit by construction whenever they close (a long only
closes at a higher price than it opened; a short only closes at a lower
price than it opened) -- the risk is not in realized trades but in whichever
leg is left open and unrealized if price trends away from the grid instead
of oscillating back through it. See README for the ranging-vs-trending
trade-off this implies.

Nothing here calls a broker: every "trade" is just a dict appended to a list
and a balance/position number updated in memory. A trade record represents a
full round trip (open then close) in a single row -- opening a leg only
updates internal state, nothing is recorded until that leg closes.
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


def _empty_leg() -> dict:
    return {"status": "empty", "entry_price": None, "qty": None, "opened_at": None}


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
        "cells": [{"long": _empty_leg(), "short": _empty_leg()} for _ in range(config.GRID_LEVELS)],
        "last_price": None,
        "realized_pnl": 0.0,
        "trades_count": 0,
        "wins": 0,
        "losses": 0,
        "grid_initialized_at": int(time.time()),
    }


def migrate_legacy_cells(coin_state: dict) -> None:
    """One-time upgrade for state files written before the long+short split:
    old cells were a single flat leg (long-only). Mutates coin_state in place;
    a no-op once cells are already in the current {long, short} shape."""
    cells = coin_state.get("cells") or []
    if not cells or "long" in cells[0]:
        return
    migrated = []
    for cell in cells:
        if cell.get("status") == "filled":
            long_leg = {
                "status": "filled",
                "entry_price": cell.get("entry_price"),
                "qty": cell.get("qty"),
                "opened_at": cell.get("opened_at"),
            }
        else:
            long_leg = _empty_leg()
        migrated.append({"long": long_leg, "short": _empty_leg()})
    coin_state["cells"] = migrated


@dataclass
class RunResult:
    trades: list[dict] = field(default_factory=list)
    unrealized_pnl: float = 0.0


def _close_leg(coin_state: dict, result: "RunResult", symbol: str, side: str, leg: dict, exit_price: float, timestamp: str) -> None:
    pnl = leg["qty"] * (exit_price - leg["entry_price"]) if side == "long" else leg["qty"] * (leg["entry_price"] - exit_price)
    coin_state["realized_pnl"] += pnl
    coin_state["trades_count"] += 1
    if pnl >= 0:
        coin_state["wins"] += 1
    else:
        coin_state["losses"] += 1
    result.trades.append(
        {
            "coin": symbol,
            "side": side,
            "entry_price": leg["entry_price"],
            "exit_price": exit_price,
            "qty": leg["qty"],
            "pnl": pnl,
            "opened_at": leg["opened_at"],
            "closed_at": timestamp,
            "reason": "grid_round_trip",
        }
    )


def process_price_update(symbol: str, coin_state: dict, current_price: float, timestamp: str) -> RunResult:
    """Advances one coin's grid state given a new price tick and returns any
    round-trip trades that closed on this tick. Mutates coin_state in place."""
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
        # Price fell through line[m], the bottom of cell m: open its long leg,
        # close its short leg (if either applies).
        for m in range(len(cells)):
            line = lines[m]
            if not (current_price <= line < previous_price):
                continue
            cell = cells[m]
            if cell["long"]["status"] == "empty":
                qty = notional / line
                cell["long"] = {"status": "filled", "entry_price": line, "qty": qty, "opened_at": timestamp}
            if cell["short"]["status"] == "filled":
                _close_leg(coin_state, result, symbol, "short", cell["short"], line, timestamp)
                cell["short"] = _empty_leg()

    elif current_price > previous_price:
        # Price rose through line[m], the top of cell (m-1): close its long
        # leg, open its short leg (if either applies).
        for m in range(1, len(lines)):
            line = lines[m]
            if not (previous_price < line <= current_price):
                continue
            cell = cells[m - 1]
            if cell["long"]["status"] == "filled":
                _close_leg(coin_state, result, symbol, "long", cell["long"], line, timestamp)
                cell["long"] = _empty_leg()
            if cell["short"]["status"] == "empty":
                qty = notional / line
                cell["short"] = {"status": "filled", "entry_price": line, "qty": qty, "opened_at": timestamp}

    coin_state["last_price"] = current_price

    unrealized = 0.0
    for cell in cells:
        if cell["long"]["status"] == "filled":
            unrealized += cell["long"]["qty"] * (current_price - cell["long"]["entry_price"])
        if cell["short"]["status"] == "filled":
            unrealized += cell["short"]["qty"] * (cell["short"]["entry_price"] - current_price)
    result.unrealized_pnl = unrealized
    return result
