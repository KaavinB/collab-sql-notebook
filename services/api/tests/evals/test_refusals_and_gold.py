"""Refusals, service failures, cut-off answers, the output cap and the gold cache."""

import asyncio
import datetime as dt
import json
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from notebook_api.evals.bird import BirdDataset, ensure_dev_set
from notebook_api.evals.bird_target import BirdTarget
from notebook_api.evals.execution import ExecOutcome
from notebook_api.evals.report import render_markdown
from notebook_api.evals.rowcodec import decode_rows, encode_rows, normalize_rows
from notebook_api.evals.runner import load_records
from notebook_api.evals.taxi import NOT_MEASURED
from tests.evals.helpers import (
    QUESTIONS,
    FakeFetch,
    FakeModelClient,
    ScriptedGenerate,
    archive_for,
    build_dev_zip,
)
from tests.evals.test_runner import ANSWERS, HAIKU, CountingTarget, run, summary_for

LONDON = QUESTIONS[1][0]
LONDON_SQL = ANSWERS[LONDON][0]


@pytest.fixture
def dataset(tmp_path: Path) -> BirdDataset:
    content = build_dev_zip(tmp_path)
    return ensure_dev_set(tmp_path / "bird", archive_for(content), FakeFetch(content))


def record_for(results: Path, qid: str) -> dict[str, Any]:
    [record] = [r for r in load_records(results) if r["id"] == qid and r["status"] == "done"]
    return record


def test_a_refusal_reply_is_an_answer_and_a_repair_can_follow(
    dataset: BirdDataset, tmp_path: Path
) -> None:
    results = tmp_path / "results.jsonl"
    answers = {**ANSWERS, LONDON: [LONDON_SQL, LONDON_SQL]}
    client = FakeModelClient(refuse_on="Ada", script={"London": ["refusal"]})
    progress = run(dataset, results, ScriptedGenerate(answers), clients={HAIKU: client})
    assert progress.failed == 0

    london = record_for(results, "1")
    assert london["first"]["refused"] is True and london["first"]["correct"] is False
    assert london["final"]["refused"] is False and london["final"]["correct"] is True

    s = summary_for(results)
    assert s["scored"] == 4  # refusals stay in n
    # Question 1's first answer and both of question 4's answers were refusals.
    assert s["refusals"] == {"without_repair": 2, "with_repair": 1, "questions_with_any": 2}
    assert s["accuracy"]["without_repair"]["successes"] == 1  # only question 3
    assert s["accuracy"]["with_repair"]["successes"] == 3


def test_the_pipeline_raising_after_a_refusal_scores_the_refusal(
    dataset: BirdDataset, tmp_path: Path
) -> None:
    results = tmp_path / "results.jsonl"
    generate = ScriptedGenerate(ANSWERS, raise_after_refusal={LONDON})
    client = FakeModelClient(refuse_on="London")
    progress = run(dataset, results, generate, clients={HAIKU: client})
    assert progress.failed == 0

    london = record_for(results, "1")
    assert london["status"] == "done" and london["refused"] is True
    assert london["pipeline_error"].startswith("RuntimeError")
    assert london["first"]["sql"] is None and london["first"]["correct"] is False
    assert london["final"]["refused"] is True and london["final"]["correct"] is False
    s = summary_for(results)
    assert s["scored"] == 4 and s["failed_ids"] == []
    assert s["refusals"]["questions_with_any"] == 1


def test_a_service_failure_is_unfinished_left_out_of_n_and_retried(
    dataset: BirdDataset, tmp_path: Path
) -> None:
    results = tmp_path / "results.jsonl"
    progress = run(dataset, results, ScriptedGenerate(ANSWERS, raise_on={LONDON}))
    assert progress.failed == 1
    [failed] = [r for r in load_records(results) if r["status"] == "failed"]
    assert failed["error_kind"] == "service"
    assert failed["error"].startswith("AssistantUnavailableError")

    s = summary_for(results)
    assert s["scored"] == 3  # not counted as wrong: it has no answer yet
    assert s["accuracy"]["with_repair"]["n"] == 3
    assert s["failed_ids"] == ["1"] and s["failed_service"] == 1 and s["incomplete"] == 1
    assert s["tokens"]["replies"] == 5  # the failed call's reply still cost tokens

    report = render_markdown(_summary_doc(s))
    assert "**Partial results.**" in report
    assert "| Execution accuracy, with repair (partial: unfinished questions) |" in report
    assert "1 question(s) failed before an answer** (1 service failure(s)" in report

    again = ScriptedGenerate(ANSWERS)
    assert run(dataset, results, again).failed == 0
    assert again.calls == [LONDON]
    assert summary_for(results)["scored"] == 4


def test_a_bug_in_the_pipeline_is_unfinished_too_but_labelled_unexpected(
    dataset: BirdDataset, tmp_path: Path
) -> None:
    async def broken(**kwargs: Any) -> Any:
        raise KeyError("oops")

    results = tmp_path / "results.jsonl"
    run(dataset, results, broken)  # type: ignore[arg-type]
    failed = [r for r in load_records(results) if r["status"] == "failed"]
    assert len(failed) == 4 and {r["error_kind"] for r in failed} == {"unexpected"}
    assert summary_for(results)["scored"] == 0


