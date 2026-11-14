import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor

import duckdb
import pytest

from notebook_api.query.validate import QueryRejectedError, prepare_query


@pytest.mark.parametrize(
    "sql",
    [
        "select 1",
        "select 1;",
        "  SELECT 1  ;  ",
        "from trips",
        "with a as (select 1 as x) select * from a",
        "select 1 union all select 2",
        "select 1 intersect select 1",
        "select 1 except select 2",
        "select * exclude (vendor_id) from trips",
        "select vendor_id, count(*) from trips group by all order by all",
        "select * from trips qualify row_number() over () < 3",
        "select * from (select 1) as sub",
        "select (select max(i) from nums) as m",
        "select * from read_csv('x.csv')",  # allowed here; the engine blocks file access
    ],
)
def test_accepts_single_read_only_queries(sql: str) -> None:
    prepare_query(sql, row_limit=100)


@pytest.mark.parametrize(
    "sql",
    [
        "insert into trips values (1)",
        "update trips set vendor_id = 1",
        "delete from trips",
        "drop table trips",
        "create table x as select 1",
        "alter table trips add column x int",
        "copy trips to 'out.csv'",
        "attach 'other.db' as other",
        "detach other",
        "pragma version",
        "set memory_limit = '10GB'",
        "use other",
        "begin transaction",
        "explain select 1",  # unparsed Command
        "call pragma_version()",  # unparsed Command
        "load httpfs",  # unparsed Command
        "install httpfs",
        "describe trips",
        "show tables",
        "summarize trips",
        "pivot trips on vendor_id using count(*)",
        "values (1), (2)",
        "(select 1)",
        "with a as (insert into t values (1) returning *) select * from a",
    ],
)
def test_rejects_anything_but_a_select(sql: str) -> None:
    with pytest.raises(QueryRejectedError):
        prepare_query(sql, row_limit=100)


@pytest.mark.parametrize(
    "sql",
    [
        "select * from query('drop table trips')",
        "select * from QUERY('select 1')",
        "select * from query_table('trips')",
        "select * from trips where vendor_id in (select * from query('select 1'))",
        "with a as (select * from query_table('trips')) select * from a",
        "select json_execute_serialized_sql(json_serialize_sql('select 1'))",
    ],
)
def test_rejects_functions_that_run_sql_strings(sql: str) -> None:
    with pytest.raises(QueryRejectedError, match=r"\(\) is not allowed"):
        prepare_query(sql, row_limit=100)


@pytest.mark.parametrize(
    "sql",
    [
        "select 'unterminated",  # TokenError, not ParseError
        'select "unterminated',
        "select * from trips where x = $$abc",
    ],
)
def test_tokenizer_errors_are_rejections_not_crashes(sql: str) -> None:
    with pytest.raises(QueryRejectedError, match="Could not parse"):
        prepare_query(sql, row_limit=100)


def _nested_parens(depth: int) -> str:
    return "select " + "(" * depth + "1" + ")" * depth


def _nested_subqueries(depth: int) -> str:
    return "select * from " + "(select * from " * depth + "nums" + ")" * depth


@pytest.mark.parametrize("on_thread", [False, True], ids=["main", "thread"])
def test_nesting_limits_on_main_and_worker_threads(on_thread: bool) -> None:
    # Pins accepted/rejected nesting bounds, with a margin, on the main
    # thread and on a worker thread (where the API parses). If a sqlglot or
    # Python upgrade moves them, these bounds need reviewing.
    def check() -> None:
        prepare_query(_nested_parens(40), row_limit=100)
        prepare_query(_nested_subqueries(85), row_limit=100)
        prepare_query("select " + " + ".join(["1"] * 300), row_limit=100)
        with pytest.raises(QueryRejectedError, match="nested too deeply"):
            prepare_query(_nested_parens(50), row_limit=100)
        with pytest.raises(QueryRejectedError, match="nested too deeply"):
            prepare_query(_nested_subqueries(100), row_limit=100)

    if on_thread:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(check).result()
    else:
        check()


def test_absurd_nesting_is_a_rejection_not_a_crash() -> None:
    with pytest.raises(QueryRejectedError):
        prepare_query("select " + "(" * 5000 + "1" + ")" * 5000, row_limit=100)


def test_rejects_multiple_statements() -> None:
    with pytest.raises(QueryRejectedError, match="one statement"):
        prepare_query("select 1; select 2", row_limit=100)


