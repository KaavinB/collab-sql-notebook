"""An adversarial corpus run against the real query path.

Every case goes through what a cell's Run does: `QueryRunner.run` (or
`.explain`, which the AI validator uses), which parses and checks the SQL
with sqlglot and then runs it on a locked-down DuckDB in a worker process
with a timeout, a row cap, a size cap and a memory limit. Each case states
the outcome it must get, so a regression in any layer (the parser, the
engine lockdown, the limits, the kill) shows up as a failed case.

Outcomes:
- rejected: refused by the parser before any worker sees it.
- engine_error: reached DuckDB, which refused it (file access off,
  settings locked, function not available, ...).
- timeout: stopped by the timeout, by DuckDB's interrupt or by the parent
  killing the worker.
- out_of_memory: DuckDB's memory limit (or, on Linux, the worker's
  RLIMIT_DATA cap) turned it into an error.
- bounded: out_of_memory or timeout, depending on the platform: on Linux
  RLIMIT_DATA makes the allocation fail; macOS doesn't enforce RLIMIT_DATA,
  so the timeout kill ends it there. Either way it can't hold a worker past
  the timeout plus the kill grace.
- row_cap / byte_cap: ran, and the result was cut short.
- harmless: ran and returned something, and the case says why that's fine.

Two checks apply to every case: it ends within the timeout plus the kill
grace (plus a little scheduling slack), and nothing it returns, result or
error, contains a server path (the database file, its directory, the spill
directory).
"""

import asyncio
import sys
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

import pytest

from notebook_api.query.engine import EngineLimits, QueryResult
from notebook_api.query.runner import KILL_GRACE_SECONDS, QueryFailedError, QueryRunner
from notebook_api.query.validate import MAX_SQL_CHARS, QueryRejectedError
from tests.fixtures import write_query_test_db

pytestmark = pytest.mark.anyio

LIMITS = EngineLimits(
    memory_limit_mb=256,
    process_memory_cap_mb=1024,
    threads=1,
    max_spill_size_mb=100,
    timeout_seconds=0.5,
    row_limit=100,
    max_result_bytes=1_000_000,
)
# Time on top of the timeout and the kill grace for parsing, sending the
# query and reading the reply on a busy test machine. Not a measurement.
_SLACK_SECONDS = 2.0
_DB_NAME = "corpus.duckdb"


class Outcome(Enum):
    REJECTED = "rejected"
    ENGINE_ERROR = "engine_error"
    TIMEOUT = "timeout"
    OUT_OF_MEMORY = "out_of_memory"
    BOUNDED = "bounded"
    ROW_CAP = "row_cap"
    BYTE_CAP = "byte_cap"
    HARMLESS = "harmless"


@dataclass(frozen=True)
class Case:
    id: str
    sql: str
    expect: Outcome
    # For rejected and engine_error: a piece of the message that must appear.
    match: str = ""
    # Why a harmless case is allowed to run (required for HARMLESS).
    why: str = ""
    mode: str = "run"  # "run" (a cell) or "explain" (the AI validator)


R, E, T, M, B = (
    Outcome.REJECTED,
    Outcome.ENGINE_ERROR,
    Outcome.TIMEOUT,
    Outcome.OUT_OF_MEMORY,
    Outcome.BOUNDED,
)
_NOT_SELECT = "Only SELECT"
_FILES_OFF = "disabled by configuration"
_SERVER_INFO = "describes the server"
_NOT_ALLOWED = "is not allowed"
_INVISIBLE = "invisible character"
_ENGINE_CONTROL = "controls the query engine"
# Written as code points: ruff flags lookalike letters in string literals.
_FULLWIDTH_SELECT = "".join(chr(0xFF00 + ord(c) - 0x20) for c in "SELECT")
_CYRILLIC_DZE = chr(0x0455)  # looks like a Latin "s"
_CYRILLIC_IE = chr(0x0435)  # looks like a Latin "e"
_ZWSP = chr(0x200B)  # zero-width space
_ZWJ = chr(0x200D)  # zero-width joiner
_WJ = chr(0x2060)  # word joiner
_BOM = chr(0xFEFF)  # byte-order mark (zero-width no-break space)
_RLO = chr(0x202E)  # right-to-left override
_NBSP = chr(0x00A0)  # no-break space

