import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from notebook_api.ai.pipeline import ModelClient
from notebook_api.evals.bird import BirdDataset, ensure_dev_set
from notebook_api.evals.bird_target import BirdTarget, bird_eval_question
from notebook_api.evals.execution import ExecOutcome
from notebook_api.evals.report import render_markdown, summarize_suite
from notebook_api.evals.runner import (
    DEFAULT_MAX_OUTPUT_TOKENS,
    EvalQuestion,
    RunProgress,
    Target,
    latest_records,
    load_records,
    run_eval,
)
from notebook_api.evals.taxi import NOT_MEASURED
from tests.evals.helpers import (
    QUESTIONS,
    FakeFetch,
    FakeModelClient,
    ScriptedGenerate,
    archive_for,
    build_dev_zip,
)

HAIKU = "claude-haiku-5-5"
OPUS = "claude-opus-5-5"

ANSWERS = {
    # Right the first time.
    QUESTIONS[1][0]: ["SELECT name FROM customers WHERE city = 'London'"],
    # Invalid first (unknown column), repaired to the right answer.
    QUESTIONS[2][0]: ["SELECT citty FROM customers", "SELECT city FROM customers"],
    # Different order and duplicates removed: still the same set, so right.
    QUESTIONS[3][0]: ["SELECT DISTINCT amount FROM orders ORDER BY amount DESC"],
    # Question 4 is refused by the fake model (see refuse_on below).
    QUESTIONS[4][0]: ["SELECT 15.0"],
}


@pytest.fixture
def dataset(tmp_path: Path) -> BirdDataset:
    content = build_dev_zip(tmp_path)
    return ensure_dev_set(tmp_path / "bird", archive_for(content), FakeFetch(content))


def questions_of(dataset: BirdDataset) -> list[EvalQuestion]:
    return [bird_eval_question(q) for q in dataset.questions()]


class CountingTarget:
    def __init__(self, inner: Target) -> None:
        self.inner = inner
        self.executed: list[str] = []

    async def schema(self, database: str) -> Any:
        return await self.inner.schema(database)

    def validator(self, database: str) -> Any:
        return self.inner.validator(database)

    async def execute(self, database: str, sql: str) -> ExecOutcome:
        self.executed.append(sql)
        return await self.inner.execute(database, sql)


def run(
    dataset: BirdDataset,
    results: Path,
    generate: ScriptedGenerate,
    *,
    models: tuple[str, ...] = (HAIKU,),
    target: Target | None = None,
    clients: dict[str, ModelClient] | None = None,
    max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
) -> RunProgress:
    target = target or BirdTarget(dataset, timeout_seconds=0.3, row_cap=1000)
    clients = clients or {m: FakeModelClient(refuse_on="Ada") for m in models}
    return asyncio.run(
        run_eval(
            questions_of(dataset),
            models=list(models),
            targets={"bird": target},
            clients=clients,
            generate=generate,
            results_path=results,
            gold_path=results.with_name("gold.jsonl"),
            concurrency=3,
            max_repairs=2,
            max_output_tokens=max_output_tokens,
        )
    )


def summary_for(results: Path, model: str = HAIKU) -> dict[str, Any]:
    ids = [str(qid) for qid in QUESTIONS]
    return summarize_suite(load_records(results), suite="bird", model=model, selected_ids=ids)


