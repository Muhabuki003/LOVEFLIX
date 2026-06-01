import hashlib
import json
from datetime import datetime, timezone

from js import Headers, Response


async def on_fetch(request, env, ctx):
    if request.method == "OPTIONS":
        return _resp("", 204, env)

    if "/api/search-flights" not in request.url:
        return _resp(json.dumps({"error": "Not found"}), 404, env)

    if request.method != "POST":
        return _resp(json.dumps({"error": "Method not allowed"}), 405, env)

    try:
        raw  = await request.text()
        body = json.loads(raw)
    except Exception:
        return _resp(json.dumps({"error": "Invalid JSON body"}), 400, env)

    from_code = str(body.get("from_airport")   or "").strip().upper()
    to_code   = str(body.get("to_airport")     or "").strip().upper()
    dep_date  = str(body.get("departure_date") or "").strip()
    ret_date  = str(body.get("return_date")    or "").strip() or None

    if not from_code or not to_code or not dep_date:
        return _resp(
            json.dumps({"error": "from_airport, to_airport, and departure_date are required"}),
            400, env,
        )

    for code, field in [(from_code, "from_airport"), (to_code, "to_airport")]:
        if not (2 <= len(code) <= 4 and code.isalpha()):
            return _resp(
                json.dumps({"error": f"Invalid airport code '{code}' in {field}. Use a valid IATA code (e.g. JFK, LHR, NBO)."}),
                400, env,
            )

    try:
        dep_dt = datetime.strptime(dep_date, "%Y-%m-%d")
        if ret_date:
            ret_dt = datetime.strptime(ret_date, "%Y-%m-%d")
            if ret_dt < dep_dt:
                return _resp(
                    json.dumps({"error": "return_date must be on or after departure_date"}),
                    400, env,
                )
    except ValueError:
        return _resp(json.dumps({"error": "Dates must be in YYYY-MM-DD format"}), 400, env)

    cache_key = hashlib.sha256(
        f"{from_code}|{to_code}|{dep_date}|{ret_date or 'ow'}".encode()
    ).hexdigest()[:40]

    try:
        cached = await env.FLIGHT_CACHE.get(cache_key)
        if cached is not None:
            data = json.loads(cached)
            data["from_cache"] = True
            return _resp(json.dumps(data), 200, env)
    except Exception:
        pass

    try:
        result = _run_search(from_code, to_code, dep_date, ret_date)
    except KeyError as exc:
        return _resp(
            json.dumps({"error": f"Unknown airport code {exc}. Use a valid IATA code (e.g. JFK, LHR, NBO)."}),
            422, env,
        )
    except Exception as exc:
        return _resp(json.dumps({"error": f"Search failed: {exc}"}), 502, env)

    try:
        await env.FLIGHT_CACHE.put(cache_key, json.dumps(result), expirationTtl=3600)
    except Exception:
        pass

    return _resp(json.dumps(result), 200, env)


def _run_search(from_code, to_code, dep_date, ret_date):
    from fli.models import (
        Airport,
        FlightSearchFilters,
        FlightSegment,
        MaxStops,
        PassengerInfo,
        SeatType,
        SortBy,
    )
    from fli.search import SearchFlights

    origin = Airport[from_code]
    dest   = Airport[to_code]

    segments = [
        FlightSegment(
            departure_airport=[[origin, 0]],
            arrival_airport=[[dest, 0]],
            travel_date=dep_date,
        )
    ]
    if ret_date:
        segments.append(
            FlightSegment(
                departure_airport=[[dest, 0]],
                arrival_airport=[[origin, 0]],
                travel_date=ret_date,
            )
        )

    filters = FlightSearchFilters(
        passenger_info=PassengerInfo(adults=1),
        flight_segments=segments,
        seat_type=SeatType.ECONOMY,
        stops=MaxStops.ANY,
        sort_by=SortBy.CHEAPEST,
    )

    raw_flights = SearchFlights().search(filters) or []
    return {
        "flights":          [_format_flight(f) for f in raw_flights],
        "currency":         "USD",
        "search_timestamp": datetime.now(timezone.utc).isoformat(),
        "from_cache":       False,
        "query": {
            "from":           from_code,
            "to":             to_code,
            "departure_date": dep_date,
            "return_date":    ret_date,
            "trip_type":      "round_trip" if ret_date else "one_way",
        },
    }


def _format_flight(f):
    legs = getattr(f, "legs", None) or []

    dep_time = arr_time = flight_num = airline = None
    if legs:
        dep_time   = str(getattr(legs[0],  "departure_time", "") or "")
        arr_time   = str(getattr(legs[-1], "arrival_time",   "") or "")
        flight_num = getattr(legs[0], "flight_number", None)
        airline    = getattr(legs[0], "airline", None) or getattr(legs[0], "carrier", None)

    if not airline:
        airline = (
            getattr(f, "airline",  None)
            or getattr(f, "carrier", None)
            or getattr(f, "name",    None)
        )

    return {
        "price":          getattr(f, "price",    None),
        "duration_min":   getattr(f, "duration", None),
        "airline":        airline,
        "departure_time": dep_time,
        "arrival_time":   arr_time,
        "flight_number":  flight_num,
        "stops":          getattr(f, "stops",    None),
    }


def _resp(body, status, env):
    origin = getattr(env, "ALLOWED_ORIGIN", "https://loveflix.us")
    headers = Headers.new([
        ["Content-Type",                 "application/json"],
        ["Access-Control-Allow-Origin",  origin],
        ["Access-Control-Allow-Methods", "POST, OPTIONS"],
        ["Access-Control-Allow-Headers", "Content-Type, Authorization"],
        ["Access-Control-Max-Age",       "86400"],
        ["Cache-Control",                "no-store"],
    ])
    return Response.new(body, status=status, headers=headers)
