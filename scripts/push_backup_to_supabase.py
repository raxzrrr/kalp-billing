#!/usr/bin/env python3
"""
Push a KALP JSON backup into Supabase (kalp_store + kalp_bills).

Usage:
  python3 scripts/push_backup_to_supabase.py \\
    --backup backups/kalp_backup_2026-09-11.json \\
    --url https://YOUR_PROJECT.supabase.co \\
    --key YOUR_ANON_OR_PUBLISHABLE_KEY

Requires: schema.sql already applied in the Supabase SQL Editor.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def parse_value(raw):
    if isinstance(raw, (dict, list, int, float, bool)) or raw is None:
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw
    return raw


def http_json(method: str, url: str, key: str, body=None, prefer: str | None = None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {e.code} on {method} {url}\n{err}") from e


def upsert_store(base: str, key: str, api_key: str, rows: list[dict]):
    url = f"{base.rstrip('/')}/rest/v1/kalp_store"
    # Upsert in chunks
    chunk = 50
    for i in range(0, len(rows), chunk):
        part = rows[i : i + chunk]
        http_json("POST", url, api_key, part, prefer="resolution=merge-duplicates,return=minimal")
        print(f"  store upserted {i + len(part)}/{len(rows)}")


def upsert_bills(base: str, key: str, api_key: str, bills: list[dict]):
    url = f"{base.rstrip('/')}/rest/v1/kalp_bills"
    chunk = 100
    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for b in bills:
        rows.append(
            {
                "id": b.get("id"),
                "bill_number": b.get("billNumber") or 0,
                "customer_name": b.get("customerName") or "Walk-in Customer",
                "phone": b.get("phone") or "",
                "date": (b.get("date") or now[:10])[:10],
                "grand_total": b.get("grandTotal") or 0,
                "raw_data": b,
                "updated_at": now,
            }
        )
    for i in range(0, len(rows), chunk):
        part = rows[i : i + chunk]
        http_json("POST", url, api_key, part, prefer="resolution=merge-duplicates,return=minimal")
        print(f"  bills upserted {i + len(part)}/{len(rows)}")


def main():
    p = argparse.ArgumentParser(description="Seed Supabase from KALP JSON backup")
    p.add_argument("--backup", required=True, help="Path to kalp_backup_*.json")
    p.add_argument("--url", required=True, help="Supabase project URL")
    p.add_argument("--key", required=True, help="Supabase anon/publishable key")
    args = p.parse_args()

    path = Path(args.backup)
    if not path.exists():
        raise SystemExit(f"Backup not found: {path}")

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit("Backup must be a JSON object of storage keys")

    now = datetime.now(timezone.utc).isoformat()
    store_rows = []
    bills = []

    for k, raw in data.items():
        val = parse_value(raw)
        if k == "kalp_theme" and isinstance(val, str):
            # keep as plain string JSON value
            pass
        store_rows.append({"key": k, "value": val, "updated_at": now})
        if k == "kalp_bills" and isinstance(val, list):
            bills = val

    print(f"Pushing {len(store_rows)} store keys…")
    upsert_store(args.url, "unused", args.key, store_rows)

    if bills:
        print(f"Pushing {len(bills)} bills…")
        upsert_bills(args.url, "unused", args.key, bills)
    else:
        print("No kalp_bills array found; store-only seed complete.")

    print("Done. Open the app and click Pull Latest from Cloud (or reload).")


if __name__ == "__main__":
    main()
