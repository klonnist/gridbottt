"""
Central configuration for the grid trading bot.
Change values here to retune the bot -- nothing else in the codebase should
need editing for a normal parameter change (coin list, leverage, grid size...).
"""

# ---------------------------------------------------------------------------
# Account / risk settings
# ---------------------------------------------------------------------------
INITIAL_BALANCE_USD = 10_000.0     # total paper-trading capital
LEVERAGE = 3                       # fixed, conservative leverage on every coin

# ---------------------------------------------------------------------------
# Coin universe
# ---------------------------------------------------------------------------
# Keys are the short ticker used across data files / dashboard.
# Values are the OKX perpetual swap instrument IDs (public market-data API).
SYMBOLS = {
    "BTC":   "BTC-USDT-SWAP",
    "ETH":   "ETH-USDT-SWAP",
    "XRP":   "XRP-USDT-SWAP",
    "AVAX":  "AVAX-USDT-SWAP",
    "SOL":   "SOL-USDT-SWAP",
    "DOT":   "DOT-USDT-SWAP",
    "NEAR":  "NEAR-USDT-SWAP",
    "ETHFI": "ETHFI-USDT-SWAP",
}

# Equal capital split across all coins, e.g. 10000 / 8 = 1250 USD margin each.
MARGIN_PER_COIN_USD = INITIAL_BALANCE_USD / len(SYMBOLS)

# ---------------------------------------------------------------------------
# Grid sizing method
# ---------------------------------------------------------------------------
# "auto"   -> bounds derived per-coin from recent volatility (recent high/low
#             over LOOKBACK_DAYS, padded by GRID_RANGE_PAD). Adapts to each
#             coin's own range instead of one hand-picked band per coin.
# "manual" -> bounds taken from MANUAL_GRID_BOUNDS below.
GRID_METHOD = "auto"

LOOKBACK_DAYS = 14          # candles window used to measure the recent range
CANDLE_BAR = "4H"           # OKX bar size used for the lookback candles
GRID_RANGE_PAD = 0.05       # pad the observed high/low by +-5% for headroom
GRID_LEVELS = 10            # number of grid cells between lower and upper bound

# Only used when GRID_METHOD == "manual". {symbol: (lower, upper)}
MANUAL_GRID_BOUNDS = {
    "BTC":   (50_000, 75_000),
    "ETH":   (2_200, 3_400),
    "XRP":   (0.40, 0.75),
    "AVAX":  (18, 32),
    "SOL":   (110, 190),
    "DOT":   (3.5, 6.5),
    "NEAR":  (3.0, 6.0),
    "ETHFI": (0.8, 2.2),
}

# ---------------------------------------------------------------------------
# OKX public REST API (no key required for market data)
# ---------------------------------------------------------------------------
OKX_BASE_URL = "https://www.okx.com"
TICKER_ENDPOINT = "/api/v5/market/ticker"
CANDLES_ENDPOINT = "/api/v5/market/candles"
REQUEST_TIMEOUT_SECONDS = 10
REQUEST_RETRIES = 3
REQUEST_RETRY_BACKOFF_SECONDS = 2

# ---------------------------------------------------------------------------
# File paths (relative to repo root)
# ---------------------------------------------------------------------------
STATE_FILE = "data/state.json"
TRADES_FILE = "data/trades.json"
EQUITY_HISTORY_FILE = "data/equity_history.json"
MAX_EQUITY_HISTORY_POINTS = 5000
MAX_TRADES_KEPT = 5000
