"""Thin wrapper around OKX's public (no API key) market-data REST endpoints."""

import time
import urllib.request
import urllib.error
import json

from . import config


class OkxRequestError(Exception):
    pass


def _get(path: str, params: dict) -> dict:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{config.OKX_BASE_URL}{path}?{query}"

    last_error = None
    for attempt in range(1, config.REQUEST_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "gridbottt/1.0"})
            with urllib.request.urlopen(req, timeout=config.REQUEST_TIMEOUT_SECONDS) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            if body.get("code") != "0":
                raise OkxRequestError(f"OKX API error for {url}: {body}")
            return body
        except (urllib.error.URLError, urllib.error.HTTPError, OkxRequestError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt < config.REQUEST_RETRIES:
                time.sleep(config.REQUEST_RETRY_BACKOFF_SECONDS * attempt)

    raise OkxRequestError(f"Failed to fetch {url} after {config.REQUEST_RETRIES} attempts: {last_error}")


def get_last_price(inst_id: str) -> float | None:
    """Returns the last traded price for a perp instrument, or None on failure."""
    try:
        body = _get(config.TICKER_ENDPOINT, {"instId": inst_id})
        return float(body["data"][0]["last"])
    except Exception as exc:  # noqa: BLE001 - bot must never crash on bad market data
        print(f"[okx_client] WARN: could not fetch ticker for {inst_id}: {exc}")
        return None


def get_candles(inst_id: str, bar: str, limit: int) -> list[dict] | None:
    """Returns recent candles oldest->newest as dicts, or None on failure.

    Each candle: {open, high, low, close, ts}
    """
    try:
        body = _get(
            config.CANDLES_ENDPOINT,
            {"instId": inst_id, "bar": bar, "limit": limit},
        )
        raw = body["data"]
        candles = [
            {
                "ts": int(row[0]),
                "open": float(row[1]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
            }
            for row in raw
        ]
        candles.reverse()  # OKX returns newest-first
        return candles
    except Exception as exc:  # noqa: BLE001
        print(f"[okx_client] WARN: could not fetch candles for {inst_id}: {exc}")
        return None
