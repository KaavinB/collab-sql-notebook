"""The BIRD dev set: download, checksum, safe extraction and loading.

BIRD (https://bird-bench.github.io/) is a text-to-SQL benchmark over real,
messy SQLite databases. Its data is licensed CC BY-SA 4.0 (the license the
BIRD site states since 2024-04-27). We download it at run time into the
gitignored data directory and never commit or redistribute it.

We use the official dev archive the BIRD site links to. Its folder inside the
archive is `dev_20240627`, the dev set as revised in June 2024. The archive
holds dev.json (1534 questions with gold SQL, BIRD's `evidence` hints and a
difficulty label) and a nested dev_databases.zip with one SQLite file per
database. On 2026-11-13 the archive was 346,207,293 bytes (measured with
`ls -l` on the download), and the 11 SQLite files we extract total about
1.5 GB uncompressed (as listed in the archive's own directory).

Safety: the archive is checked against a pinned SHA-256 before anything is
extracted from it, a download whose hash doesn't match is deleted, and
extraction writes only the members we need, refusing any name that would
land outside the target directory (zip-slip), links, and members larger than
a fixed cap. The extracted copy is then reused through its manifest (see
ensure_dev_set for how much each run re-checks).
"""

import hashlib
import json
import re
import secrets
import shutil
import stat
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import IO, Any

import httpx2

_CHUNK_BYTES = 1024 * 1024
_CONNECT_TIMEOUT_SECONDS = 30.0
# Between two received chunks, not the whole download (346 MB can take minutes).
_READ_TIMEOUT_SECONDS = 120.0
_USER_AGENT = "collab-sql-notebook-eval"

# Bounds on what extraction may write, so a corrupted or hostile archive
# can't fill the disk. The largest real database (european_football_2) is
# about 600 MB; all 11 together about 1.5 GB.
MAX_MEMBER_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024
_MAX_DEV_JSON_BYTES = 50 * 1024 * 1024

# A database id names a directory and a file, so only plain names are accepted.
_DB_ID = re.compile(r"^[A-Za-z0-9_]{1,64}$")
DIFFICULTIES = ("simple", "moderate", "challenging")


@dataclass(frozen=True)
class Archive:
    url: str
    filename: str
    sha256: str
    size: int  # bytes; a download that grows past this is stopped early
    folder: str  # top-level folder inside the archive


# Recorded from the file the official link served on 2026-11-13. If BIRD
# republishes it, the download fails loudly instead of silently changing the
# benchmark; after reviewing the change, update the pin in its own commit.
DEV_ARCHIVE = Archive(
    url="https://bird-bench.oss-cn-beijing.aliyuncs.com/dev.zip",
    filename="dev.zip",
    sha256="cdd6d19faeb45a23970b98d3ef6c40a87987c95459c2cf12076897a60cf5a630",
    size=346_207_293,
    folder="dev_20240627",
)

Fetcher = Callable[[str, Path, int], None]


class ChecksumMismatchError(Exception):
    """The downloaded archive's SHA-256 doesn't match the pinned value."""


class UnsafeArchiveError(Exception):
    """The archive holds a member we refuse to extract (path escape, link, too big)."""


class BirdDataError(Exception):
    """dev.json or the databases aren't in the shape we expect."""


@dataclass(frozen=True)
class BirdQuestion:
    question_id: int
    db_id: str
    question: str
    evidence: str
    gold_sql: str
    difficulty: str


@dataclass(frozen=True)
class BirdDataset:
    root: Path  # holds dev.json and dev_databases/<db_id>/<db_id>.sqlite
    archive_sha256: str

    def database_path(self, db_id: str) -> Path:
        if not _DB_ID.match(db_id):
            raise BirdDataError(f"invalid database id: {db_id!r}")
        return self.root / "dev_databases" / db_id / f"{db_id}.sqlite"

    def questions(self) -> list[BirdQuestion]:
        return load_questions(self.root / "dev.json")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def httpx2_fetch(url: str, dest: Path, max_bytes: int) -> None:
    """Stream `url` to `dest` over https, stopping if it grows past `max_bytes`."""
    if not url.startswith("https://"):
        raise ValueError(f"refusing non-https download: {url}")
    timeout = httpx2.Timeout(_READ_TIMEOUT_SECONDS, connect=_CONNECT_TIMEOUT_SECONDS)
    written = 0
    with (
        httpx2.stream(
            "GET",
            url,
            timeout=timeout,
            follow_redirects=False,
            headers={"User-Agent": _USER_AGENT},
        ) as response,
        dest.open("wb") as out,
    ):
        response.raise_for_status()
        for chunk in response.iter_bytes(_CHUNK_BYTES):
            written += len(chunk)
            if written > max_bytes:
                raise ChecksumMismatchError(
                    f"download is larger than the pinned {max_bytes} bytes; refusing it"
                )
            out.write(chunk)


