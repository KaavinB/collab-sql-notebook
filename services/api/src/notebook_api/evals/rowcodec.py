"""Result rows as JSON and back, so gold results can be cached on disk.

Gold outcomes are stored once per run and reused by every model and every
resume. Predicted results go through the same encode/decode round trip
before they're compared, so both sides of `set(predicted) == set(gold)`
are always values of the same kinds.

Every value keeps its type (an int stays an int, a float its exact repr, a
Decimal its exact digits), so a decoded set compares the way the original
Python values would. A type we don't know is kept as its repr on both sides.
"""

import base64
import datetime as dt
import uuid
from collections.abc import Hashable, Iterable
from decimal import Decimal
from typing import Any

type Row = tuple[Hashable, ...]


def encode_value(value: object) -> Any:
    # bool before int: bool is a subclass of int.
    if value is None:
        return None
    if isinstance(value, bool):
        return ["bool", value]
    if isinstance(value, int):
        return ["i", str(value)]  # as text: JSON numbers lose precision past 2**53
    if isinstance(value, float):
        return ["f", repr(value)]
    if isinstance(value, str):
        return ["s", value]
    if isinstance(value, (bytes, bytearray, memoryview)):
        return ["b", base64.b64encode(bytes(value)).decode("ascii")]
    if isinstance(value, Decimal):
        return ["d", str(value)]
    if isinstance(value, dt.datetime):
        return ["dt", value.isoformat()]
    if isinstance(value, dt.date):
        return ["date", value.isoformat()]
    if isinstance(value, dt.time):
        return ["time", value.isoformat()]
    if isinstance(value, dt.timedelta):
        return ["td", [value.days, value.seconds, value.microseconds]]
    if isinstance(value, uuid.UUID):
        return ["uuid", str(value)]
    if isinstance(value, tuple):
        return ["t", [encode_value(item) for item in value]]
    return ["r", repr(value)]


def decode_value(data: Any) -> Hashable:
    if data is None:
        return None
    kind, payload = data
    match kind:
        case "bool":
            return bool(payload)
        case "i":
            return int(payload)
        case "f":
            return float(payload)
        case "s" | "r":
            return str(payload)
        case "b":
            return base64.b64decode(payload)
        case "d":
            return Decimal(payload)
        case "dt":
            return dt.datetime.fromisoformat(payload)
        case "date":
            return dt.date.fromisoformat(payload)
        case "time":
            return dt.time.fromisoformat(payload)
        case "td":
            days, seconds, micros = payload
            return dt.timedelta(days=days, seconds=seconds, microseconds=micros)
        case "uuid":
            return uuid.UUID(payload)
        case "t":
            return tuple(decode_value(item) for item in payload)
    raise ValueError(f"unknown value kind: {kind!r}")


def encode_rows(rows: Iterable[Row]) -> list[list[Any]]:
    return [[encode_value(value) for value in row] for row in rows]


def decode_rows(data: Iterable[list[Any]]) -> frozenset[Row]:
    return frozenset(tuple(decode_value(value) for value in row) for row in data)


def normalize_rows(rows: frozenset[Row]) -> frozenset[Row]:
    """The rows as they'd come back from the cache (see the module docstring)."""
    return decode_rows(encode_rows(rows))