FILE_AND_NETWORK_READERS = [
    Case("read_csv", "select * from read_csv('/etc/passwd')", E, _FILES_OFF),
    Case("read_csv_auto", "select * from read_csv_auto('/etc/passwd')", E, _FILES_OFF),
    Case("read_parquet", "select * from read_parquet('/etc/passwd')", E, _FILES_OFF),
    Case("parquet_scan", "select * from parquet_scan('/etc/passwd')", E, _FILES_OFF),
    Case("read_json", "select * from read_json('/etc/passwd')", E, _FILES_OFF),
    Case("read_json_auto", "select * from read_json_auto('/etc/passwd')", E, _FILES_OFF),
    Case("read_ndjson_objects", "select * from read_ndjson_objects('/etc/passwd')", E, _FILES_OFF),
    Case("read_text", "select * from read_text('/etc/passwd')", E, _FILES_OFF),
    Case("read_blob", "select * from read_blob('/etc/passwd')", E, _FILES_OFF),
    Case("read_text_list", "select * from read_text(['/etc/passwd', '/etc/hosts'])", E, _FILES_OFF),
    Case("read_text_dollar_quoted", "select * from read_text($$/etc/passwd$$)", E, _FILES_OFF),
    Case("read_text_relative_env", "select * from read_text('../../.env')", E, _FILES_OFF),
    Case("read_text_home", "select * from read_text('~/.ssh/id_rsa')", E, _FILES_OFF),
    Case("read_text_file_url", "select * from read_text('file:///etc/passwd')", E, _FILES_OFF),
    Case("glob", "select * from glob('/etc/*')", E, _FILES_OFF),
    Case("sniff_csv", "select * from sniff_csv('/etc/passwd')", E, _FILES_OFF),
    Case("parquet_metadata", "select * from parquet_metadata('/etc/passwd')", E, _FILES_OFF),
    Case("parquet_schema", "select * from parquet_schema('/etc/passwd')", E, _FILES_OFF),
    Case("csv_in_subquery", "select (select count(*) from read_csv('/etc/passwd'))", E, _FILES_OFF),
    Case(
        "csv_in_union",
        "select 'a' as x union all select column0 from read_csv('/etc/passwd')",
        E,
        _FILES_OFF,
    ),
    Case("http", "select * from read_csv('https://example.com/x.csv')", E, _FILES_OFF),
    Case(
        "cloud_metadata",
        "select * from read_text('http://169.254.169.254/latest/meta-data/')",
        E,
        _FILES_OFF,
    ),
    Case("s3", "select * from read_parquet('s3://bucket/x.parquet')", E, _FILES_OFF),
    # A quoted path as a table name is a "replacement scan" in DuckDB; with
    # external access off it's just an unknown table.
    Case("replacement_scan", "select * from '/etc/passwd'", E, "does not exist"),
    # Readers from extensions that aren't loaded, and can't be (autoload off).
    Case("sqlite_scan", "select * from sqlite_scan('/etc/passwd', 'x')", E, "extension"),
    Case("read_xlsx", "select * from read_xlsx('/etc/passwd')", E, "extension"),
    Case("postgres_scan", "select * from postgres_scan('host=x', 'public', 'users')", E),
]

