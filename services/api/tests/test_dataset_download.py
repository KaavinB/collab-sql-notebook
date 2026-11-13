import hashlib
import re
from datetime import date
from pathlib import Path

import pytest

from notebook_api.dataset.download import ChecksumMismatchError, ensure_file, https_fetch
from notebook_api.dataset.manifest import (
    TRIP_FILES,
    ZONES_FILE,
    DatasetFile,
    TripFile,
    pickup_window,
)

CONTENT = b"pretend parquet bytes"
GOOD = DatasetFile(
    url="https://example.test/f.parquet",
    filename="f.parquet",
    sha256=hashlib.sha256(CONTENT).hexdigest(),
)


class FakeFetch:
    def __init__(self, content: bytes = CONTENT) -> None:
        self.content = content
        self.calls: list[str] = []

    def __call__(self, url: str, dest: Path) -> None:
        self.calls.append(url)
        dest.write_bytes(self.content)


def test_downloads_verifies_and_renames(tmp_path: Path) -> None:
    fetch = FakeFetch()
    path = ensure_file(GOOD, tmp_path, fetch)
    assert path == tmp_path / "f.parquet"
    assert path.read_bytes() == CONTENT
    assert fetch.calls == [GOOD.url]
    assert list(tmp_path.iterdir()) == [path]  # no partial file left behind


def test_reuses_a_verified_file_without_downloading(tmp_path: Path) -> None:
    (tmp_path / "f.parquet").write_bytes(CONTENT)
    fetch = FakeFetch()
    ensure_file(GOOD, tmp_path, fetch)
    assert fetch.calls == []


def test_replaces_a_corrupted_existing_file(tmp_path: Path) -> None:
    (tmp_path / "f.parquet").write_bytes(b"truncated")
    fetch = FakeFetch()
    path = ensure_file(GOOD, tmp_path, fetch)
    assert fetch.calls == [GOOD.url]
    assert path.read_bytes() == CONTENT


def test_checksum_mismatch_raises_and_leaves_nothing_behind(tmp_path: Path) -> None:
    with pytest.raises(ChecksumMismatchError, match=r"f\.parquet: expected sha256"):
        ensure_file(GOOD, tmp_path, FakeFetch(b"tampered bytes"))
    assert list(tmp_path.iterdir()) == []


def test_failed_fetch_leaves_no_partial_file(tmp_path: Path) -> None:
    def broken_fetch(url: str, dest: Path) -> None:
        dest.write_bytes(b"half")
        raise ConnectionError("network dropped")

    with pytest.raises(ConnectionError):
        ensure_file(GOOD, tmp_path, broken_fetch)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("url", ["http://example.test/f", "file:///etc/passwd", "ftp://x/y"])
def test_https_fetch_refuses_other_schemes(tmp_path: Path, url: str) -> None:
    with pytest.raises(ValueError, match="non-https"):
        https_fetch(url, tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_manifest_is_well_formed() -> None:
    files = [*TRIP_FILES, ZONES_FILE]
    assert len({f.filename for f in files}) == len(files)
    for f in files:
        assert f.url.startswith("https://")
        assert f.url.endswith("/" + f.filename)
        assert re.fullmatch(r"[0-9a-f]{64}", f.sha256)


def _trip_file(month: date) -> TripFile:
    name = f"yellow_tripdata_{month:%Y-%m}.parquet"
    return TripFile(url=f"https://x.test/{name}", filename=name, sha256="0" * 64, month=month)


def test_pickup_window_spans_exactly_the_manifest_months() -> None:
    start, end = pickup_window()
    months = sorted(f.month for f in TRIP_FILES)
    assert start == months[0]
    assert end == date(2024, 4, 1)
    for f in TRIP_FILES:
        assert f.filename == f"yellow_tripdata_{f.month:%Y-%m}.parquet"


def test_pickup_window_rolls_over_the_year() -> None:
    files = (_trip_file(date(2023, 11, 1)), _trip_file(date(2023, 12, 1)))
    assert pickup_window(files) == (date(2023, 11, 1), date(2024, 1, 1))


def test_pickup_window_rejects_a_gap_between_months() -> None:
    files = (_trip_file(date(2024, 1, 1)), _trip_file(date(2024, 3, 1)))
    with pytest.raises(ValueError, match="contiguous"):
        pickup_window(files)