def ensure_archive(archive: Archive, bird_dir: Path, fetch: Fetcher = httpx2_fetch) -> Path:
    """A verified local copy of `archive`, downloaded if missing or corrupt.

    The hash is checked on every call, including reuse: it's what makes the
    benchmark the same one each time. A fresh download goes to a randomly
    named `.part` file and is renamed into place only once its hash matches.
    """
    bird_dir.mkdir(parents=True, exist_ok=True)
    target = bird_dir / archive.filename
    if target.exists():
        if sha256_of(target) == archive.sha256:
            return target
        target.unlink()

    partial = bird_dir / f".{archive.filename}.{secrets.token_hex(8)}.part"
    try:
        fetch(archive.url, partial, archive.size)
        actual = sha256_of(partial)
        if actual != archive.sha256:
            raise ChecksumMismatchError(
                f"{archive.filename}: expected sha256 {archive.sha256}, got {actual}"
            )
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def ensure_dev_set(
    bird_dir: Path,
    archive: Archive = DEV_ARCHIVE,
    fetch: Fetcher = httpx2_fetch,
    *,
    full_check: bool = False,
) -> BirdDataset:
    """Download (if needed), verify and extract the BIRD dev set; reuse a verified copy.

    Extraction goes to a staging directory that is renamed into place only
    when complete, with a manifest of every file's size and SHA-256 (taken
    while extracting from the verified archive). A rerun trusts an extracted
    copy only if its manifest names the pinned archive hash and every listed
    file still has its recorded size; with `full_check` (the `download`
    command), every file's SHA-256 is recomputed and compared too, which reads
    about 1.5 GB. A copy that fails either check is extracted again.
    """
    root = bird_dir / archive.folder
    manifest = root / ".extracted.json"
    if _extracted_copy_is_intact(manifest, archive.sha256, full_check=full_check):
        return BirdDataset(root=root, archive_sha256=archive.sha256)

    zip_path = ensure_archive(archive, bird_dir, fetch)
    staging = bird_dir / f".{archive.folder}.{secrets.token_hex(8)}.staging"
    staging.mkdir()
    try:
        files = _extract_dev_set(zip_path, archive.folder, staging)
        (staging / ".extracted.json").write_text(
            json.dumps({"archive_sha256": archive.sha256, "files": files}, indent=2)
        )
        if root.exists():
            shutil.rmtree(root)
        staging.replace(root)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return BirdDataset(root=root, archive_sha256=archive.sha256)


def _extracted_copy_is_intact(manifest: Path, archive_sha256: str, *, full_check: bool) -> bool:
    try:
        recorded = json.loads(manifest.read_text())
    except OSError, ValueError:
        return False
    if not isinstance(recorded, dict) or recorded.get("archive_sha256") != archive_sha256:
        return False
    files = recorded.get("files")
    if not isinstance(files, dict) or not files:
        return False
    root = manifest.parent
    for name, entry in files.items():
        if not isinstance(name, str) or not isinstance(entry, dict):
            return False
        path = root / name
        if not _is_inside(path, root) or not path.is_file():
            return False
        if path.stat().st_size != entry.get("size"):
            return False
        if full_check and sha256_of(path) != entry.get("sha256"):
            return False
    return True


def _extract_dev_set(zip_path: Path, folder: str, dest: Path) -> dict[str, dict[str, Any]]:
    """Extract dev.json and every dev_databases/<db>/<db>.sqlite into `dest`.

    Returns {relative path: {"size", "sha256"}} for the manifest.
    """
    files: dict[str, dict[str, Any]] = {}
    budget = _Budget(MAX_TOTAL_BYTES)
    with zipfile.ZipFile(zip_path) as outer:
        dev_json = outer.getinfo(f"{folder}/dev.json")
        files["dev.json"] = safe_extract(outer, dev_json, dest, "dev.json", budget)
        inner_info = outer.getinfo(f"{folder}/dev_databases.zip")
        # The databases are in a zip inside the zip. It's copied out to a
        # temporary file (zipfile needs to seek), then deleted.
        inner_path = dest / ".dev_databases.zip"
        try:
            safe_extract(outer, inner_info, dest, inner_path.name, _Budget(MAX_TOTAL_BYTES))
            with zipfile.ZipFile(inner_path) as inner:
                for info in inner.infolist():
                    relative = _database_member(info.filename)
                    if relative is not None:
                        files[relative] = safe_extract(inner, info, dest, relative, budget)
        finally:
            inner_path.unlink(missing_ok=True)
    if len(files) < 2:
        raise BirdDataError("the archive has no dev databases")
    return files