STATEMENTS = [
    Case("attach", "ATTACH '/tmp/x.db' AS x", R, _NOT_SELECT),
    Case("attach_memory", "attach database ':memory:' as m", R, _NOT_SELECT),
    Case("detach", "DETACH corpus", R, _NOT_SELECT),
    Case("copy_to", "COPY nums TO '/tmp/out.csv'", R, _NOT_SELECT),
    Case("copy_query_to", "COPY (select 1) TO '/tmp/out.csv'", R, _NOT_SELECT),
    Case("export", "EXPORT DATABASE '/tmp/export'", R, "Could not parse"),
    Case("install", "INSTALL httpfs", R, _NOT_SELECT),
    Case("force_install", "FORCE INSTALL httpfs", R, _NOT_SELECT),
    Case("load", "LOAD httpfs", R, _NOT_SELECT),
    Case("pragma", "PRAGMA database_list", R, _NOT_SELECT),
    Case("set", "SET threads = 64", R, _NOT_SELECT),
    Case("set_global", "SET GLOBAL enable_external_access = true", R, _NOT_SELECT),
    Case("reset", "RESET threads", R, _NOT_SELECT),
    Case("call", "CALL pragma_version()", R, _NOT_SELECT),
    Case("create_table", "CREATE TEMP TABLE t AS SELECT 1", R, _NOT_SELECT),
    Case("create_macro", "CREATE MACRO m(x) AS x", R, _NOT_SELECT),
    Case("create_secret", "CREATE SECRET (TYPE s3, KEY_ID 'x', SECRET 'y')", R),
    Case("insert", "INSERT INTO nums VALUES (1)", R, _NOT_SELECT),
    Case("insert_select", "INSERT INTO nums SELECT 1", R, _NOT_SELECT),
    Case("update", "UPDATE nums SET i = 1", R, _NOT_SELECT),
    Case("delete", "DELETE FROM nums", R, _NOT_SELECT),
    Case("drop", "DROP TABLE nums", R, _NOT_SELECT),
    Case(
        "merge",
        "MERGE INTO nums USING (SELECT 1 AS i) s ON nums.i = s.i WHEN MATCHED THEN DELETE",
        R,
        _NOT_SELECT,
    ),
    Case("checkpoint", "CHECKPOINT", R, _NOT_SELECT),
    Case("vacuum", "VACUUM", R, _NOT_SELECT),
    Case("use", "USE system", R, _NOT_SELECT),
    Case("prepare", "PREPARE p AS SELECT 1", R, _NOT_SELECT),
    Case("execute", "EXECUTE p", R, _NOT_SELECT),
    Case("begin", "BEGIN TRANSACTION", R, _NOT_SELECT),
    Case("explain_statement", "EXPLAIN SELECT 1", R, _NOT_SELECT),
    Case("delete_in_cte", "with x as (delete from nums returning *) select * from x", R),
    Case("update_in_cte", "with x as (update nums set i = 1 returning *) select * from x", R),
    Case("insert_in_cte", "with x as (insert into nums values (1) returning *) select * from x", R),
    Case("insert_in_subquery", "select * from (insert into nums values (1) returning *)", R),
    Case("copy_in_set_op", "select 1 union all (copy nums to '/tmp/x.csv')", R),
    Case("copy_in_exists", "select 1 where exists (copy nums to '/tmp/x')", R),
    # sqlglot reads this as a table named "attach" aliased with the path:
    # DuckDB then finds no such table. Nothing is attached.
    Case(
        "attach_in_set_op", "select 1 union select * from (attach '/tmp/x.db')", E, "does not exist"
    ),
]

