"""Basic utility tools: current time, timezone conversion, weather.

Weather uses Open-Meteo (no API key, free for non-commercial use).
Geocoding via Open-Meteo's own geocoding endpoint.
"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo, available_timezones

import requests
from flask import jsonify, request


# ---------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------

def _time_now() -> dict:
    now = datetime.now(timezone.utc)
    return {
        "now_utc": now.isoformat(),
        "unix": int(now.timestamp()),
        "timezones": sorted(available_timezones())[:200],  # cap for sanity
    }


def _time_in_zone(zone: str) -> dict:
    try:
        tz = ZoneInfo(zone)
    except Exception as exc:
        return {"_error": True, "message": f"unknown timezone '{zone}': {exc}"}
    now = datetime.now(tz)
    return {
        "zone": zone,
        "datetime": now.isoformat(),
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M:%S"),
        "weekday": now.strftime("%A"),
        "utc_offset": now.strftime("%z"),
    }


# ---------------------------------------------------------------------------
# Weather (Open-Meteo)
# ---------------------------------------------------------------------------

def _geocode(location: str) -> dict | None:
    try:
        r = requests.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": location, "count": 1, "language": "en", "format": "json"},
            timeout=10,
        )
        r.raise_for_status()
        results = r.json().get("results") or []
        if not results:
            return None
        top = results[0]
        return {
            "name": top.get("name"),
            "country": top.get("country"),
            "admin1": top.get("admin1"),
            "latitude": top.get("latitude"),
            "longitude": top.get("longitude"),
        }
    except Exception:
        return None


def _weather(location: str) -> dict:
    geo = _geocode(location)
    if not geo:
        return {"_error": True, "message": f"could not find location '{location}'"}
    try:
        r = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": geo["latitude"],
                "longitude": geo["longitude"],
                "current": "temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m",
                "daily": "temperature_2m_max,temperature_2m_min,weather_code",
                "forecast_days": 3,
                "timezone": "auto",
            },
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
    except Exception as exc:
        return {"_error": True, "message": f"weather fetch failed: {exc}"}
    cur = data.get("current", {})
    daily = data.get("daily", {})
    days = []
    if daily.get("time"):
        for i, day in enumerate(daily["time"]):
            days.append({
                "date": day,
                "high_c": (daily.get("temperature_2m_max") or [None])[i],
                "low_c": (daily.get("temperature_2m_min") or [None])[i],
                "weather_code": (daily.get("weather_code") or [None])[i],
            })
    return {
        "location": geo,
        "current": {
            "temperature_c": cur.get("temperature_2m"),
            "humidity": cur.get("relative_humidity_2m"),
            "wind_kph": cur.get("wind_speed_10m"),
            "weather_code": cur.get("weather_code"),
        },
        "forecast_3d": days,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def register_routes(app):
    @app.route("/api/time", methods=["GET"])
    def _time_route():
        return jsonify(_time_now())

    @app.route("/api/timezone", methods=["GET"])
    def _timezone_route():
        zone = request.args.get("zone", "").strip()
        if not zone:
            return jsonify({"_error": True, "message": "zone is required"})
        return jsonify(_time_in_zone(zone))

    @app.route("/api/weather", methods=["GET"])
    def _weather_route():
        loc = request.args.get("location", "").strip()
        if not loc:
            return jsonify({"_error": True, "message": "location is required"})
        return jsonify(_weather(loc))
