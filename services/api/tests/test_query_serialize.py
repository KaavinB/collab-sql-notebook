import datetime as dt
import json
import uuid
from decimal import Decimal

import pytest

from notebook_api.query.serialize import to_json_value


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, None),
        (True, True),
        ("text", "text"),
        (42, 42),
        (2**53 - 1, 2**53 - 1),
        (2**53, "9007199254740992"),  # beyond JS's exact integer range
        (-(2**53), "-9007199254740992"),
        (1.5, 1.5),
        (float("nan"), "nan"),
        (float("inf"), "inf"),
        (Decimal("12.34"), "12.34"),
        (dt.date(2024, 1, 2), "2024-01-02"),
        (dt.datetime(2024, 1, 2, 3, 4, 5), "2024-01-02T03:04:05"),
        (dt.datetime(2024, 1, 2, tzinfo=dt.UTC), "2024-01-02T00:00:00+00:00"),
        (dt.time(12, 30), "12:30:00"),
        (dt.timedelta(minutes=90), "1:30:00"),
        (uuid.UUID(int=1), "00000000-0000-0000-0000-000000000001"),
        (b"\x01\xff", "base64:Af8="),
        ([1, None, Decimal("1.0")], [1, None, "1.0"]),
        ((1, 2), [1, 2]),
        ({"a": 1, 2: "b"}, {"a": 1, "2": "b"}),
    ],
)
def test_converts_to_json_safe_values(value: object, expected: object) -> None:
    converted = to_json_value(value)
    assert converted == expected
    json.dumps(converted, allow_nan=False)  # must be strict JSON