def test_rejects_select_followed_by_a_write() -> None:
    with pytest.raises(QueryRejectedError):
        prepare_query("select 1; drop table trips", row_limit=100)


@pytest.mark.parametrize("sql", ["", "   ", ";", "-- just a comment"])
def test_rejects_empty_input(sql: str) -> None:
    with pytest.raises(QueryRejectedError, match="empty"):
        prepare_query(sql, row_limit=100)


def test_rejects_unparseable_sql() -> None:
    with pytest.raises(QueryRejectedError, match="Could not parse"):
        prepare_query("select (", row_limit=100)


def test_adds_a_limit_of_row_limit_plus_one() -> None:
    prepared = prepare_query("select * from trips", row_limit=100)
    assert prepared.sql == "SELECT * FROM trips LIMIT 101"


def test_keeps_a_smaller_user_limit_and_offset() -> None:
    prepared = prepare_query("select * from trips order by 1 limit 10 offset 5", row_limit=100)
    assert prepared.sql == "SELECT * FROM trips ORDER BY 1 LIMIT 10 OFFSET 5"


def test_lowers_a_larger_user_limit() -> None:
    prepared = prepare_query("select * from trips order by 1 limit 100000", row_limit=100)
    assert prepared.sql == "SELECT * FROM trips ORDER BY 1 LIMIT 101"


def test_limits_a_set_operation_as_a_whole() -> None:
    prepared = prepare_query("select 1 union all select 2", row_limit=100)
    assert prepared.sql == "SELECT 1 UNION ALL SELECT 2 LIMIT 101"


@pytest.mark.parametrize(
    "sql",
    [
        "select * from zones limit 10%",
        "select * from trips limit (select 5)",
        "select * from trips limit 2 * 3",
    ],
)
def test_wraps_queries_whose_limit_is_not_a_plain_integer(sql: str) -> None:
    prepared = prepare_query(sql, row_limit=100)
    assert prepared.sql.startswith("SELECT * FROM (")
    assert prepared.sql.endswith(") AS capped_query LIMIT 101")


def test_executes_regenerated_sql_not_the_original_text() -> None:
    prepared = prepare_query("select   1 as  x -- trailing comment", row_limit=100)
    assert prepared.sql == "SELECT 1 AS x LIMIT 101"


@pytest.mark.parametrize(
    "sql",
    [
        "select 1 -- */ ; drop table trips",
        "select 1 -- x */ union select 2",
        "select 1 /* -- */",
    ],
)
def test_comments_are_dropped_so_they_cannot_smuggle_sql(sql: str) -> None:
    prepared = prepare_query(sql, row_limit=100)
    assert prepared.sql == "SELECT 1 LIMIT 101"


def test_a_closed_block_comment_does_not_hide_a_second_statement() -> None:
    with pytest.raises(QueryRejectedError, match="one statement"):
        prepare_query("select 1 /* */ ; drop table trips", row_limit=100)


# Characters DuckDB reads as whitespace but sqlglot keeps inside a name.
_SEPARATORS_ONLY_DUCKDB_SEES = [chr(0x200B), chr(0x2060), chr(0xFEFF)]


@pytest.mark.parametrize("char", _SEPARATORS_ONLY_DUCKDB_SEES, ids=lambda c: f"U+{ord(c):04X}")
def test_duckdb_reads_these_invisible_characters_as_whitespace(char: str) -> None:
    # Pins the parser disagreement the invisible-character rule exists for:
    # to DuckDB this is query('select 42'), which runs a string as SQL. If a
    # DuckDB upgrade changes this, the rule is still right, just less needed.
    with duckdb.connect() as con:
        assert con.execute(f"select * from query{char}('select 42')").fetchall() == [(42,)]


def test_every_format_character_outside_a_string_is_rejected() -> None:
    # Every Unicode format character (category Cf: zero-width spaces and
    # joiners, byte-order marks, bidirectional controls, ...), in the
    # position that smuggled query() past the name check.
    format_chars = [
        chr(code) for code in range(0x110000) if unicodedata.category(chr(code)) == "Cf"
    ]
    assert set(_SEPARATORS_ONLY_DUCKDB_SEES) <= set(format_chars)
    for char in format_chars:
        with pytest.raises(QueryRejectedError, match="invisible character"):
            prepare_query(f"select * from query{char}('select 42')", row_limit=100)