SQL_STRINGS_AND_SMUGGLING = [
    Case("query", "select * from query('drop table nums')", R, _NOT_ALLOWED),
    Case("query_upper", "select * from QUERY('select 1')", R, _NOT_ALLOWED),
    Case("query_quoted", "select * from \"query\"('select 1')", R, _NOT_ALLOWED),
    Case("query_qualified", "select * from system.main.query('select 1')", R, _NOT_ALLOWED),
    Case("query_table", "select * from query_table('nums')", R, _NOT_ALLOWED),
    Case(
        "query_table_in_cte",
        "with a as (select * from main.query_table('nums')) select * from a",
        R,
        _NOT_ALLOWED,
    ),
    Case(
        "query_in_where", "select 1 where 1 in (select * from query('select 1'))", R, _NOT_ALLOWED
    ),
    Case(
        "json_execute",
        "select json_execute_serialized_sql(json_serialize_sql('select 1'))",
        R,
        _NOT_ALLOWED,
    ),
    Case("two_statements", "select 1; drop table nums", R, "one statement"),
    Case(
        "statement_after_comment",
        "select 1 /* */; /* */ attach '/tmp/x.db' as x",
        R,
        "one statement",
    ),
    Case("begin_then_select", "BEGIN; SELECT 1", R, "one statement"),
    Case(
        "line_comment",
        "select 1 as x -- ; drop table nums",
        Outcome.HARMLESS,
        why="The rest of the line is a comment; comments are dropped from the SQL that runs.",
    ),
    Case(
        "block_comment",
        "select 1 as x /* ; drop table nums */",
        Outcome.HARMLESS,
        why="A block comment is dropped from the SQL that runs.",
    ),
    Case(
        "dollar_quoted_statement",
        "select 'a' || $tag$ ; drop table nums $tag$ as x",
        Outcome.HARMLESS,
        why="Text inside a dollar-quoted string is a string, not SQL.",
    ),
    Case(
        "escaped_quote",
        "select e'\\x27; drop' as x",
        Outcome.HARMLESS,
        why="An escape inside a string literal stays inside the string.",
    ),
    Case("fullwidth_select", _FULLWIDTH_SELECT + " 1", R, "Could not parse"),
    Case("cyrillic_s_select", _CYRILLIC_DZE + "elect 1", R, "Could not parse"),
    # A lookalike letter makes a different name that DuckDB doesn't know.
    Case("cyrillic_e_query", f"select qu{_CYRILLIC_IE}ry('select 1')", E, "does not exist"),
    # Invisible characters after a name: sqlglot keeps them in the name (an
    # unknown function to it), but DuckDB reads U+200B, U+2060 and U+FEFF as
    # whitespace, so before the fix these ran query() and current_setting().
    # (test_query_validate.py pins DuckDB's side and checks that every
    # format character is rejected.)
    Case("zero_width_space_query", f"select * from query{_ZWSP}('select 42')", R, _INVISIBLE),
    Case("word_joiner_query", f"select * from query{_WJ}('select 42')", R, _INVISIBLE),
    Case("byte_order_mark_query", f"select * from query{_BOM}('select 42')", R, _INVISIBLE),
    Case(
        "zero_width_space_setting",
        f"select current_setting{_ZWSP}('temp_directory')",
        R,
        _INVISIBLE,
    ),
    Case("zero_width_space_alias", f"select 1 as x{_ZWSP}", R, _INVISIBLE),
    Case("bidi_override_name", f'select 1 as "x{_RLO}y"', R, _INVISIBLE),
    # Both parsers read a no-break space as whitespace, so the name is the
    # real one and the server-information check applies.
    Case(
        "nbsp_between_words",
        f"select{_NBSP}current_setting{_NBSP}('temp_directory')",
        R,
        _SERVER_INFO,
    ),
    Case(
        "joiner_inside_string",
        f"select 'a{_ZWJ}b{_ZWSP}c' as x",
        Outcome.HARMLESS,
        why="Inside a string literal both parsers keep invisible characters as text.",
    ),
    Case(
        "newline_inside_string",
        "select $$a\nb$$ as x, e'c\\nd' as y",
        Outcome.HARMLESS,
        why="Line breaks inside strings are just text.",
    ),
    Case(
        "mixed_case",
        "sElEcT i FrOm NuMs LiMiT 1",
        Outcome.HARMLESS,
        why="Keywords and names are case-insensitive; it's an ordinary SELECT.",
    ),
    Case(
        "quoted_identifiers",
        'select "i" from "main"."nums" limit 1',
        Outcome.HARMLESS,
        why="Quoted names of the dataset's own tables.",
    ),
    Case("backticks", "select `i` from nums", R, "Could not parse"),
    Case("too_long", "select " + "1+" * (MAX_SQL_CHARS // 2) + "1", R, "longer than"),
    Case("deep_parens", "select " + "(" * 1000 + "1" + ")" * 1000, R, "nested too deeply"),
    Case(
        "deep_subqueries",
        "select * from " + "(select * from " * 200 + "nums" + ")" * 200,
        R,
        "nested too deeply",
    ),
    Case(
        "long_flat_chain",
        "select " + " + ".join(["1"] * 300) + " as x",
        Outcome.HARMLESS,
        why="Long but flat: within the parser's limits, and cheap to run.",
    ),
    # DuckDB-only statements inside a subquery are parsed by sqlglot (so the
    # checks above see their contents) and read the dataset's own metadata.
    Case(
        "summarize_subquery",
        "select * from (summarize nums)",
        Outcome.HARMLESS,
        why="Statistics of a table in the dataset.",
    ),
    Case(
        "describe_subquery",
        "select * from (describe nums)",
        Outcome.HARMLESS,
        why="Column names and types of a table in the dataset.",
    ),
]

INFORMATION_LEAKS = [
    Case("duckdb_settings", "select * from duckdb_settings()", R, _SERVER_INFO),
    Case(
        "duckdb_settings_scalar_subquery",
        "select (select value from duckdb_settings() where name = 'temp_directory')",
        R,
        _SERVER_INFO,
    ),
    Case(
        "duckdb_settings_lateral", "select * from nums, lateral duckdb_settings()", R, _SERVER_INFO
    ),
    Case("pg_settings", "select * from pg_catalog.pg_settings", R, _SERVER_INFO),
    Case("pg_settings_quoted", 'select * from "PG_SETTINGS"', R, _SERVER_INFO),
    Case("current_setting", "select current_setting('temp_directory')", R, _SERVER_INFO),
    Case("current_setting_quoted", "select \"current_setting\"('temp_directory')", R, _SERVER_INFO),
    Case(
        "current_setting_qualified",
        "select system.main.current_setting('temp_directory')",
        R,
        _SERVER_INFO,
    ),
    Case(
        "current_setting_in_where",
        "select 1 from nums where current_setting('temp_directory') like '/%'",
        R,
        _SERVER_INFO,
    ),
    Case("duckdb_databases", "select * from duckdb_databases()", R, _SERVER_INFO),
    Case("duckdb_databases_view", "select * from duckdb_databases", R, _SERVER_INFO),
    Case(
        "duckdb_databases_qualified",
        "select * from system.main.duckdb_databases()",
        R,
        _SERVER_INFO,
    ),
    Case("pragma_database_list", "select * from pragma_database_list", R, _SERVER_INFO),
    Case("duckdb_temporary_files", "select * from duckdb_temporary_files()", R, _SERVER_INFO),
    Case("duckdb_extensions", "select * from duckdb_extensions()", R, _SERVER_INFO),
    Case("duckdb_secrets", "select * from duckdb_secrets()", R, _SERVER_INFO),
    Case("which_secret", "select * from which_secret('s3://x', 's3')", R, _SERVER_INFO),
    Case("getenv", "select getenv('HOME')", R, _SERVER_INFO),
    Case("duckdb_logs", "select * from duckdb_logs", R, _SERVER_INFO),
    Case("duckdb_logs_function", "select * from duckdb_logs()", R, _SERVER_INFO),
    Case("enable_logging", "select * from enable_logging()", R, _ENGINE_CONTROL),
    Case("duckdb_profiling_settings", "select * from duckdb_profiling_settings()", R, _SERVER_INFO),
    # Blocked views read through a string, with the value transformed so the
    # result scrubber can't recognise it. histogram_values and the histogram
    # table macro call query_table() on their first argument. (Found in
    # review: before the fix these returned the reversed database path, and
    # the spill directory and database file with '/' replaced.)
    Case(
        "histogram_values_reverse_db_path",
        "select * from histogram_values('pragma_database_list', reverse(file), "
        "technique := 'sample')",
        R,
        _NOT_ALLOWED,
    ),
    Case(
        "histogram_values_replace_settings",
        "select bin from histogram_values('pg_settings', name || '=' || "
        "replace(setting, '/', '|'), bin_count := 1000, technique := 'sample')",
        R,
        _NOT_ALLOWED,
    ),
    Case(
        "histogram_values_name_built_at_runtime",
        "select bin from histogram_values('pg_' || 'settings', replace(setting, '/', '|'))",
        R,
        _NOT_ALLOWED,
    ),
    Case(
        "histogram_values_qualified",
        "select * from system.main.histogram_values('pragma_database_list', file)",
        R,
        _NOT_ALLOWED,
    ),
    Case(
        "histogram_table_macro_reverse",
        "select * from histogram('pragma_database_list', reverse(file))",
        R,
        "table function",
    ),
    Case(
        "histogram_table_macro_lateral",
        "select * from nums, lateral histogram('pg_settings', replace(setting, '/', '|'))",
        R,
        "table function",
    ),
    Case(
        "histogram_table_macro_join",
        "select * from nums join histogram('pg_settings', replace(setting, '/', '|')) on true",
        R,
        "table function",
    ),
    Case(
        "histogram_aggregate",
        "select histogram(i % 3) as h from nums",
        Outcome.HARMLESS,
        why="The histogram aggregate counts a column's values; it reads no table by name.",
    ),
    # The worker's runtime state and platform: no paths, but they describe
    # the server, not the data, so they're blocked with the rest.
    Case("duckdb_memory", "select * from duckdb_memory()", R, _SERVER_INFO),
    Case("duckdb_connection_count", "select * from duckdb_connection_count()", R, _SERVER_INFO),
    Case(
        "pragma_version",
        "select * from pragma_version()",
        Outcome.HARMLESS,
        why="DuckDB's version isn't secret, and the scalar version() returns the same.",
    ),
    Case(
        "version_scalar",
        "select version() as v",
        Outcome.HARMLESS,
        why="DuckDB's version isn't secret (the project's dependencies are public).",
    ),
    Case("pragma_platform", "select * from pragma_platform()", R, _SERVER_INFO),
    Case("pragma_database_size", "select * from pragma_database_size()", R, _SERVER_INFO),
    # State changes and internal plumbing.
    Case("truncate_duckdb_logs", "select * from truncate_duckdb_logs()", R, _ENGINE_CONTROL),
    Case("checkpoint_function", "select * from checkpoint()", R, _ENGINE_CONTROL),
    Case("arrow_scan", "select * from arrow_scan(1, 2, 3)", R, _ENGINE_CONTROL),
    Case(
        "duckdb_tables",
        "select table_name from duckdb_tables()",
        Outcome.HARMLESS,
        why="The dataset's own tables; the AI schema context reads the same thing.",
    ),
    Case(
        "current_database",
        "select current_database()",
        Outcome.HARMLESS,
        why="The database's name, which is the file name without its directory.",
    ),
    Case(
        "current_query",
        "select current_query()",
        Outcome.HARMLESS,
        why="The query's own text; each query runs on a fresh cursor.",
    ),
]

RESOURCE_ATTACKS = [
    Case("cross_join", "select sum(a.i * b.i) from nums a, nums b, nums c", T),
    Case(
        "recursive_cte_forever",
        "with recursive r(n) as (select 1 union all select n + 1 from r) select count(*) from r",
        T,
    ),
    # These two: DuckDB's memory limit usually stops them first; on a loaded
    # machine the timeout can get there before it.
    Case(
        "recursive_cte_doubling",
        "with recursive r(s) as (select 'x' union all select s || s from r) "
        "select length(s) from r",
        B,
    ),
    Case("string_agg_bomb", "select length(string_agg(repeat('x', 100000), '')) from nums", B),
    Case("range_huge", "select count(*) from range(1000000000000)", T),
    Case("repeat_2gb", "select repeat('x', 2000000000)", B),
    Case("huge_list", "select range(30000000)", B),
    Case("list_sum_huge", "select list_sum(range(100000000))", B),
    Case(
        "regex_backtracking",
        "select regexp_matches(repeat('a', 100000), '(a*)*b')",
        Outcome.HARMLESS,
        why="DuckDB's regex engine (RE2) runs in linear time: no catastrophic backtracking.",
    ),
    Case("row_cap", "select * from nums", Outcome.ROW_CAP),
    Case("byte_cap", "select i, repeat('x', 100000) as s from nums", Outcome.BYTE_CAP),
    # Constant folding: the optimizer evaluates constant expressions while
    # planning, where DuckDB's interrupt isn't checked. Running it is
    # bounded like any query; EXPLAIN (the AI validator) is the risky path.
    # The brief's example. Folding it peaks well above a gigabyte on this
    # project's dev Mac (a scratch measurement), so on Linux the worker's
    # 1024 MB RLIMIT_DATA can end it as out-of-memory before the timeout.
    Case("fold_explain", "select length(repeat('x', 300000000))", B, mode="explain"),
    # Six 100 MB strings, folded one after another: long enough to pass the
    # timeout, small enough at a time to stay under the Linux memory cap.
    Case(
        "fold_explain_hash",
        "select " + " || ".join(f"md5(repeat('{c}', 100000000))" for c in "uvwxyz"),
        T,
        mode="explain",
    ),
    Case("fold_explain_list", "select list_sum(range(100000000))", B, mode="explain"),
    Case(
        "cross_join_explain",
        "select sum(a.i * b.i) from nums a, nums b, nums c",
        Outcome.HARMLESS,
        why="EXPLAIN plans without running, so the join never executes.",
        mode="explain",
    ),
]

CORPUS = [
    *FILE_AND_NETWORK_READERS,
    *STATEMENTS,
    *SQL_STRINGS_AND_SMUGGLING,
    *INFORMATION_LEAKS,
    *RESOURCE_ATTACKS,
]


def test_corpus_ids_are_unique_and_harmless_cases_say_why() -> None:
    ids = [case.id for case in CORPUS]
    assert len(ids) == len(set(ids))
    for case in CORPUS:
        assert (case.expect is Outcome.HARMLESS) == bool(case.why), case.id


@pytest.fixture(scope="module")
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="module")
def corpus_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    directory = tmp_path_factory.mktemp("corpus")
    write_query_test_db(directory / _DB_NAME)
    return directory


@pytest.fixture(scope="module")
async def runner(corpus_dir: Path) -> AsyncIterator[QueryRunner]:
    # One pool for the whole corpus; cases that get a worker killed wait for
    # its replacement through the (long) queue timeout.
    pool = QueryRunner(
        corpus_dir / _DB_NAME, corpus_dir / "spill", LIMITS, workers=2, queue_timeout_seconds=30
    )
    await pool.start()
    yield pool
    await pool.close()


def _server_paths(corpus_dir: Path) -> list[str]:
    # The paths the workers keep private: the database file and the spill
    # root, each as given and resolved.
    db, spill = corpus_dir / _DB_NAME, corpus_dir / "spill"
    paths = {str(db), str(spill), str(db.resolve()), str(spill.resolve())}
    return sorted(paths)


def _texts(result: QueryResult) -> list[str]:
    texts = [column["name"] for column in result["columns"]]
    pending: list[object] = [value for row in result["rows"] for value in row]
    while pending:
        value = pending.pop()
        if isinstance(value, str):
            texts.append(value)
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, dict):
            texts.extend(value)
            pending.extend(value.values())
    return texts


