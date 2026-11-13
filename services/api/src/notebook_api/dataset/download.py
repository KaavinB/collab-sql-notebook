"""Download dataset files and verify them against their pinned SHA-256."""

import hashlib
import secrets
import shutil
import urllib.request
from collections.abc import Callable
from pathlib import Path

from notebook_api.dataset.manifest import DatasetFile

Fetcher = Callable[[str, Path], None]

_CHUNK_BYTES = 1024 * 1024
_DOWNLOAD_TIMEOUT_SECONDS = 60


class ChecksumMismatchError(Exception):
    """A downloaded file's SHA-256 doesn't match the manifest."""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def https_fetch(url: str, dest: Path) -> None:
    """Stream `url` to `dest`. Only https is allowed."""
    if not url.startswith("https://"):
        raise ValueError(f"refusing non-https download: {url}")
    # The scheme is checked above, so urlopen can't be pointed at file:// etc.
    with (
        urllib.request.urlopen(url, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as response,  # noqa: S310
        dest.open("wb") as out,
    ):
        shutil.copyfileobj(response, out, _CHUNK_BYTES)


def ensure_file(file: DatasetFile, raw_dir: Path, fetch: Fetcher = https_fetch) -> Path:
    """Return the path to a verified local copy of `file`, downloading it if needed.

    An existing file with the right hash is reused. An existing file with the
    wrong hash (a partial or corrupted download) is replaced. A fresh download
    goes to a `.part` file and is only renamed into place once its hash
    matches, so a verified-looking file is never half-written.
    """
    raw_dir.mkdir(parents=True, exist_ok=True)
    target = raw_dir / file.filename
    if target.exists():
        if sha256_of(target) == file.sha256:
            return target
        target.unlink()

    # Random suffix so two concurrent runs never write the same partial file.
    # Keep this pattern in sync with stale_partial_files().
    partial = target.with_name(f".{target.name}.{secrets.token_hex(8)}.part")
    try:
        fetch(file.url, partial)
        actual = sha256_of(partial)
        if actual != file.sha256:
            raise ChecksumMismatchError(
                f"{file.filename}: expected sha256 {file.sha256}, got {actual}"
            )
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def stale_partial_files(raw_dir: Path) -> list[Path]:
    """Partial downloads left behind by a killed run.

    Only safe to delete while holding the ingest lock (see cli.ingest_lock).
    """
    return sorted(raw_dir.glob(".*.part"))
