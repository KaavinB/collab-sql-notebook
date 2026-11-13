"""Convert DuckDB result values into JSON-safe values for the browser."""

import base64
import datetime as dt
import math
import uuid
from decimal import Decimal

type JsonValue = bool | int | float | str | list[JsonValue] | dict[str, JsonValue] | None

# Integers beyond this can't be represented exactly by a JavaScript number,
# so they are sent as strings (the column type tells the client what they are).
_MAX_SAFE_JS_INTEGER = 2**53 - 1


def to_json_value(value: object) -> JsonValue:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value if abs(value) <= _MAX_SAFE_JS_INTEGER else str(value)
    if isinstance(value, float):
        # JSON has no NaN or Infinity.
        return value if math.isfinite(value) else str(value)
    if isinstance(value, Decimal):
        # Kept as a string so no precision is lost; the column type is DECIMAL.
        return str(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "base64:" + base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, (list, tuple)):
        return [to_json_value(item) for item in value]
    if isinstance(value, dict):
        # MAP keys can be any type; JSON object keys must be strings.
        return {str(key): to_json_value(item) for key, item in value.items()}
    return str(value)