@pytest.mark.parametrize("case", CORPUS, ids=lambda case: case.id)
async def test_adversarial_case(case: Case, runner: QueryRunner, corpus_dir: Path) -> None:
    started = time.monotonic()
    result: QueryResult | None = None
    outcome: Outcome
    message = ""
    try:
        if case.mode == "explain":
            await runner.explain(case.sql)
        else:
            result = await runner.run(case.sql)
    except QueryRejectedError as error:
        outcome, message = Outcome.REJECTED, str(error)
    except QueryFailedError as error:
        message = str(error)
        if error.kind == "timeout":
            outcome = Outcome.TIMEOUT
        elif error.kind == "error" and "more memory" in message:
            outcome = Outcome.OUT_OF_MEMORY
        elif error.kind == "error":
            outcome = Outcome.ENGINE_ERROR
        else:
            pytest.fail(f"the query service failed ({error.kind}): {message}")
    else:
        if result is not None and result["truncated"]:
            full = result["row_count"] == LIMITS.row_limit
            outcome = Outcome.ROW_CAP if full else Outcome.BYTE_CAP
        else:
            outcome = Outcome.HARMLESS
    elapsed = time.monotonic() - started

    expected = {case.expect}
    if case.expect is Outcome.BOUNDED:
        expected = {Outcome.OUT_OF_MEMORY, Outcome.TIMEOUT}
    assert outcome in expected, f"{case.id}: got {outcome.value} ({message!r})"
    if case.match:
        assert case.match in message, f"{case.id}: {message!r}"
    assert elapsed < LIMITS.timeout_seconds + KILL_GRACE_SECONDS + _SLACK_SECONDS, case.id

    seen = [message, *(_texts(result) if result is not None else [])]
    for path in _server_paths(corpus_dir):
        assert not any(path in text for text in seen), f"{case.id} revealed {path}"


async def test_the_pool_is_whole_after_the_corpus(runner: QueryRunner) -> None:
    # Runs after the corpus (pytest keeps file order): workers killed by
    # timeouts were replaced, and the pool answers normally.
    for _ in range(100):
        if len(runner._all) == 2 and runner._idle.qsize() == 2:
            break
        await asyncio.sleep(0.05)
    assert len(runner._all) == 2
    assert (await runner.run("select count(*) as n from nums"))["rows"] == [[10000]]


@pytest.mark.skipif(sys.platform != "linux", reason="RLIMIT_DATA is only enforced on Linux")
async def test_on_linux_a_single_huge_value_is_an_out_of_memory_error(runner: QueryRunner) -> None:
    # The "bounded" case above, pinned to its Linux outcome: one 2 GB string
    # is allocated outside DuckDB's buffer manager, and the worker's 1024 MB
    # RLIMIT_DATA cap makes the allocation fail at once, before the timeout.
    # (Runs in `pnpm test:api:linux`.)
    with pytest.raises(QueryFailedError, match="more memory") as info:
        await runner.run("select repeat('x', 2000000000)")
    assert info.value.kind == "error"
