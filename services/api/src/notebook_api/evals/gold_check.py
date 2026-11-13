"""`check-gold`: time every BIRD dev gold query, one at a time, and save the results.

This is the measurement behind the default per-query timeout: it shows how
long each gold query takes on this machine with nothing else running, and
which ones fail or don't finish. Rerun it after changing the timeout or the
machine; the JSON file it writes keeps every query's status and duration.
"""

import json
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from notebook_api.evals.bird import BirdDataset
from notebook_api.evals.sqlite_db import execute_query


def check_gold(
    dataset: BirdDataset,
    *,
    timeout_seconds: float,
    row_cap: int,
    out_path: Path,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    questions = dataset.questions()
    results: list[dict[str, Any]] = []
    for index, question in enumerate(questions, start=1):
        outcome = execute_query(
            dataset.database_path(question.db_id),
            question.gold_sql,
            timeout_seconds=timeout_seconds,
            row_cap=row_cap,
        )
        results.append(
            {
                "id": str(question.question_id),
                "database": question.db_id,
                "difficulty": question.difficulty,
                **outcome.to_json(),
            }
        )
        if progress is not None and outcome.status != "ok":
            progress(f"[{index}/{len(questions)}] {question.question_id}: {outcome.status}")
    report = {
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "archive_sha256": dataset.archive_sha256,
        "timeout_seconds": timeout_seconds,
        "row_cap": row_cap,
        "questions": len(results),
        "statuses": dict(Counter(r["status"] for r in results)),
        "results": results,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2) + "\n")
    return report


def describe(report: dict[str, Any], thresholds: tuple[float, ...] = (30.0, 60.0)) -> list[str]:
    """Plain-text lines: statuses, how many ok queries ran past each threshold, the slowest."""
    results = report["results"]
    ok = [r for r in results if r["status"] == "ok"]
    lines = [
        f"{report['questions']} gold queries, run one at a time with a "
        f"{report['timeout_seconds']:g} s timeout: "
        + ", ".join(f"{status} {count}" for status, count in sorted(report["statuses"].items()))
    ]
    for threshold in thresholds:
        over = sum(1 for r in ok if r["duration_ms"] > threshold * 1000)
        lines.append(f"succeeded but took over {threshold:g} s: {over}")
    slowest = sorted(results, key=lambda r: r["duration_ms"], reverse=True)[:10]
    lines.append(
        "slowest: "
        + ", ".join(f"{r['id']} {r['duration_ms'] / 1000:.1f} s ({r['status']})" for r in slowest)
    )
    return lines
