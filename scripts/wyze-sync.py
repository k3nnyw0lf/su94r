#!/usr/bin/env python3
"""
Wyze Scale X (WSCALX) → su94r.

Wyze has no official health-data API. wyze-sdk is a reverse-engineered client
that Wyze does not support, so this may break when Wyze changes something —
it is a convenience feed, not a dependency. Nothing else in su94r relies on it.

Auth uses the official Wyze Developer API key plus account credentials.
Get the key at https://developer-api-console.wyze.com

Run on any always-on machine via cron, e.g. twice daily:
    0 7,19 * * *  /usr/bin/python3 /opt/su94r/wyze-sync.py >> /var/log/wyze-sync.log 2>&1

Environment:
    WYZE_EMAIL, WYZE_PASSWORD, WYZE_KEY_ID, WYZE_API_KEY
    SU94R_INGEST_URL     e.g. https://<your-proxy>.workers.dev/health/ingest
    SU94R_INGEST_TOKEN   same HEALTH_INGEST_TOKEN the Worker holds
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    from wyze_sdk import Client
    from wyze_sdk.errors import WyzeApiError
except ImportError:
    sys.exit("wyze-sdk not installed. Run: pip install wyze-sdk")


# Wyze attribute → (su94r sample type, unit). Anything absent from a given
# reading is skipped rather than sent as zero — a missing measurement and a
# measurement of zero are not the same thing, and zero would poison trends.
METRICS = {
    "weight":                ("bodyMass", "kg"),
    "body_fat":              ("bodyFatPercentage", "%"),
    "muscle":                ("muscleMass", "kg"),
    "bone_mineral":          ("boneMass", "kg"),
    "body_water":            ("bodyWater", "%"),
    "visceral_fat":          ("visceralFat", "index"),
    "bmi":                   ("bmi", "index"),
    "basal_metabolism":      ("basalMetabolicRate", "kcal"),
    "heart_rate":            ("heartRate", "count/min"),
}


def env(name, required=True):
    value = os.environ.get(name)
    if required and not value:
        sys.exit(f"Missing required environment variable: {name}")
    return value


def to_iso(value):
    """Wyze timestamps arrive as datetime or epoch millis depending on field."""
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 1e11 else value
        return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
    return None


def collect_samples(client, since):
    """Flattens recent scale records into su94r ingest rows."""
    rows = []
    for device in client.scales.list():
        try:
            scale = client.scales.info(device_mac=device.mac)
        except WyzeApiError as exc:
            print(f"  skipping {device.mac}: {exc}", file=sys.stderr)
            continue

        for record in getattr(scale, "latest_records", []) or []:
            recorded_at = to_iso(getattr(record, "measure_ts", None))
            if not recorded_at or recorded_at < since:
                continue

            for attr, (sample_type, unit) in METRICS.items():
                value = getattr(record, attr, None)
                if value is None:
                    continue
                try:
                    value = float(value)
                except (TypeError, ValueError):
                    continue
                # Wyze reports 0 for metrics a given weigh-in did not capture.
                if value == 0:
                    continue
                rows.append({
                    "type": sample_type,
                    "value": value,
                    "unit": unit,
                    "timestamp": recorded_at,
                    "source": "wyze-scale",
                })
    return rows


def post(rows, url, token):
    payload = json.dumps({"samples": rows}).encode()
    request = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        sys.exit(f"Ingest rejected: {exc.code} {exc.read()[:300]}")
    except urllib.error.URLError as exc:
        sys.exit(f"Ingest unreachable: {exc.reason}")


def main():
    days = int(os.environ.get("WYZE_SYNC_DAYS", "7"))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

    try:
        client = Client(
            email=env("WYZE_EMAIL"),
            password=env("WYZE_PASSWORD"),
            key_id=env("WYZE_KEY_ID"),
            api_key=env("WYZE_API_KEY"),
        )
    except WyzeApiError as exc:
        sys.exit(f"Wyze login failed: {exc}")

    rows = collect_samples(client, since)
    if not rows:
        print(f"No scale readings since {since}. Nothing to send.")
        return

    result = post(rows, env("SU94R_INGEST_URL"), env("SU94R_INGEST_TOKEN"))
    print(f"Sent {len(rows)} samples -> {result}")


if __name__ == "__main__":
    main()
