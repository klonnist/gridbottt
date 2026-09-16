"""JSON read/write helpers for the bot's persisted state, trades, and equity history."""

import json
import os

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _path(relative_path: str) -> str:
    return os.path.join(REPO_ROOT, relative_path)


def load_json(relative_path: str, default):
    full_path = _path(relative_path)
    if not os.path.exists(full_path):
        return default
    try:
        with open(full_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[storage] WARN: could not read {relative_path} ({exc}); using default")
        return default


def save_json(relative_path: str, data) -> None:
    full_path = _path(relative_path)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    tmp_path = full_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
    os.replace(tmp_path, full_path)
