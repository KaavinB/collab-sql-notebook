import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from notebook_api.ai.pipeline import ModelClient
from notebook_api.evals.cli import DEFAULT_TAXI_QUESTIONS, Dependencies, main
from notebook_api.evals.clients import DryRunModelClient
from notebook_api.evals.taxi import NOT_MEASURED, TaxiAIWiring, default_taxi_wiring
from tests.evals.helpers import (
    QUESTIONS,
    FakeFetch,
    FakeModelClient,
    FakeTaxiWiring,
    ScriptedGenerate,
    archive_for,
    build_dev_zip,
    write_taxi_db,
)
from tests.evals.test_runner import ANSWERS


class Harness:
    def __init__(self, tmp_path: Path) -> None:
        self.tmp_path = tmp_path
        self.data_dir = tmp_path / "data"
        content = build_dev_zip(tmp_path)
        self.fetch = FakeFetch(content)
        self.archive = archive_for(content)
        self.generate = ScriptedGenerate(dict(ANSWERS))
        self.lines: list[str] = []
        self.factory_calls: list[tuple[str, str]] = []
        self.clients: list[FakeModelClient] = []
        self.wiring: TaxiAIWiring | None = None
        self.taxi_questions = tmp_path / "taxi_questions.toml"
        shutil.copy(DEFAULT_TAXI_QUESTIONS, self.taxi_questions)
        self.taxi_db = write_taxi_db(tmp_path / "taxi.duckdb")
        self.versions = {
            "sdk_version": "2.3.0",
            "git_commit": "abc123",
            "git_dirty": False,
            "code_sha256": "a" * 64,
        }

    def client_factory(self, model: str, effort: str) -> ModelClient:
        self.factory_calls.append((model, effort))
        client = FakeModelClient()
        self.clients.append(client)
        return client

    def wiring_factory(self) -> TaxiAIWiring:
        return self.wiring if self.wiring is not None else default_taxi_wiring()

    def main(self, *args: str) -> int:
        deps = Dependencies(
            generate=self.generate,
            client_factory=self.client_factory,
            taxi_wiring=self.wiring_factory,
            fetch=self.fetch,
            archive=self.archive,
            out=self.lines.append,
            provenance=lambda: dict(self.versions),
        )
        return main(["--data-dir", str(self.data_dir), *args], deps)

    def run(self, *args: str) -> int:
        return self.main(
            "run",
            "--query-timeout",
            "0.3",
            "--taxi-questions",
            str(self.taxi_questions),
            "--duckdb-path",
            str(self.taxi_db),
            *args,
        )

    def run_dir(self, run_id: str) -> Path:
        return self.data_dir / "eval-results" / run_id


@pytest.fixture
def h(tmp_path: Path) -> Harness:
    return Harness(tmp_path)


def test_dry_run_end_to_end(h: Harness) -> None:
    code = h.run("--dry-run", "--models", "claude-haiku-5-5,claude-opus-5-5", "--run-id", "dry")
    assert code == 0
    # The dry run used the fake model, never the real client factory.
    assert h.factory_calls == []
    assert len(h.generate.calls) == 8  # 4 scorable questions x 2 models

    run_dir = h.run_dir("dry")
    run = json.loads((run_dir / "run.json").read_text())
    assert run["dry_run"] is True
    assert run["models"] == ["claude-haiku-5-5", "claude-opus-5-5"]
    assert run["ids"]["bird"] == ["1", "2", "3", "4", "5", "6"]
    assert run["ids"]["taxi"] == []
    assert run["bird_archive_sha256"] == h.archive.sha256
    assert "--dry-run" in run["fresh_command"] and "--run-id dry" in run["resume_command"]

    records = [json.loads(line) for line in (run_dir / "results.jsonl").read_text().splitlines()]
    assert len(records) == 12
    summary = json.loads((run_dir / "summary.json").read_text())
    bird = summary["suites"]["bird"]["models"]["claude-haiku-5-5"]
    assert bird["tokens"]["input"] == 0  # the fake model reports no tokens: nothing spent
    assert bird["cost_usd_list_prices"] == 0.0
    assert summary["suites"]["taxi"] == {"status": "not_measured", "message": NOT_MEASURED}

    report = (run_dir / "report.md").read_text()
    assert "DRY RUN" in report
    assert NOT_MEASURED in report
    assert "1 2 3 4 5 6" in report
    assert any("cost computed from list prices" in line for line in h.lines)
    assert any(line.startswith("report: ") for line in h.lines)


