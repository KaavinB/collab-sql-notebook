"""`notebook-ingest`: download the pinned dataset files and build taxi.duckdb.

Run from the repo root with `pnpm ingest`.
"""

import argparse
import fcntl
import shutil
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from notebook_api.dataset.build import build_database, stale_build_files
from notebook_api.dataset.download import ChecksumMismatchError, ensure_file, stale_partial_files
from notebook_api.dataset.manifest import TRIP_FILES, ZONES_FILE, pickup_window


class IngestAlreadyRunningError(Exception):
    """Another `notebook-ingest` holds the lock on this data directory."""


@contextmanager
def ingest_lock(data_dir: Path) -> Iterator[None]:
    """Hold an exclusive, non-blocking lock on `data_dir` for the whole ingest.

    flock is released by the OS when the process exits, even if it is killed,
    so a crashed run never leaves a stale lock behind.

    POSIX only (macOS, Linux): `fcntl` doesn't exist on Windows, which isn't a
    target for this project (dev on macOS, deploy on Fly.io Linux).
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    with (data_dir / ".ingest.lock").open("w") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise IngestAlreadyRunningError(
                f"another ingest is already running in {data_dir}"
            ) from None
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir",
        type=Path,
        required=True,
        help="Directory for raw downloads (raw/) and the built taxi.duckdb.",
    )
    args = parser.parse_args(argv)
    data_dir: Path = args.data_dir.resolve()
    try:
        with ingest_lock(data_dir):
            _ingest(data_dir)
    except (IngestAlreadyRunningError, ChecksumMismatchError) as error:
        # Expected failures get one clear line, not a traceback.
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from None


def remove_stale_temp_files(data_dir: Path) -> list[Path]:
    """Delete temp files from earlier runs that were killed before cleaning up.

    Must be called while holding the ingest lock, so no live run owns them.
    """
    stale = stale_build_files(data_dir / "taxi.duckdb") + stale_partial_files(data_dir / "raw")
    for path in stale:
        # A build killed mid-sort also leaves DuckDB's spill directory for the
        # build file (<build file>.tmp/), which matches the same pattern.
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)
    return stale


def _ingest(data_dir: Path) -> None:
    raw_dir = data_dir / "raw"
    for path in remove_stale_temp_files(data_dir):
        print(f"removed leftover {path.name}", flush=True)

    trip_paths = []
    for file in TRIP_FILES:
        print(f"verifying {file.filename} ...", flush=True)
        trip_paths.append(ensure_file(file, raw_dir))
    print(f"verifying {ZONES_FILE.filename} ...", flush=True)
    zones_path = ensure_file(ZONES_FILE, raw_dir)

    out_path = data_dir / "taxi.duckdb"
    print(f"building {out_path} ...", flush=True)
    window_start, window_end = pickup_window()
    report = build_database(trip_paths, zones_path, out_path, window_start, window_end)
    print(f"raw trip rows:                 {report.raw_trip_rows}")
    print(f"trips kept:                    {report.trip_rows}")
    print(f"dropped (pickup outside window): {report.dropped_outside_window}")
    print(f"zones:                         {report.zone_rows}")