def test_scores_with_and_without_repair_from_one_run(dataset: BirdDataset, tmp_path: Path) -> None:
    results = tmp_path / "results.jsonl"
    generate = ScriptedGenerate(ANSWERS)
    progress = run(dataset, results, generate)
    assert progress.total == 6 and progress.finished == 6 and progress.failed == 0

    s = summary_for(results)
    assert s["selected"] == 6 and s["done"] == 6 and s["incomplete"] == 0
    # Gold errors are excluded and counted separately; the model isn't asked them.
    assert [(g["id"], g["status"]) for g in s["gold_excluded"]] == [
        ("5", "error"),
        ("6", "timeout"),
    ]
    assert len(generate.calls) == 4
    assert s["scored"] == 4
    assert s["accuracy"]["without_repair"]["successes"] == 2  # questions 1 and 3
    assert s["accuracy"]["with_repair"]["successes"] == 3  # plus question 2, repaired
    assert s["accuracy"]["with_repair"]["n"] == 4
    assert s["accuracy"]["with_repair"]["wilson95_low"] is not None
    assert s["valid_sql"]["without_repair"]["successes"] == 2
    assert s["valid_sql"]["with_repair"]["successes"] == 3
    assert s["repair"] == {
        "changed_sql": 1,
        "fixed": 1,
        "broke": 0,
        "questions_with_repair_calls": 1,
    }
    assert s["refusals"] == {"without_repair": 1, "with_repair": 1, "questions_with_any": 1}
    assert s["cut_off"] == {"without_repair": 0, "with_repair": 0}
    assert s["prediction_failures"]["without_repair"] == {
        "no_sql": 1,  # the refusal
        "error": 1,  # the unknown column
        "timeout": 0,
        "too_many_rows": 0,
    }
    # 5 replies: 1 + 2 + 1 at 1000 in / 50 out, and the refusal at 900 / 0.
    assert s["tokens"] == {
        "input": 4900,
        "output": 200,
        "replies": 5,
        "prompts_over_long_context_threshold": 0,
    }
    assert s["cost_usd_list_prices"] == pytest.approx((4900 * 0.10 + 200 * 0.50) / 1e6)
    assert s["by_difficulty"]["simple"]["with_repair"]["successes"] == 2
    assert s["by_difficulty"]["moderate"]["without_repair"]["n"] == 2
    assert "challenging" not in s["by_difficulty"]  # both were excluded


def test_records_keep_both_answers_and_never_the_rows(dataset: BirdDataset, tmp_path: Path) -> None:
    results = tmp_path / "results.jsonl"
    run(dataset, results, ScriptedGenerate(ANSWERS))
    by_id = {r["id"]: r for r in load_records(results)}
    repaired = by_id["2"]
    assert repaired["first"]["sql"] == "SELECT citty FROM customers"
    assert repaired["first"]["valid"] is False and repaired["first"]["exec"]["status"] == "error"
    assert repaired["final"]["correct"] is True and repaired["repair_changed_sql"] is True
    assert [a["error"] is None for a in repaired["attempts"]] == [False, True]
    assert "rows" not in repaired["final"]["exec"]
    assert by_id["4"]["refused"] is True and by_id["4"]["final"]["sql"] is None


def test_resume_skips_finished_and_retries_failed(dataset: BirdDataset, tmp_path: Path) -> None:
    results = tmp_path / "results.jsonl"
    flaky = ScriptedGenerate(ANSWERS, raise_on={QUESTIONS[1][0]})
    progress = run(dataset, results, flaky)
    assert progress.failed == 1
    failed = [r for r in load_records(results) if r["status"] == "failed"]
    assert failed[0]["id"] == "1" and "AssistantUnavailableError" in failed[0]["error"]
    assert summary_for(results)["failed_ids"] == ["1"]

    again = ScriptedGenerate(ANSWERS)
    progress = run(dataset, results, again)
    assert again.calls == [QUESTIONS[1][0]]  # only the failed one
    assert progress.total == 1 and progress.failed == 0

    s = summary_for(results)
    assert s["done"] == 6 and s["failed_ids"] == []
    assert s["accuracy"]["with_repair"]["successes"] == 3
    # The failed call's reply was real spend, so it's counted too.
    assert s["tokens"]["replies"] == 6

    third = ScriptedGenerate(ANSWERS)
    assert run(dataset, results, third).total == 0
    assert third.calls == []


def test_a_line_cut_short_by_a_crash_is_skipped(dataset: BirdDataset, tmp_path: Path) -> None:
    results = tmp_path / "results.jsonl"
    results.write_text('{"status": "done", "model": "claude-haiku-5-5", "suite": "bird", "id"')
    run(dataset, results, ScriptedGenerate(ANSWERS))
    lines = results.read_text().splitlines()
    assert len(lines) == 7  # the broken line, then six whole ones on their own lines
    assert all(json.loads(line) for line in lines[1:])
    assert summary_for(results)["done"] == 6


def test_done_is_never_replaced_by_a_later_failure() -> None:
    done = {"status": "done", "model": "m", "suite": "bird", "id": "1"}
    failed = {"status": "failed", "model": "m", "suite": "bird", "id": "1"}
    assert latest_records([done, failed])[("m", "bird", "1")] is done
    assert latest_records([failed, done])[("m", "bird", "1")] is done