def test_invisible_characters_inside_strings_are_kept() -> None:
    prepared = prepare_query(f"select 'a{chr(0x200D)}b{chr(0x200B)}c' as x", row_limit=100)
    assert f"'a{chr(0x200D)}b{chr(0x200B)}c'" in prepared.sql


# --- DuckDB's built-in macros ---------------------------------------------------------
#
# A macro's body is SQL that sqlglot never sees: calling the macro runs it.
# These tests read every built-in macro of the DuckDB version installed, so a
# release that adds one which reaches blocked functions fails here until
# someone looks at it.

# Built-in table macros reviewed and allowed. (None at the moment: the four
# in DuckDB 2.0 are all blocked.)
_REVIEWED_HARMLESS_TABLE_MACROS: frozenset[str] = frozenset()


def _builtin_macros(kind: str) -> list[tuple[str, str]]:
    with duckdb.connect() as con:
        rows = con.execute(
            "SELECT DISTINCT function_name, coalesce(macro_definition, '') "
            "FROM duckdb_functions() WHERE function_type = ? ORDER BY 1",
            [kind],
        ).fetchall()
    return [(str(name), str(body)) for name, body in rows]


def _reaches_blocked(body: str) -> list[str]:
    """The blocked names a macro body uses: names blocked everywhere as whole
    words, and names blocked only in FROM when they follow FROM, JOIN,
    LATERAL or a comma (`histogram(col)`, the aggregate, is fine)."""
    from notebook_api.query import validate

    everywhere = (
        validate._FORBIDDEN_FUNCTIONS
        | validate._ENGINE_CONTROL_FUNCTIONS
        | validate._SERVER_INFO_FUNCTIONS
        | validate._SERVER_INFO_TABLES
    )
    lowered = body.lower()
    found = [name for name in sorted(everywhere) if re.search(rf"(?<!\w){name}\b", lowered)]
    found += [
        name
        for name in sorted(validate._FORBIDDEN_IN_FROM)
        if re.search(rf"(\bfrom|\bjoin|\blateral|,)\s+(\"?\w+\"?\.)*{name}\s*\(", lowered)
    ]
    return found


def _rejected(sql: str) -> bool:
    try:
        prepare_query(sql, row_limit=100)
    except QueryRejectedError:
        return True
    return False


def test_every_builtin_macro_that_reaches_a_blocked_function_is_rejected() -> None:
    reaching = {
        (kind, name): _reaches_blocked(body)
        for kind in ("macro", "table_macro")
        for name, body in _builtin_macros(kind)
        if _reaches_blocked(body)
    }
    # Sanity: the scan does find the ones known today.
    assert ("table_macro", "histogram_values") in reaching
    assert ("table_macro", "duckdb_profiling_settings") in reaching
    for (kind, name), reached in reaching.items():
        sql = f"select * from {name}('nums', i)" if kind == "table_macro" else f"select {name}(1)"
        assert _rejected(sql), f"built-in {kind} {name} reaches {reached} but is allowed"


def test_every_builtin_table_macro_is_rejected_or_reviewed() -> None:
    names = [name for name, _ in _builtin_macros("table_macro")]
    assert names  # the query itself still finds them
    for name in names:
        if name in _REVIEWED_HARMLESS_TABLE_MACROS:
            assert not _rejected(f"select * from {name}('nums', i)"), name
        else:
            assert _rejected(f"select * from {name}('nums', i)"), (
                f"new built-in table macro {name}: review its body, then block it or "
                "list it in _REVIEWED_HARMLESS_TABLE_MACROS"
            )


# --- DuckDB's built-in table functions ------------------------------------------------
#
# Every built-in table function of the installed DuckDB is either blocked by
# name in validate.py or reviewed here with the reason it may run. A release
# that adds one fails test_every_builtin_table_function_is_blocked_or_reviewed
# until someone classifies it. tests/test_query_adversarial.py runs the risky
# ones through the real query path.

_FILE_READER = (
    "reads files or URLs: refused by the engine (external access off), except that DuckDB "
    "still allows the database file and the worker's own spill directory by exact path "
    "(the dataset itself and its spilled blocks; the paths are kept out of every result)"
)
_GENERATOR = "builds rows from its arguments; touches no file and no server state"
_DATASET_CATALOG = "describes the dataset's own tables (the AI schema context reads the same)"
_VIEW_LIST = (
    "lists the dataset's views plus DuckDB's own fixed internal view definitions, "
    "the same text on every server"
)
_ENGINE_REFERENCE = "a fixed reference list compiled into DuckDB, the same on every server"
_OWN_SESSION = "this query's own session; each query runs on a fresh cursor"

