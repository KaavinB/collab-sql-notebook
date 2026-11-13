import io
import json
import stat
import zipfile
from pathlib import Path

import pytest

from notebook_api.evals import bird
from notebook_api.evals.bird import (
    ChecksumMismatchError,
    UnsafeArchiveError,
    ensure_archive,
    ensure_dev_set,
    httpx2_fetch,
    load_questions,
    safe_extract,
)
from tests.evals.helpers import FOLDER, FakeFetch, archive_for, build_dev_zip


def test_downloads_verifies_extracts_and_loads(tmp_path: Path) -> None:
    content = build_dev_zip(tmp_path)
    fetch = FakeFetch(content)
    dataset = ensure_dev_set(tmp_path / "bird", archive_for(content), fetch)

    assert fetch.calls == ["https://example.test/dev.zip"]
    assert dataset.root == tmp_path / "bird" / FOLDER
    questions = dataset.questions()
    assert [q.question_id for q in questions] == [1, 2, 3, 4, 5, 6]
    assert questions[0].evidence == "hint 1"
    assert dataset.database_path("shop").is_file()
    # Only what's needed is extracted: no .DS_Store, no __MACOSX, no dev.sql,
    # and the temporary inner zip is gone.
    extracted = sorted(
        str(p.relative_to(dataset.root)) for p in dataset.root.rglob("*") if p.is_file()
    )
    assert extracted == [".extracted.json", "dev.json", "dev_databases/shop/shop.sqlite"]
    # No staging or partial files left next to it.
    assert sorted(p.name for p in (tmp_path / "bird").iterdir()) == sorted([FOLDER, "dev.zip"])


def test_rerun_reuses_the_verified_copy_without_downloading(tmp_path: Path) -> None:
    content = build_dev_zip(tmp_path)
    archive = archive_for(content)
    ensure_dev_set(tmp_path / "bird", archive, FakeFetch(content))
    again = FakeFetch(content)
    ensure_dev_set(tmp_path / "bird", archive, again)
    assert again.calls == []


def test_a_damaged_extracted_copy_is_extracted_again(tmp_path: Path) -> None:
    content = build_dev_zip(tmp_path)
    archive = archive_for(content)
    dataset = ensure_dev_set(tmp_path / "bird", archive, FakeFetch(content))
    db = dataset.database_path("shop")
    db.write_bytes(b"truncated")
    fetch = FakeFetch(content)
    ensure_dev_set(tmp_path / "bird", archive, fetch)
    assert fetch.calls == []  # the archive itself was still good
    assert db.stat().st_size > len(b"truncated")


def test_checksum_mismatch_is_refused_and_nothing_is_kept(tmp_path: Path) -> None:
    content = build_dev_zip(tmp_path)
    archive = archive_for(content)
    with pytest.raises(ChecksumMismatchError):
        ensure_dev_set(tmp_path / "bird", archive, FakeFetch(content + b"tampered"))
    assert list((tmp_path / "bird").iterdir()) == []


def test_an_existing_archive_with_the_wrong_hash_is_replaced(tmp_path: Path) -> None:
    content = build_dev_zip(tmp_path)
    archive = archive_for(content)
    (tmp_path / "bird").mkdir()
    (tmp_path / "bird" / "dev.zip").write_bytes(b"old corrupt download")
    fetch = FakeFetch(content)
    path = ensure_archive(archive, tmp_path / "bird", fetch)
    assert fetch.calls == [archive.url]
    assert path.read_bytes() == content


def test_a_changed_pin_invalidates_the_extracted_copy(tmp_path: Path) -> None:
    content = build_dev_zip(tmp_path)
    ensure_dev_set(tmp_path / "bird", archive_for(content), FakeFetch(content))
    other = build_dev_zip(tmp_path, extra_inner={"dev_databases/x/readme.txt": b"new"})
    fetch = FakeFetch(other)
    ensure_dev_set(tmp_path / "bird", archive_for(other), fetch)
    assert fetch.calls  # the old copy was for another archive hash


def _zip_with(name: str, content: bytes = b"x", mode: int | None = None) -> zipfile.ZipFile:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        info = zipfile.ZipInfo(name)
        if mode is not None:
            info.external_attr = mode << 16
        z.writestr(info, content)
    return zipfile.ZipFile(io.BytesIO(buffer.getvalue()))