def test_dry_run_uses_the_dry_run_client(h: Harness) -> None:
    seen: list[ModelClient] = []
    original = h.generate.__call__

    async def spy(**kwargs: Any) -> Any:
        seen.append(kwargs["client"]._inner)
        return await original(**kwargs)

    h.generate = spy  # type: ignore[assignment]
    assert h.run("--dry-run", "--suite", "bird", "--limit", "2") == 0
    assert seen and all(isinstance(client, DryRunModelClient) for client in seen)


def test_resume_skips_finished_and_refuses_a_different_setup(h: Harness) -> None:
    assert h.run("--dry-run", "--run-id", "r1") == 0
    first_calls = len(h.generate.calls)
    assert h.run("--dry-run", "--run-id", "r1") == 0
    assert len(h.generate.calls) == first_calls  # everything was already finished

    assert h.run("--dry-run", "--run-id", "r1", "--max-repairs", "1") == 1
    assert h.run("--dry-run", "--run-id", "r1", "--models", "claude-opus-5-5") == 1
    assert len(h.generate.calls) == first_calls


def test_failed_questions_exit_nonzero_and_resume_retries_them(h: Harness) -> None:
    h.generate.raise_on = {QUESTIONS[1][0]}
    assert h.run("--dry-run", "--suite", "bird", "--run-id", "f") == 1
    assert any("resume with:" in line for line in h.lines)
    h.generate.raise_on = set()
    h.generate.calls.clear()
    assert h.run("--dry-run", "--suite", "bird", "--run-id", "f") == 0
    assert h.generate.calls == [QUESTIONS[1][0]]


def test_a_paid_run_needs_allow_spend(h: Harness, capsys: pytest.CaptureFixture[str]) -> None:
    assert h.run("--suite", "bird") == 1
    assert "--allow-spend" in capsys.readouterr().err
    assert h.fetch.calls == [] and h.factory_calls == [] and h.generate.calls == []


def test_a_paid_run_builds_one_client_per_model_with_the_effort(h: Harness) -> None:
    code = h.run(
        "--suite", "bird", "--allow-spend", "--effort", "high",
        "--models", "claude-haiku-5-5,claude-sonnet-5-5", "--limit", "4", "--run-id", "paid",
    )  # fmt: skip
    assert code == 0
    assert h.factory_calls == [("claude-haiku-5-5", "high"), ("claude-sonnet-5-5", "high")]
    run = json.loads((h.run_dir("paid") / "run.json").read_text())
    assert run["effort"] == "high" and run["limit"] == 4
    assert len(run["ids"]["bird"]) == 4
    report = (h.run_dir("paid") / "report.md").read_text()
    assert "effort: high" in report and "a stratified pilot of 4" in report
    totals = [line for line in h.lines if line.startswith("bird claude-")]
    assert len(totals) == 2 and all("tokens in" in line for line in totals)


def test_limit_selects_a_stratified_pilot(h: Harness) -> None:
    assert h.run("--dry-run", "--suite", "bird", "--limit", "3", "--run-id", "p") == 0
    run = json.loads((h.run_dir("p") / "run.json").read_text())
    # 6 questions: 2 simple, 2 moderate, 2 challenging -> one of each.
    picked = {QUESTIONS[int(i)][2] for i in run["ids"]["bird"]}
    assert picked == {"simple", "moderate", "challenging"}


