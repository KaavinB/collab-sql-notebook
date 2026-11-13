"""Error response shape and the no-echo rule for validation messages."""

from fastapi.testclient import TestClient

from notebook_api.config import Settings
from notebook_api.errors import declared_names, describe_validation_errors
from notebook_api.main import create_app

ALLOWED = frozenset({"sql", "title", "notebook_id"})


def _client() -> TestClient:
    return TestClient(create_app(Settings(api_allowed_hosts=["testserver"])))


def test_declared_names_come_from_the_apps_own_schema() -> None:
    names = declared_names(create_app(Settings()).openapi())
    assert {"sql", "title", "notebook_id", "cell_id", "run_id"} <= names


def test_a_caller_chosen_key_in_the_location_is_never_echoed() -> None:
    message = describe_validation_errors(
        [{"loc": ("body", "<script>private</script>", "sql"), "type": "missing", "msg": "x"}],
        ALLOWED,
    )
    assert message == "Invalid request: body.*.sql is required."


def test_pydantic_messages_are_replaced_by_fixed_phrases() -> None:
    # pydantic's own msg can quote the input (e.g. the bad character of a UUID).
    message = describe_validation_errors(
        [
            {
                "loc": ("path", "notebook_id"),
                "type": "uuid_parsing",
                "msg": "invalid character: found `PRIVATE`",
                "input": "PRIVATE",
            }
        ],
        ALLOWED,
    )
    assert message == "Invalid request: path.notebook_id must be a UUID."


def test_schema_limits_are_reported_but_input_values_are_not() -> None:
    message = describe_validation_errors(
        [
            {
                "loc": ("body", "sql"),
                "type": "string_too_long",
                "ctx": {"max_length": 20000, "pattern": "PRIVATE"},
                "input": "PRIVATE",
            },
            {"loc": ("body", 10), "type": "json_invalid", "ctx": {"error": "PRIVATE"}},
            {"loc": ("body", "title"), "type": "some_future_type", "msg": "PRIVATE"},
        ],
        ALLOWED,
    )
    assert message == (
        "Invalid request: body.sql is too long (at most 20000 characters); "
        "body.[10] is not valid JSON; body.title is invalid."
    )


def test_at_most_three_problems_are_reported() -> None:
    errors = [{"loc": ("body", "sql"), "type": "missing"}] * 10
    assert describe_validation_errors(errors, ALLOWED).count("is required") == 3


def test_a_body_that_is_not_utf8_gets_the_standard_shape() -> None:
    with _client() as client:
        response = client.post(
            "/notebooks",
            content=b'{"title": "\xff"}',
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 400
    assert response.json() == {
        "detail": {"kind": "bad_request", "message": "There was an error parsing the body"}
    }


def test_framework_errors_get_the_standard_shape_and_keep_their_headers() -> None:
    with _client() as client:
        missing = client.get("/no-such-route")
        wrong_method = client.put("/health")
    assert missing.status_code == 404
    assert missing.json() == {"detail": {"kind": "not_found", "message": "Not Found"}}
    assert wrong_method.status_code == 405
    assert wrong_method.json()["detail"]["kind"] == "method_not_allowed"
    assert wrong_method.headers["allow"] == "GET"