def test_every_model_answers_the_same_questions_and_gold_runs_once(
    dataset: BirdDataset, tmp_path: Path
) -> None:
    results = tmp_path / "results.jsonl"
    target = CountingTarget(BirdTarget(dataset, timeout_seconds=0.3, row_cap=1000))
    generate = ScriptedGenerate(ANSWERS)
    run(dataset, results, generate, models=(HAIKU, OPUS), target=target)
    assert len(generate.calls) == 8
    # Gold SQL that no prediction repeats ran exactly once, not once per model.
    for qid in (2, 4, 5, 6):
        assert target.executed.count(QUESTIONS[qid][1]) == 1
    for model in (HAIKU, OPUS):
        s = summary_for(results, model)
        assert s["accuracy"]["with_repair"]["successes"] == 3
    assert summary_for(results, OPUS)["cost_usd_list_prices"] == pytest.approx(
        (4900 * 4 + 200 * 20) / 1e6
    )


def test_unknown_models_get_tokens_but_no_dollar_figure(
    dataset: BirdDataset, tmp_path: Path
) -> None:
    results = tmp_path / "results.jsonl"
    run(dataset, results, ScriptedGenerate(ANSWERS), models=("claude-test-1",))
    s = summary_for(results, "claude-test-1")
    assert s["tokens"]["input"] == 4900
    assert s["cost_usd_list_prices"] is None


def test_report_has_n_intervals_ids_costs_and_rerun_commands(
    dataset: BirdDataset, tmp_path: Path
) -> None:
    results = tmp_path / "results.jsonl"
    run(dataset, results, ScriptedGenerate(ANSWERS), models=(HAIKU, OPUS))
    records = load_records(results)
    ids = [str(qid) for qid in QUESTIONS]
    summary: dict[str, Any] = {
        "run": {
            "run_id": "test-run",
            "created_at": "2026-11-13T00:00:00+00:00",
            "dry_run": False,
            "models": [HAIKU, OPUS],
            "effort": "medium",
            "sdk_version": "2.3.0",
            "git_commit": "abc123",
            "git_dirty": False,
            "code_sha256": "f" * 64,
            "max_repairs": 2,
            "max_output_tokens": 8000,
            "concurrency": 3,
            "query_timeout_seconds": 0.3,
            "row_cap": 1000,
            "suites": ["bird", "taxi"],
            "resume_command": "pnpm eval run --run-id test-run",
            "fresh_command": "pnpm eval run",
        },
        "generated_at": "2026-11-13T00:01:00+00:00",
        "suites": {
            "bird": {
                "status": "measured",
                "selected": 6,
                "selection": "Stratified.",
                "ids": ids,
                "models": {
                    m: summarize_suite(records, suite="bird", model=m, selected_ids=ids)
                    for m in (HAIKU, OPUS)
                },
            },
            "taxi": {"status": "not_measured", "message": NOT_MEASURED},
        },
    }
    report = render_markdown(summary)
    assert "DRY RUN" not in report
    assert "| | `claude-haiku-5-5` | `claude-opus-5-5` |" in report
    assert "| Execution accuracy, with repair | 75.0% (3/4; 95% CI " in report
    assert "| Execution accuracy, without repair | 50.0% (2/4; 95% CI " in report
    assert "| Repair fixed / broke an answer | 1 / 1 |" not in report
    assert "| Repair fixed / broke an answer | 1 / 0 | 1 / 0 |" in report
    assert "| Refused answers, without / with repair (scored wrong) | 1 / 1 | 1 / 1 |" in report
    assert "| Answers cut off at the output cap, without / with repair | 0 / 0 | 0 / 0 |" in report
    assert "(partial" not in report
    assert "Where this differs from BIRD's official script" in report
    assert "| Tokens in / out (measured) | 4,900 / 200 | 4,900 / 200 |" in report
    assert "Cost, computed from list prices | $0.0006 | $0.0236 |" in report
    assert "5 (error: " in report and "6 (timeout: " in report
    assert "1 2 3 4 5 6" in report
    assert "anthropic SDK: 2.3.0" in report
    assert "pnpm eval run --run-id test-run" in report
    assert NOT_MEASURED in report
    assert "not billed cost" in report

    summary["run"]["dry_run"] = True
    assert "DRY RUN" in render_markdown(summary)