@pytest.mark.parametrize(
    "name",
    ["../evil.sqlite", "dev_databases/../../evil", "/etc/evil", "a\\..\\evil"],
)
def test_zip_slip_member_names_are_refused(tmp_path: Path, name: str) -> None:
    archive = _zip_with(name)
    dest = tmp_path / "dest"
    dest.mkdir()
    with pytest.raises(UnsafeArchiveError):
        safe_extract(archive, archive.infolist()[0], dest, name, bird._Budget(10**6))
    assert not (tmp_path / "evil.sqlite").exists()
    assert list(dest.iterdir()) == []


def test_a_target_path_through_a_symlink_out_of_the_directory_is_refused(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / "link").symlink_to(outside)
    archive = _zip_with("link/evil")
    with pytest.raises(UnsafeArchiveError):
        safe_extract(archive, archive.infolist()[0], dest, "link/evil", bird._Budget(10**6))
    assert list(outside.iterdir()) == []


def test_symlink_members_are_refused(tmp_path: Path) -> None:
    archive = _zip_with("dev_databases/a/a.sqlite", b"/etc/passwd", stat.S_IFLNK | 0o777)
    with pytest.raises(UnsafeArchiveError, match="link"):
        safe_extract(
            archive,
            archive.infolist()[0],
            tmp_path,
            "dev_databases/a/a.sqlite",
            bird._Budget(10**6),
        )


def test_oversized_members_and_totals_are_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bird, "MAX_MEMBER_BYTES", 10)
    archive = _zip_with("big", b"x" * 11)
    with pytest.raises(UnsafeArchiveError):
        safe_extract(archive, archive.infolist()[0], tmp_path, "big", bird._Budget(10**6))
    monkeypatch.setattr(bird, "MAX_MEMBER_BYTES", 10**6)
    archive = _zip_with("small", b"x" * 11)
    with pytest.raises(UnsafeArchiveError):
        safe_extract(archive, archive.infolist()[0], tmp_path / "t", "small", bird._Budget(5))


def test_a_zip_slip_member_inside_the_real_layout_is_ignored_not_written(tmp_path: Path) -> None:
    # Names that aren't dev_databases/<db>/<db>.sqlite are never extracted.
    content = build_dev_zip(tmp_path, extra_inner={"../../escape.sqlite": b"x"})
    ensure_dev_set(tmp_path / "bird", archive_for(content), FakeFetch(content))
    assert not (tmp_path / "escape.sqlite").exists()
    assert not (tmp_path / "bird" / "escape.sqlite").exists()


def test_download_requires_https(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="https"):
        httpx2_fetch("http://example.test/dev.zip", tmp_path / "x", 10)


def test_database_ids_must_be_plain_names(tmp_path: Path) -> None:
    content = build_dev_zip(tmp_path)
    dataset = ensure_dev_set(tmp_path / "bird", archive_for(content), FakeFetch(content))
    with pytest.raises(bird.BirdDataError):
        dataset.database_path("../shop")


@pytest.mark.parametrize(
    "items",
    [
        {"not": "a list"},
        [{"question_id": 1}],
        [
            {
                "question_id": 1,
                "db_id": "a",
                "question": "q",
                "evidence": "",
                "SQL": "s",
                "difficulty": "impossible",
            },
        ],
        [
            {
                "question_id": 1,
                "db_id": "a",
                "question": "q",
                "evidence": "",
                "SQL": "s",
                "difficulty": "simple",
            },
            {
                "question_id": 1,
                "db_id": "a",
                "question": "q2",
                "evidence": "",
                "SQL": "s",
                "difficulty": "simple",
            },
        ],
    ],
)
def test_malformed_dev_json_is_refused(tmp_path: Path, items: object) -> None:
    path = tmp_path / "dev.json"
    path.write_text(json.dumps(items))
    with pytest.raises(bird.BirdDataError):
        load_questions(path)


def test_full_check_catches_same_size_corruption(tmp_path: Path) -> None:
    content = build_dev_zip(tmp_path)
    archive = archive_for(content)
    dataset = ensure_dev_set(tmp_path / "bird", archive, FakeFetch(content))
    dev_json = dataset.root / "dev.json"
    original = dev_json.read_bytes()
    dev_json.write_bytes(original.replace(b"London", b"Lund0n"))  # same size, other bytes

    ensure_dev_set(tmp_path / "bird", archive, FakeFetch(content))
    assert dev_json.read_bytes() != original  # the cheap size check can't see it

    ensure_dev_set(tmp_path / "bird", archive, FakeFetch(content), full_check=True)
    assert dev_json.read_bytes() == original  # the full check re-extracted it