def _database_member(name: str) -> str | None:
    """`dev_databases/<db>/<db>.sqlite` -> that relative path; anything else -> None."""
    parts = PurePosixPath(name).parts
    if len(parts) == 3 and parts[0] == "dev_databases" and parts[2] == f"{parts[1]}.sqlite":
        return name
    return None


class _Budget:
    def __init__(self, total: int) -> None:
        self.remaining = total

    def spend(self, size: int) -> None:
        self.remaining -= size
        if self.remaining < 0:
            raise UnsafeArchiveError("the archive expands to more than the allowed total size")


def safe_extract(
    archive: zipfile.ZipFile, info: zipfile.ZipInfo, dest: Path, relative: str, budget: _Budget
) -> dict[str, Any]:
    """Write one member to `dest/relative`, refusing anything unsafe.

    Refused: a member name or target path that is absolute or contains `..`
    or otherwise resolves outside `dest` (zip-slip), a symbolic link, a
    directory, and a member bigger than MAX_MEMBER_BYTES. The size check uses
    the bytes actually written, not just the header's claim, which an
    attacker controls.
    """
    for name in (info.filename, relative):
        pure = PurePosixPath(name)
        if pure.is_absolute() or ".." in pure.parts or "\\" in name or name.startswith("/"):
            raise UnsafeArchiveError(f"refusing archive member with an unsafe path: {name!r}")
    mode = info.external_attr >> 16
    if stat.S_ISLNK(mode):
        raise UnsafeArchiveError(f"refusing archive member that is a link: {info.filename!r}")
    if info.is_dir():
        raise UnsafeArchiveError(f"expected a file, got a directory: {info.filename!r}")
    if info.file_size > MAX_MEMBER_BYTES:
        raise UnsafeArchiveError(f"archive member is too large: {info.filename!r}")

    target = dest / relative
    if not _is_inside(target, dest):
        raise UnsafeArchiveError(f"refusing archive member outside the target: {relative!r}")
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    written = 0
    try:
        with archive.open(info) as source, target.open("xb") as out:
            written = _copy_bounded(source, out, digest)
    except FileExistsError:
        raise UnsafeArchiveError(f"archive repeats a member: {relative!r}") from None
    budget.spend(written)
    return {"size": written, "sha256": digest.hexdigest()}


def _copy_bounded(source: IO[bytes], out: IO[bytes], digest: Any) -> int:
    written = 0
    while chunk := source.read(_CHUNK_BYTES):
        written += len(chunk)
        if written > MAX_MEMBER_BYTES:
            raise UnsafeArchiveError("archive member expands past the size cap")
        digest.update(chunk)
        out.write(chunk)
    return written


def _is_inside(path: Path, root: Path) -> bool:
    return path.resolve().is_relative_to(root.resolve())


def load_questions(dev_json: Path) -> list[BirdQuestion]:
    """Parse dev.json strictly: every field present with the right type."""
    if dev_json.stat().st_size > _MAX_DEV_JSON_BYTES:
        raise BirdDataError("dev.json is unexpectedly large")
    raw = json.loads(dev_json.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise BirdDataError("dev.json is not a list")
    questions: list[BirdQuestion] = []
    seen: set[int] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise BirdDataError(f"dev.json item {index} is not an object")
        qid, db_id = item.get("question_id"), item.get("db_id")
        question, evidence = item.get("question"), item.get("evidence", "")
        gold, difficulty = item.get("SQL"), item.get("difficulty")
        if not (
            isinstance(qid, int)
            and not isinstance(qid, bool)
            and isinstance(db_id, str)
            and _DB_ID.match(db_id)
            and isinstance(question, str)
            and isinstance(evidence, str)
            and isinstance(gold, str)
            and difficulty in DIFFICULTIES
        ):
            raise BirdDataError(f"dev.json item {index} has missing or invalid fields")
        if qid in seen:
            raise BirdDataError(f"dev.json repeats question_id {qid}")
        seen.add(qid)
        questions.append(
            BirdQuestion(
                question_id=qid,
                db_id=db_id,
                question=question,
                evidence=evidence,
                gold_sql=gold,
                difficulty=str(difficulty),
            )
        )
    return questions
