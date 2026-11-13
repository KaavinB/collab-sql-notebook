"""Error responses: always `{"detail": {"kind": str, "message": str}}`, never echoing input.

FastAPI's defaults differ: a 422 lists every error with the rejected input
attached, and errors raised by the framework (a body that isn't UTF-8, an
unknown route, a wrong method) carry a bare string. The handlers here give
every error the same shape, so the client can always show `message`.

A 422 message is built only from text this app controls: field names it
declared (read from its own OpenAPI schema) and a fixed phrase per error
type. Pydantic's `loc` can contain caller-chosen keys and its `msg` can
quote input, so neither is copied into the response.
"""

from collections.abc import Iterable, Mapping
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

# Where an error can be: FastAPI's first `loc` element.
_SOURCES = frozenset({"body", "path", "query", "header", "cookie"})

# Fixed wording per pydantic error type. Anything unlisted is "is invalid".
_PHRASES: Mapping[str, str] = {
    "missing": "is required",
    "string_type": "must be a string",
    "string_too_short": "is too short",
    "string_too_long": "is too long",
    "string_pattern_mismatch": "has an invalid format",
    "uuid_parsing": "must be a UUID",
    "uuid_type": "must be a UUID",
    "int_parsing": "must be an integer",
    "int_type": "must be an integer",
    "bool_parsing": "must be true or false",
    "bool_type": "must be true or false",
    "json_invalid": "is not valid JSON",
    "model_attributes_type": "must be a JSON object",
    "dict_type": "must be a JSON object",
    "list_type": "must be a list",
    "literal_error": "is not one of the allowed values",
    "enum": "is not one of the allowed values",
}

# Limits in pydantic's error context come from our schema, not the input.
_LIMIT_PHRASES: Mapping[str, str] = {
    "min_length": "at least {} characters",
    "max_length": "at most {} characters",
}

_KIND_BY_STATUS: Mapping[int, str] = {
    400: "bad_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "too_large",
}

MAX_REPORTED_ERRORS = 3


def declared_names(openapi: Mapping[str, Any]) -> frozenset[str]:
    """Every parameter and schema property name declared in an OpenAPI document."""
    names: set[str] = set()
    for path_item in openapi.get("paths", {}).values():
        for operation in path_item.values():
            if isinstance(operation, Mapping):
                for parameter in operation.get("parameters", []):
                    names.add(parameter["name"])
    for schema in openapi.get("components", {}).get("schemas", {}).values():
        names.update(schema.get("properties", {}))
    return frozenset(names)


def describe_validation_errors(errors: Iterable[Mapping[str, Any]], allowed: frozenset[str]) -> str:
    """One short sentence naming each problem, using only allowlisted words."""
    problems: list[str] = []
    for error in list(errors)[:MAX_REPORTED_ERRORS]:
        parts: list[str] = []
        for i, part in enumerate(error.get("loc", ())):
            if isinstance(part, str) and (part in allowed or (i == 0 and part in _SOURCES)):
                parts.append(part)
            elif isinstance(part, int) and not isinstance(part, bool):
                parts.append(f"[{part}]")  # a list index or JSON offset, not input text
            else:
                parts.append("*")
        where = ".".join(parts) or "request"
        phrase = _PHRASES.get(str(error.get("type", "")), "is invalid")
        context = error.get("ctx") or {}
        limits = [
            template.format(value)
            for key, template in _LIMIT_PHRASES.items()
            if isinstance(value := context.get(key), int) and not isinstance(value, bool)
        ]
        if limits:
            phrase += f" ({', '.join(limits)})"
        problems.append(f"{where} {phrase}")
    return "Invalid request: " + "; ".join(problems) + "."


def _error(
    status_code: int, kind: str, message: str, headers: Mapping[str, str] | None = None
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"detail": {"kind": kind, "message": message}},
        headers=dict(headers) if headers else None,
    )


def install_error_handlers(app: FastAPI) -> None:
    allowed: frozenset[str] | None = None

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError) -> JSONResponse:
        nonlocal allowed
        if allowed is None:  # the schema is complete once routes are registered
            allowed = declared_names(app.openapi())
        return _error(422, "invalid", describe_validation_errors(error.errors(), allowed))

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, error: StarletteHTTPException) -> JSONResponse:
        detail = error.detail
        if (
            isinstance(detail, Mapping)
            and isinstance(detail.get("kind"), str)
            and isinstance(detail.get("message"), str)
        ):
            # Raised by our own routes, already in shape.
            return _error(error.status_code, detail["kind"], detail["message"], error.headers)
        # Raised by the framework with a fixed string ("Not Found", "There was
        # an error parsing the body"): those never contain input.
        kind = _KIND_BY_STATUS.get(error.status_code, "http_error")
        return _error(error.status_code, kind, str(detail), error.headers)
