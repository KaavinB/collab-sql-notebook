"""No server paths in what a person sees: query errors, results and column names."""

from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from notebook_api.query.engine import EngineLimits
from notebook_api.query.paths import MIN_PATH_CHARS, PLACEHOLDER, PathScrubber, private_paths
from notebook_api.query.runner import QueryFailedError, QueryRunner
from notebook_api.query.serialize import JsonValue
from tests.fixtures import write_query_test_db

pytestmark = pytest.mark.anyio

LIMITS = EngineLimits(
    memory_limit_mb=256,
    process_memory_cap_mb=1024,
    threads=1,
    max_spill_size_mb=100,
    timeout_seconds=2.0,
    row_limit=100,
    max_result_bytes=1_000_000,
)


def test_replaces_the_database_file_its_wal_and_the_spill_dirs(tmp_path: Path) -> None:
    db = tmp_path / "data" / "taxi.duckdb"
    scrubber = PathScrubber(private_paths(db, tmp_path / "data" / "spill"))
    text = f"open {db} failed; wal {db}.wal; spill {tmp_path}/data/spill/worker-1"
    assert scrubber.text(text) == (
        f"open {PLACEHOLDER} failed; wal {PLACEHOLDER}.wal; spill {PLACEHOLDER}/worker-1"
    )


def test_leaves_the_parent_directory_alone(tmp_path: Path) -> None:
    # Only the specific private paths are replaced: the directory they sit
    # in can also appear in people's own values.
    db = tmp_path / "data" / "taxi.duckdb"
    scrubber = PathScrubber(private_paths(db, tmp_path / "data" / "spill"))
    text = f"{tmp_path}/data/notes.csv"
    assert scrubber.text(text) == text


def test_skips_paths_too_short_to_replace_safely() -> None:
    # A database at /d/t.db would otherwise turn this URL into nonsense.
    scrubber = PathScrubber([Path("/d/t.db"), Path("/data")])
    assert len("/d/t.db") < MIN_PATH_CHARS
    text = "https://example.com/data/y and /d/t.db"
    assert scrubber.text(text) == text


def test_replaces_both_the_given_and_the_resolved_spelling(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    scrubber = PathScrubber([link / "taxi.duckdb"])
    assert scrubber.text(f"{link}/taxi.duckdb and {real.resolve()}/taxi.duckdb") == (
        f"{PLACEHOLDER} and {PLACEHOLDER}"
    )


def test_never_replaces_the_filesystem_root_or_an_empty_path() -> None:
    scrubber = PathScrubber([Path("/"), Path(""), Path(".")])
    assert scrubber.text("/etc/passwd . x") == "/etc/passwd . x"


def test_cleans_nested_values_and_keys(tmp_path: Path) -> None:
    scrubber = PathScrubber([tmp_path])
    value: JsonValue = {f"{tmp_path}/k": [f"{tmp_path}/a", 1, None, {"x": f"at {tmp_path}"}]}
    assert scrubber.value(value) == {
        f"{PLACEHOLDER}/k": [f"{PLACEHOLDER}/a", 1, None, {"x": f"at {PLACEHOLDER}"}]
    }


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    # Reached through a symlink, so the worker is given one spelling of the
    # path and DuckDB reports the other in places.
    real = tmp_path / "real-data"
    real.mkdir()
    write_query_test_db(real / "nb.duckdb")
    link = tmp_path / "data"
    link.symlink_to(real)
    return link


@pytest.fixture
async def runner(data_dir: Path) -> AsyncIterator[QueryRunner]:
    pool = QueryRunner(
        data_dir / "nb.duckdb", data_dir / "spill", LIMITS, workers=1, queue_timeout_seconds=5
    )
    await pool.start()
    yield pool
    await pool.close()


def _db_spellings(data_dir: Path) -> list[str]:
    return [str(data_dir / "nb.duckdb"), str((data_dir / "nb.duckdb").resolve())]


async def test_engine_errors_name_no_server_paths(runner: QueryRunner, data_dir: Path) -> None:
    for db in _db_spellings(data_dir):
        with pytest.raises(QueryFailedError) as info:
            await runner.run(f"select * from read_text('{db}.other')")
        message = str(info.value)
        assert db not in message
        assert f"{PLACEHOLDER}.other" in message


async def test_result_values_and_column_names_name_no_server_paths(
    runner: QueryRunner, data_dir: Path
) -> None:
    spill = data_dir / "spill"
    for db in _db_spellings(data_dir):
        result = await runner.run(
            f"select '{db}' as file, ['{db}.wal'] as wals, "
            f"{{'at': '{spill}/worker-x'}} as s, 1 as \"{db}\""
        )
        assert result["rows"] == [
            [PLACEHOLDER, [f"{PLACEHOLDER}.wal"], {"at": f"{PLACEHOLDER}/worker-x"}, 1],
        ]
        assert result["columns"][3]["name"] == PLACEHOLDER


async def test_ordinary_values_are_untouched(runner: QueryRunner, data_dir: Path) -> None:
    result = await runner.run(
        f"select '/etc/passwd' as p, 'spill' as s, '{data_dir}/notes.csv' as d, i from nums limit 1"
    )
    assert result["rows"] == [["/etc/passwd", "spill", f"{data_dir}/notes.csv", 0]]
