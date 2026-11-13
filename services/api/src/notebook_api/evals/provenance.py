"""Which code and SDK produced a run, so a resume never mixes two versions in one report."""

import hashlib
import importlib.metadata
import shutil
import subprocess
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[1]  # src/notebook_api
_GIT_TIMEOUT_SECONDS = 10


def sdk_version() -> str:
    try:
        return importlib.metadata.version("anthropic")
    except importlib.metadata.PackageNotFoundError:
        return "not installed"


def code_sha256(root: Path = PACKAGE_ROOT) -> str:
    """SHA-256 over every .py file under the API package (paths and contents).

    Unlike the git commit, this changes with uncommitted and untracked edits
    too, which is what matters for "did the code change since the pilot".
    """
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        digest.update(str(path.relative_to(root)).encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def git_state(cwd: Path = PACKAGE_ROOT) -> tuple[str, bool | None]:
    """(commit, has uncommitted changes); ("unknown", None) without git."""
    git = shutil.which("git")
    if git is None:
        return "unknown", None
    try:
        # Fixed arguments, no shell, and the git found on PATH.
        commit = subprocess.run(  # noqa: S603
            [git, "-C", str(cwd), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=True,
        ).stdout.strip()
        status = subprocess.run(  # noqa: S603
            [git, "-C", str(cwd), "status", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=True,
        ).stdout
    except OSError, subprocess.SubprocessError:
        return "unknown", None
    return commit or "unknown", bool(status.strip())


def provenance() -> dict[str, Any]:
    commit, dirty = git_state()
    return {
        "sdk_version": sdk_version(),
        "git_commit": commit,
        "git_dirty": dirty,
        "code_sha256": code_sha256(),
    }
