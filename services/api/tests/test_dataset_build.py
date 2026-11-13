from datetime import date
from pathlib import Path

import duckdb
import pytest

from notebook_api.dataset import cli
from notebook_api.dataset.build import build_database
from notebook_api.dataset.download import ChecksumMismatchError
from tests.fixtures import write_trip_parquet

START, END = date(2024, 1, 1), date(2024, 3, 1)


@pytest.fixture
def trip_files(tmp_path: Path) -> list[Path]:
    jan = write_trip_parquet(
        tmp_path / "jan.parquet",
        # The 2002 row mimics the clock errors in the real data.
        ["2024-01-05 08:00:00", "2024-01-31 23:59:59", "2002-12-31 22:59:39"],
    )
    feb = write_trip_parquet(
        tmp_path / "feb.parquet",
        # 2024-03-01 00:00:00 is exactly the exclusive end of the window.
        ["2024-02-10 12:00:00", "2024-03-01 00:00:00"],
    )
    return [jan, feb]


def test_build_reports_measured_counts(
    tmp_path: Path, trip_files: list[Path], zones_csv: Path
) -> None:
    report = build_database(trip_files, zones_csv, tmp_path / "out.duckdb", START, END)
    assert report.raw_trip_rows == 5
    assert report.trip_rows == 3
    assert report.dropped_outside_window == 2
    assert report.zone_rows == 3


def test_build_renames_columns_and_keeps_only_the_window(
    tmp_path: Path, trip_files: list[Path], zones_csv: Path
) -> None:
    out = tmp_path / "out.duckdb"
    build_database(trip_files, zones_csv, out, START, END)
    with duckdb.connect(str(out), read_only=True) as con:
        columns = [r[0] for r in con.execute("DESCRIBE trips").fetchall()]
        assert columns[:3] == ["vendor_id", "pickup_at", "dropoff_at"]
        assert "pickup_location_id" in columns
        assert "airport_fee" in columns
        pickups = [str(r[0]) for r in con.execute("SELECT pickup_at FROM trips").fetchall()]
        assert pickups == ["2024-01-05 08:00:00", "2024-01-31 23:59:59", "2024-02-10 12:00:00"]
        joined = con.execute(
            "SELECT z.zone FROM trips t JOIN zones z ON t.pickup_location_id = z.location_id "
            "LIMIT 1"
        ).fetchone()
        assert joined == ("JFK Airport",)


def test_build_stores_table_and_column_comments(
    tmp_path: Path, trip_files: list[Path], zones_csv: Path
) -> None:
    out = tmp_path / "out.duckdb"
    build_database(trip_files, zones_csv, out, START, END)
    with duckdb.connect(str(out), read_only=True) as con:
        table_comments = dict(
            con.execute("SELECT table_name, comment FROM duckdb_tables()").fetchall()
        )
        assert "2024-01-01" in table_comments["trips"]
        missing = con.execute(
            "SELECT table_name, column_name FROM duckdb_columns() "
            "WHERE table_name IN ('trips', 'zones') AND (comment IS NULL OR comment = '')"
        ).fetchall()
        assert missing == []


def test_failed_build_leaves_the_existing_database_untouched(
    tmp_path: Path, trip_files: list[Path], zones_csv: Path
) -> None:
    out = tmp_path / "out.duckdb"
    build_database(trip_files, zones_csv, out, START, END)
    before = out.read_bytes()

    with pytest.raises(duckdb.Error):
        build_database(trip_files, tmp_path / "missing.csv", out, START, END)

    assert out.read_bytes() == before
    assert list(tmp_path.glob(".out.duckdb.build-*")) == []


def test_successful_build_leaves_no_temporary_files(
    tmp_path: Path, trip_files: list[Path], zones_csv: Path
) -> None:
    out = tmp_path / "out.duckdb"
    build_database(trip_files, zones_csv, out, START, END)
    assert list(tmp_path.glob(".out.duckdb.build-*")) == []


