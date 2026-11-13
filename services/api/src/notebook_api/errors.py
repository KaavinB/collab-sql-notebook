"""Error responses: always `{"detail": {"kind": str, "message": str}}`, never echoing input.

FastAPI's defaults differ: a 422 lists every error with the rejected input
attached, and errors raised by the framework (a body that isn't UTF-8, an
unknown route, a wrong method) carry a bare string. The handlers here give
those, and unexpected server errors (500), the same shape, so the client
can always show `message`.

Not covered: requests refused by middleware before the app runs, namely an
unknown Host header (TrustedHostMiddleware) and a CORS preflight from an
origin that isn't allowed. Those answer in plain text; neither comes from
the web app, which always uses an allowed host and origin. Also, a 500 is
produced outside the CORS middleware, so it has no CORS headers: the
browser hides its body from the web app, which shows a generic network
error instead. The body is still the standard shape for other clients.

A 422 message is built only from text this app controls: field names it
declared (read from its own OpenAPI schema) and a fixed phrase per error
type. Pydantic's `loc` can contain caller-chosen keys and its `msg` can
quote input, so neither is copied into the response.
"""

from collections.abc import Iterable, Mapping
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.utils import is_body_allowed_for_status_code
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
    "too_short": "has too few items",
    "too_long": "has too many items",
    "literal_error": "is not one of the allowed values",
    "enum": "is not one of the allowed values",
}

# Limits in pydantic's error context come from our schema, not the input.
# The unit depends on what was measured: text length or a list's items.
_LIMIT_UNITS: Mapping[str, str] = {
    "string_too_short": "character",
    "string_too_long": "character",
    "too_short": "item",
    "too_long": "item",
}
_LIMIT_WORDS: Mapping[str, str] = {"min_length": "at least", "max_length": "at most"}

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
        error_type = str(error.get("type", ""))
        phrase = _PHRASES.get(error_type, "is invalid")
        unit = _LIMIT_UNITS.get(error_type)
        context = error.get("ctx") or {}
        limits = [
            f"{words} {value} {unit}{'' if value == 1 else 's'}"
            for key, words in _LIMIT_WORDS.items()
            if unit is not None
            and isinstance(value := context.get(key), int)
            and not isinstance(value, bool)
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
    """Install the handlers. Call after every route is registered.

    The 422 allowlist is read from the app's OpenAPI schema here, at
    startup, so a route whose schema can't be generated fails at boot
    instead of turning every later validation error into a 500.
    """
    allowed = declared_names(app.openapi())

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError) -> JSONResponse:
        return _error(422, "invalid", describe_validation_errors(error.errors(), allowed))

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, error: StarletteHTTPException) -> Response:
        if not is_body_allowed_for_status_code(error.status_code):
            # 204 and 304 must not have a body at all.
            return Response(status_code=error.status_code, headers=error.headers)
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

    @app.exception_handler(Exception)
    async def server_error(request: Request, error: Exception) -> JSONResponse:
        # Starlette still logs the exception (with its traceback) and re-raises
        # it to the server after this response is sent; the client only gets
        # a generic message, never internals.
        return _error(500, "internal", "Something went wrong on the server.")