REVIEWED_TABLE_FUNCTIONS: dict[str, str] = {
    **{
        name: _FILE_READER
        for name in (
            "glob",
            "parquet_bloom_probe",
            "parquet_file_metadata",
            "parquet_full_metadata",
            "parquet_kv_metadata",
            "parquet_metadata",
            "parquet_scan",
            "parquet_schema",
            "read_blob",
            "read_csv",
            "read_csv_auto",
            "read_duckdb",
            "read_json",
            "read_json_auto",
            "read_json_objects",
            "read_json_objects_auto",
            "read_ndjson",
            "read_ndjson_auto",
            "read_ndjson_objects",
            "read_parquet",
            "read_single_csv_file",
            "read_single_json_file",
            "read_single_parquet_file",
            "read_text",
            "sniff_csv",
        )
    },
    **{
        name: _GENERATOR
        for name in (
            "generate_series",
            "json_each",
            "json_tree",
            "range",
            "repeat",
            "repeat_row",
            "unnest",
            "test_all_types",
            "test_vector_types",
        )
    },
    "summary": "summarises the subquery it's given, which goes through these same checks",
    **{
        name: _DATASET_CATALOG
        for name in (
            "duckdb_columns",
            "duckdb_constraints",
            "duckdb_dependencies",
            "duckdb_indexes",
            "duckdb_schemas",
            "duckdb_sequences",
            "duckdb_table_sample",
            "duckdb_tables",
            "duckdb_triggers",
            "duckdb_types",
            "pragma_show",
            "pragma_storage_info",
            "pragma_table_info",
        )
    },
    **{
        name: _ENGINE_REFERENCE
        for name in (
            "duckdb_available_metrics",
            "duckdb_coordinate_systems",
            "duckdb_dialects",
            "duckdb_external_resource_types",
            "duckdb_functions",
            "duckdb_keywords",
            "duckdb_optimizers",
            "duckdb_secret_type_parameters",
            "duckdb_secret_types",
            "icu_calendar_names",
            "pg_timezone_names",
            "pragma_collations",
        )
    },
    "duckdb_views": _VIEW_LIST,
    "pragma_version": "DuckDB's version, not secret: the scalar version() returns the same",
    "duckdb_prepared_statements": _OWN_SESSION,
    "duckdb_variables": _OWN_SESSION,
}


# --- DuckDB's built-in views ------------------------------------------------------------
#
# DuckDB defines views of its own (`duckdb_views() WHERE internal`) that are
# read as plain table names. Each is either blocked in _SERVER_INFO_TABLES or
# reviewed here, keyed "schema.view", with the reason it may be read.

_INFO_SCHEMA = "the standard information_schema catalog over the dataset's own tables"
_SQLITE_CATALOG = "a SQLite-style catalog of the dataset's own tables"
_PG_CATALOG = "a Postgres-style catalog over the dataset's own tables, columns and types"
_PG_CONSTANT = "a fixed Postgres compatibility table, the same on every server"

REVIEWED_INTERNAL_VIEWS: dict[str, str] = {
    **{
        f"information_schema.{name}": _INFO_SCHEMA
        for name in (
            "character_sets",
            "check_constraints",
            "columns",
            "constraint_column_usage",
            "constraint_table_usage",
            "key_column_usage",
            "referential_constraints",
            "schemata",
            "table_constraints",
            "tables",
        )
    },
    "information_schema.views": _VIEW_LIST,
    **{
        f"main.{name}": _DATASET_CATALOG
        for name in (
            "duckdb_columns",
            "duckdb_constraints",
            "duckdb_indexes",
            "duckdb_schemas",
            "duckdb_tables",
            "duckdb_types",
        )
    },
    "main.duckdb_views": _VIEW_LIST,
    **{
        f"main.{name}": _SQLITE_CATALOG
        for name in ("sqlite_master", "sqlite_schema", "sqlite_temp_master", "sqlite_temp_schema")
    },
    **{
        f"pg_catalog.{name}": _PG_CATALOG
        for name in (
            "pg_attrdef",
            "pg_attribute",
            "pg_class",
            "pg_constraint",
            "pg_depend",
            "pg_description",
            "pg_enum",
            "pg_index",
            "pg_indexes",
            "pg_namespace",
            "pg_proc",
            "pg_sequence",
            "pg_sequences",
            "pg_tables",
            "pg_type",
        )
    },
    "pg_catalog.pg_views": _VIEW_LIST,
    "pg_catalog.pg_database": "the attached databases' names and IDs, without their paths",
    "pg_catalog.pg_prepared_statements": _OWN_SESSION,
    **{f"pg_catalog.{name}": _PG_CONSTANT for name in ("pg_am", "pg_collation", "pg_tablespace")},
}