def write_taxi_questions(path: Path) -> None:
    path.write_text(
        path.read_text()
        + """
[[questions]]
id = "card-trips"
question = "How many trips were paid by card?"
gold_sql = "SELECT count(*) FROM trips WHERE payment_type = 1"
difficulty = "simple"

[[questions]]
id = "zones-per-borough"
question = "How many zones does each borough have?"
gold_sql = "SELECT borough, count(*) FROM zones GROUP BY borough"
difficulty = "moderate"
"""
    )


def test_taxi_suite_runs_with_the_ai_wiring(h: Harness) -> None:
    write_taxi_questions(h.taxi_questions)
    h.wiring = FakeTaxiWiring()
    h.generate.answers["How many trips were paid by card?"] = [
        "SELECT count(*) FROM trips WHERE payment_type = 1"
    ]
    assert h.run("--dry-run", "--suite", "taxi", "--run-id", "t") == 0
    summary = json.loads((h.run_dir("t") / "summary.json").read_text())
    taxi = summary["suites"]["taxi"]
    assert taxi["status"] == "measured"
    assert taxi["ids"] == ["card-trips", "zones-per-borough"]  # the examples are never scored
    stats = taxi["models"]["claude-haiku-5-5"]
    assert stats["scored"] == 2
    assert stats["accuracy"]["with_repair"]["successes"] == 1


def test_taxi_suite_without_the_ai_wiring_stops_before_any_model_call(
    h: Harness, capsys: pytest.CaptureFixture[str]
) -> None:
    write_taxi_questions(h.taxi_questions)
    assert h.run("--dry-run", "--run-id", "w") == 1
    assert "notebook_api.ai.context" in capsys.readouterr().err
    assert h.generate.calls == []
    assert not h.run_dir("w").exists()


def test_bad_taxi_gold_sql_stops_the_run(h: Harness, capsys: pytest.CaptureFixture[str]) -> None:
    h.taxi_questions.write_text(
        h.taxi_questions.read_text().replace("FROM trips\nWHERE payment_type", "FROM nope\nWHERE x")
    )
    write_taxi_questions(h.taxi_questions)
    h.wiring = FakeTaxiWiring()
    assert h.run("--dry-run", "--run-id", "g") == 1
    assert "example-average-tip-share" in capsys.readouterr().err
    assert h.generate.calls == []


def test_check_taxi_command(h: Harness) -> None:
    code = h.main(
        "check-taxi", "--taxi-questions", str(h.taxi_questions), "--duckdb-path", str(h.taxi_db)
    )
    assert code == 0
    assert "0 scored question(s), 2 example(s)" in h.lines[0]
    assert h.lines[1] == NOT_MEASURED


def test_download_command_reports_real_sizes(h: Harness) -> None:
    assert h.main("download") == 0
    archive = h.data_dir / "bird" / "dev.zip"
    assert f"{archive.stat().st_size:,} bytes" in h.lines[0]
    assert h.archive.sha256 in h.lines[0]
    assert "questions: 6" in h.lines[2]


def test_download_refuses_a_tampered_archive(
    h: Harness, capsys: pytest.CaptureFixture[str]
) -> None:
    h.fetch.content += b"x"
    assert h.main("download") == 1
    assert "expected sha256" in capsys.readouterr().err


@pytest.mark.parametrize("run_id", ["../escape", "a/b", "..", "-x"])
def test_run_ids_cannot_escape_the_results_directory(h: Harness, run_id: str) -> None:
    with pytest.raises(SystemExit):
        h.run("--dry-run", "--run-id", run_id)


