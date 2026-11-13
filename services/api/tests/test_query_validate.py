from concurrent.futures import ThreadPoolExecutor

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


def test_row_limit_must_be_positive() -> None:
    with pytest.raises(ValueError, match="row_limit"):
        prepare_query("select 1", row_limit=0)