def test_cut_off_answers_are_counted_per_model(dataset: BirdDataset, tmp_path: Path) -> None:
    results = tmp_path / "results.jsonl"
    client = FakeModelClient(refuse_on="Ada", script={"cities": ["max_tokens"]})
    run(dataset, results, ScriptedGenerate(ANSWERS), clients={HAIKU: client})
    cities = record_for(results, "2")
    assert cities["first"]["cut_off"] is True and cities["first"]["sql"] is None
    assert cities["final"]["cut_off"] is False and cities["final"]["correct"] is True
    assert summary_for(results)["cut_off"] == {"without_repair": 1, "with_repair": 0}


def test_output_cap_is_passed_only_when_it_differs_from_the_default(
    dataset: BirdDataset, tmp_path: Path
) -> None:
    default = ScriptedGenerate(ANSWERS)
    run(dataset, tmp_path / "a.jsonl", default)
    assert set(default.output_caps) == {None}
    custom = ScriptedGenerate(ANSWERS)
    run(dataset, tmp_path / "b.jsonl", custom, max_output_tokens=4000)
    assert set(custom.output_caps) == {4000}


def test_gold_runs_once_per_run_and_is_reused_on_resume(
    dataset: BirdDataset, tmp_path: Path
) -> None:
    results = tmp_path / "results.jsonl"
    run(dataset, results, ScriptedGenerate(ANSWERS, raise_on={LONDON}))
    gold_lines = (tmp_path / "gold.jsonl").read_text().splitlines()
    assert len(gold_lines) == 6
    cached = {json.loads(line)["id"]: json.loads(line) for line in gold_lines}
    assert cached["3"]["rows"] is not None and cached["5"]["rows"] is None

    # The resume scores against the cached gold results: no gold query runs again.
    target = CountingTarget(BirdTarget(dataset, timeout_seconds=0.3, row_cap=1000))
    run(dataset, results, ScriptedGenerate(ANSWERS), target=target)
    assert QUESTIONS[2][1] not in target.executed
    assert target.executed == [LONDON_SQL]  # only the retried question's prediction
    assert summary_for(results)["accuracy"]["with_repair"]["successes"] == 3


class OneAtATime(CountingTarget):
    def __init__(self, inner: Any) -> None:
        super().__init__(inner)
        self.running = 0
        self.most = 0

    async def execute(self, database: str, sql: str) -> ExecOutcome:
        self.running += 1
        self.most = max(self.most, self.running)
        await asyncio.sleep(0.01)
        try:
            return await super().execute(database, sql)
        finally:
            self.running -= 1


def test_gold_queries_run_one_at_a_time(dataset: BirdDataset, tmp_path: Path) -> None:
    target = OneAtATime(BirdTarget(dataset, timeout_seconds=0.3, row_cap=1000))

    async def no_answers(**kwargs: Any) -> Any:
        raise KeyError("stop after the gold phase")

    run(dataset, tmp_path / "results.jsonl", no_answers, target=target)  # type: ignore[arg-type]
    assert len(target.executed) == len(QUESTIONS)
    assert target.most == 1


def test_row_codec_round_trips_every_kind_of_value() -> None:
    rows = frozenset(
        {
            (1, 1.5, "a", None, b"\x00\xff", True),
            (Decimal("12.50"), dt.datetime(2024, 1, 5, 10, 0), dt.date(2024, 1, 5)),
            (dt.time(9, 30), dt.timedelta(days=1, seconds=5, microseconds=7)),
            (uuid.UUID(int=5), ("nested", (1, 2)), 2**70),
        }
    )
    assert decode_rows(encode_rows(rows)) == rows
    # Kinds survive, so equality behaves like the original values: 1 == 1.0 still.
    assert normalize_rows(frozenset({(1,)})) == frozenset({(1.0,)})
    [[kind]] = [[type(v) for v in row] for row in normalize_rows(frozenset({(1,)}))]
    assert kind is int


def test_unknown_value_kinds_become_their_repr_on_both_sides() -> None:
    class Odd:
        def __repr__(self) -> str:
            return "Odd()"

    assert normalize_rows(frozenset({(Odd(),)})) == frozenset({("Odd()",)})


def _summary_doc(stats: dict[str, Any]) -> dict[str, Any]:
    return {
        "run": {
            "run_id": "r",
            "created_at": "2026-11-13T00:00:00+00:00",
            "dry_run": False,
            "models": [HAIKU],
            "effort": "medium",
            "sdk_version": "2.3.0",
            "git_commit": "abc",
            "git_dirty": True,
            "code_sha256": "0" * 64,
            "max_repairs": 2,
            "max_output_tokens": 8000,
            "concurrency": 3,
            "query_timeout_seconds": 0.3,
            "row_cap": 1000,
            "suites": ["bird"],
            "resume_command": "x",
            "fresh_command": "y",
        },
        "generated_at": "2026-11-13T00:01:00+00:00",
        "suites": {
            "bird": {
                "status": "measured",
                "selected": 6,
                "selection": "s.",
                "ids": [str(q) for q in QUESTIONS],
                "models": {HAIKU: stats},
            },
            "taxi": {"status": "not_measured", "message": NOT_MEASURED},
        },
    }