def test_build_works_while_duckdb_spill_directory_exists(
    tmp_path: Path, trip_files: list[Path], zones_csv: Path
) -> None:
    # Regression: DuckDB's default spill directory for <db> is <db>.tmp, which the
    # API creates during large queries. The build must neither collide with it
    # nor touch it.
    out = tmp_path / "out.duckdb"
    spill_dir = tmp_path / "out.duckdb.tmp"
    spill_dir.mkdir()
    (spill_dir / "spill.block").write_bytes(b"x")

    build_database(trip_files, zones_csv, out, START, END)
    build_database(trip_files, zones_csv, out, START, END)

    assert (spill_dir / "spill.block").read_bytes() == b"x"
    with duckdb.connect(str(out), read_only=True) as con:
        assert con.execute("SELECT count(*) FROM trips").fetchone() == (3,)


def test_rebuild_replaces_the_existing_database(
    tmp_path: Path, trip_files: list[Path], zones_csv: Path
) -> None:
    out = tmp_path / "out.duckdb"
    build_database(trip_files, zones_csv, out, START, END)
    report = build_database(trip_files[:1], zones_csv, out, START, END)
    assert report.trip_rows == 2
    with duckdb.connect(str(out), read_only=True) as con:
        assert con.execute("SELECT count(*) FROM trips").fetchone() == (2,)


def test_cli_builds_into_the_data_dir(
    tmp_path: Path,
    trip_files: list[Path],
    zones_csv: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    by_name = {
        "yellow_tripdata_2024-01.parquet": trip_files[0],
        "yellow_tripdata_2024-02.parquet": trip_files[1],
        "yellow_tripdata_2024-03.parquet": trip_files[1],
        "taxi_zone_lookup.csv": zones_csv,
    }
    monkeypatch.setattr(cli, "ensure_file", lambda file, raw_dir: by_name[file.filename])

    data_dir = tmp_path / "data"
    cli.main(["--data-dir", str(data_dir)])

    assert (data_dir / "taxi.duckdb").exists()
    out = capsys.readouterr().out
    assert "zones:" in out
    assert "dropped (pickup outside window):" in out


def test_cli_requires_a_data_dir() -> None:
    with pytest.raises(SystemExit):
        cli.main([])


def test_cli_refuses_to_run_while_another_ingest_holds_the_lock(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with cli.ingest_lock(tmp_path), pytest.raises(SystemExit) as exit_info:
        cli.main(["--data-dir", str(tmp_path)])
    assert exit_info.value.code == 1
    err = capsys.readouterr().err
    assert err.startswith("error: another ingest is already running")
    assert "Traceback" not in err


def test_cli_reports_a_checksum_mismatch_in_one_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def tampered(file: object, raw_dir: Path) -> Path:
        raise ChecksumMismatchError("f.parquet: expected sha256 aaa, got bbb")

    monkeypatch.setattr(cli, "ensure_file", tampered)
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["--data-dir", str(tmp_path)])
    assert exit_info.value.code == 1
    assert capsys.readouterr().err == "error: f.parquet: expected sha256 aaa, got bbb\n"


def test_remove_stale_temp_files_only_touches_leftovers(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    raw.mkdir()
    leftovers = [
        tmp_path / ".taxi.duckdb.build-0123456789abcdef",
        tmp_path / ".taxi.duckdb.build-0123456789abcdef.wal",
        raw / ".yellow_tripdata_2024-01.parquet.deadbeefcafef00d.part",
    ]
    keep = [
        tmp_path / "taxi.duckdb",
        tmp_path / ".ingest.lock",
        raw / "yellow_tripdata_2024-01.parquet",
        raw / "taxi_zone_lookup.csv",
    ]
    for path in leftovers + keep:
        path.write_bytes(b"x")
    # A build killed mid-sort leaves DuckDB's spill directory for the build file.
    build_spill = tmp_path / ".taxi.duckdb.build-0123456789abcdef.tmp"
    build_spill.mkdir()
    (build_spill / "duckdb_temp_block.tmp").write_bytes(b"x")
    (tmp_path / "taxi.duckdb.tmp").mkdir()  # the API's spill dir: not ours

    removed = cli.remove_stale_temp_files(tmp_path)

    assert sorted(removed) == sorted([*leftovers, build_spill])
    assert not build_spill.exists()
    assert all(not p.exists() for p in leftovers)
    assert all(p.exists() for p in keep)
    assert (tmp_path / "taxi.duckdb.tmp").is_dir()


def test_ingest_lock_is_released_afterwards(tmp_path: Path) -> None:
    with cli.ingest_lock(tmp_path):
        pass
    with cli.ingest_lock(tmp_path):  # would raise if the first lock were still held
        pass