def _builtin_internal_views() -> list[tuple[str, str]]:
    with duckdb.connect() as con:
        rows = con.execute(
            "SELECT DISTINCT schema_name, view_name FROM duckdb_views() "
            "WHERE internal ORDER BY 1, 2"
        ).fetchall()
    return [(str(schema), str(name)) for schema, name in rows]


def test_every_builtin_view_is_blocked_or_reviewed() -> None:
    from notebook_api.query import validate

    views = _builtin_internal_views()
    assert ("pg_catalog", "pg_settings") in views  # the query itself still finds them
    unknown = []
    for schema, name in views:
        key = f"{schema}.{name}"
        if name in validate._SERVER_INFO_TABLES:
            assert key not in REVIEWED_INTERNAL_VIEWS, key
            assert _rejected(f"select * from {schema}.{name}"), f"{key} is listed but readable"
            assert _rejected(f"select * from {name}"), f"{name} is listed but readable"
        elif key not in REVIEWED_INTERNAL_VIEWS:
            unknown.append(key)
    assert not unknown, (
        f"new built-in views {unknown}: review each one (what does it select from?), then "
        "block it in _SERVER_INFO_TABLES in query/validate.py or add it to "
        "REVIEWED_INTERNAL_VIEWS with the reason it's safe"
    )


def _blocked_table_function_names() -> frozenset[str]:
    from notebook_api.query import validate

    return (
        validate._FORBIDDEN_FUNCTIONS
        | validate._ENGINE_CONTROL_FUNCTIONS
        | validate._SERVER_INFO_FUNCTIONS
    )


def _builtin_table_functions() -> list[str]:
    with duckdb.connect() as con:
        rows = con.execute(
            "SELECT DISTINCT function_name FROM duckdb_functions() "
            "WHERE function_type = 'table' ORDER BY 1"
        ).fetchall()
    return [str(row[0]) for row in rows]


def test_every_builtin_table_function_is_blocked_or_reviewed() -> None:
    blocked = _blocked_table_function_names()
    assert not blocked & REVIEWED_TABLE_FUNCTIONS.keys()
    names = _builtin_table_functions()
    assert "read_csv" in names  # the query itself still finds them
    unknown = [
        name for name in names if name not in blocked and name not in REVIEWED_TABLE_FUNCTIONS
    ]
    assert not unknown, (
        f"new built-in table functions {unknown}: review each one (what does it return, "
        "does it change state?), then block it in query/validate.py or add it to "
        "REVIEWED_TABLE_FUNCTIONS with the reason it's safe"
    )
    for name in names:
        if name in blocked:
            # An argument, so names sqlglot knows (range, read_csv) still parse.
            assert _rejected(f"select * from {name}('nums')"), f"{name} is listed but runs"


@pytest.mark.parametrize(
    "sql",
    [
        "select histogram(i) from nums",
        "select histogram(i, [1, 2, 3]) as h from nums",
        "select (select histogram(i) from nums) as h",
    ],
)
def test_the_histogram_aggregate_still_works(sql: str) -> None:
    prepare_query(sql, row_limit=100)


@pytest.mark.parametrize(
    "sql",
    [
        "select * from histogram('nums', i)",
        "from histogram('nums', i) h",
        "select * from nums join histogram('nums', i) on true",
        "select * from nums, lateral histogram('nums', i)",
        "select * from nums where i in (from histogram('nums', i))",
        "select histogram_values('nums', i)",
    ],
)
def test_the_histogram_table_macros_are_rejected(sql: str) -> None:
    with pytest.raises(QueryRejectedError):
        prepare_query(sql, row_limit=100)


def test_row_limit_must_be_positive() -> None:
    with pytest.raises(ValueError, match="row_limit"):
        prepare_query("select 1", row_limit=0)