def test_run_json_records_code_version_and_output_cap(h: Harness) -> None:
    assert (
        h.run("--dry-run", "--suite", "bird", "--max-output-tokens", "4000", "--run-id", "v") == 0
    )
    run = json.loads((h.run_dir("v") / "run.json").read_text())
    assert run["max_output_tokens"] == 4000
    assert "--max-output-tokens 4000" in run["fresh_command"]
    assert {k: run[k] for k in h.versions} == h.versions
    assert set(h.generate.output_caps) == {4000}
    assert "commit abc123" in (h.run_dir("v") / "report.md").read_text()


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("code_sha256", "b" * 64),
        ("git_commit", "def456"),
        ("git_dirty", True),
        ("sdk_version", "2.4.0"),
    ],
)
def test_resume_refuses_a_different_code_version(
    h: Harness, key: str, value: object, capsys: pytest.CaptureFixture[str]
) -> None:
    assert h.run("--dry-run", "--suite", "bird", "--run-id", "c") == 0
    calls = len(h.generate.calls)
    h.versions[key] = value
    assert h.run("--dry-run", "--suite", "bird", "--run-id", "c") == 1
    assert key in capsys.readouterr().err
    assert len(h.generate.calls) == calls


def test_ids_from_reuses_an_exact_question_list(h: Harness) -> None:
    assert h.run("--dry-run", "--suite", "bird", "--limit", "3", "--run-id", "pilot") == 0
    pilot = json.loads((h.run_dir("pilot") / "run.json").read_text())
    source = str(h.run_dir("pilot") / "run.json")
    assert h.run("--dry-run", "--suite", "bird", "--ids-from", source, "--run-id", "again") == 0
    again = json.loads((h.run_dir("again") / "run.json").read_text())
    assert again["ids"]["bird"] == pilot["ids"]["bird"]
    assert again["ids_from"] == source
    assert "--ids-from" in again["fresh_command"] and "--size" not in again["fresh_command"]


def test_ids_from_is_validated(h: Harness, capsys: pytest.CaptureFixture[str]) -> None:
    bad = h.tmp_path / "bad.json"
    bad.write_text(json.dumps({"ids": {"bird": ["1", "999"]}}))
    assert h.run("--dry-run", "--suite", "bird", "--ids-from", str(bad)) == 1
    assert "999" in capsys.readouterr().err
    other = h.tmp_path / "other.json"
    other.write_text(json.dumps({"ids": {"bird": ["1"]}, "bird_archive_sha256": "0" * 64}))
    assert h.run("--dry-run", "--suite", "bird", "--ids-from", str(other)) == 1
    assert "different BIRD archive" in capsys.readouterr().err
    assert h.run("--dry-run", "--ids-from", str(other), "--limit", "2") == 1
    assert "--limit" in capsys.readouterr().err
    assert h.run("--dry-run", "--ids-from", str(h.tmp_path / "missing.json")) == 1
    assert h.generate.calls == []


def test_effort_defaults_to_ai_effort(h: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_EFFORT", "low")
    assert h.run("--suite", "bird", "--allow-spend", "--limit", "2", "--run-id", "e") == 0
    assert {effort for _, effort in h.factory_calls} == {"low"}
    assert json.loads((h.run_dir("e") / "run.json").read_text())["effort"] == "low"


def test_a_bad_ai_effort_is_refused_before_anything_runs(
    h: Harness, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("AI_EFFORT", "extreme")
    assert h.run("--dry-run", "--suite", "bird") == 1
    assert "effort must be one of" in capsys.readouterr().err
    assert h.fetch.calls == []


def test_check_gold_times_every_gold_query_and_saves_them(h: Harness) -> None:
    out = h.tmp_path / "gold-check.json"
    assert h.main("check-gold", "--timeout", "0.3", "--out", str(out)) == 0
    report = json.loads(out.read_text())
    assert report["questions"] == 6 and report["timeout_seconds"] == 0.3
    assert report["statuses"] == {"ok": 4, "error": 1, "timeout": 1}
    by_id = {r["id"]: r for r in report["results"]}
    assert by_id["6"]["status"] == "timeout" and by_id["6"]["duration_ms"] >= 300
    assert by_id["3"]["row_count"] == 4
    assert any(line.startswith("6 gold queries, run one at a time") for line in h.lines)
    assert any(line.startswith("slowest: 6 ") for line in h.lines)
