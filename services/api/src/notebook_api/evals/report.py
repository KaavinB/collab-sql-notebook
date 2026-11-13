"""Summaries and the markdown report, computed only from the results file.

Nothing here estimates: every count comes from records the runner wrote,
every rate is a count over a stated n, and each rate carries its 95%
Wilson interval. The dollar figure is computed from list prices (see
pricing.py) and labelled that way.
"""

from collections import Counter
from collections.abc import Iterable
from typing import Any

from notebook_api.evals.bird import DIFFICULTIES
from notebook_api.evals.pricing import (
    PRICE_TABLE,
    PRICES_COPIED_ON,
    PRICES_SOURCE,
    is_long_prompt,
    request_cost,
)
from notebook_api.evals.runner import latest_records
from notebook_api.evals.scoring import Proportion, proportion

_FAILURE_KINDS = ("no_sql", "error", "timeout", "too_many_rows")


def summarize_suite(
    records: list[dict[str, Any]], *, suite: str, model: str, selected_ids: list[str]
) -> dict[str, Any]:
    """Scores for one model on one suite, from every record in the results file."""
    wanted = set(selected_ids)
    mine = [
        r
        for r in records
        if r.get("suite") == suite and r.get("model") == model and r.get("id") in wanted
    ]
    latest = latest_records(mine)
    done = [r for r in latest.values() if r["status"] == "done"]
    failed_records = [r for r in latest.values() if r["status"] == "failed"]
    failed = sorted((str(r["id"]) for r in failed_records), key=_id_sort_key)
    excluded = [r for r in done if r.get("gold_excluded")]
    scored = [r for r in done if not r.get("gold_excluded")]

    by_difficulty: dict[str, dict[str, Any]] = {}
    for difficulty in _ordered_difficulties(r.get("difficulty") for r in scored):
        group = [r for r in scored if r.get("difficulty") == difficulty]
        by_difficulty[difficulty] = {
            "without_repair": _rate(group, "first", "correct").to_json(),
            "with_repair": _rate(group, "final", "correct").to_json(),
        }

    input_tokens = output_tokens = replies = long_prompts = 0
    cost: float | None = 0.0
    for record in mine:  # every reply ever recorded is real spend, retries included
        for reply in record.get("replies", []):
            tokens_in = int(reply.get("input_tokens", 0))
            tokens_out = int(reply.get("output_tokens", 0))
            input_tokens += tokens_in
            output_tokens += tokens_out
            replies += 1
            long_prompts += is_long_prompt(model, tokens_in)
            one = request_cost(model, tokens_in, tokens_out)
            cost = None if one is None or cost is None else cost + one

    return {
        "selected": len(wanted),
        "done": len(done),
        "incomplete": len(wanted) - len(done),
        "failed_ids": failed,
        "failed_service": sum(1 for r in failed_records if r.get("error_kind") == "service"),
        "gold_excluded": [
            {"id": r["id"], "status": r["gold"]["status"], "error": r["gold"].get("error")}
            for r in sorted(excluded, key=lambda r: _id_sort_key(str(r["id"])))
        ],
        "scored": len(scored),
        "accuracy": {
            "without_repair": _rate(scored, "first", "correct").to_json(),
            "with_repair": _rate(scored, "final", "correct").to_json(),
        },
        "valid_sql": {
            "without_repair": _rate(scored, "first", "valid").to_json(),
            "with_repair": _rate(scored, "final", "valid").to_json(),
        },
        "by_difficulty": by_difficulty,
        "repair": {
            "changed_sql": sum(1 for r in scored if r.get("repair_changed_sql")),
            "fixed": sum(1 for r in scored if r["final"]["correct"] and not r["first"]["correct"]),
            "broke": sum(1 for r in scored if r["first"]["correct"] and not r["final"]["correct"]),
            "questions_with_repair_calls": sum(1 for r in scored if len(r.get("attempts", [])) > 1),
        },
        "refusals": {
            "without_repair": sum(1 for r in scored if r["first"].get("refused")),
            "with_repair": sum(1 for r in scored if r["final"].get("refused")),
            "questions_with_any": sum(1 for r in scored if r.get("refused")),
        },
        "cut_off": {
            "without_repair": sum(1 for r in scored if r["first"].get("cut_off")),
            "with_repair": sum(1 for r in scored if r["final"].get("cut_off")),
        },
        "prediction_failures": {
            "without_repair": _failures(scored, "first"),
            "with_repair": _failures(scored, "final"),
        },
        "tokens": {
            "input": input_tokens,
            "output": output_tokens,
            "replies": replies,
            "prompts_over_long_context_threshold": long_prompts,
        },
        "cost_usd_list_prices": round(cost, 6) if cost is not None else None,
    }


def _rate(records: list[dict[str, Any]], which: str, field: str) -> Proportion:
    return proportion(sum(1 for r in records if r[which][field]), len(records))


def _failures(records: list[dict[str, Any]], which: str) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for record in records:
        side = record[which]
        if side["sql"] is None:
            counts["no_sql"] += 1
        elif side["exec"] is not None and side["exec"]["status"] != "ok":
            counts[side["exec"]["status"]] += 1
    return {kind: counts.get(kind, 0) for kind in _FAILURE_KINDS}


def _ordered_difficulties(values: Iterable[Any]) -> list[str]:
    present = {str(v) for v in values if v is not None}
    return [d for d in DIFFICULTIES if d in present] + sorted(present - set(DIFFICULTIES))


def _id_sort_key(value: str) -> tuple[int, int, str]:
    return (0, int(value), "") if value.isdigit() else (1, 0, value)


def _prop(data: dict[str, Any]) -> str:
    return Proportion(
        data["successes"], data["n"], data["wilson95_low"], data["wilson95_high"]
    ).describe()


def _money(value: float | None) -> str:
    return "not computed (model not in the price table)" if value is None else f"${value:.4f}"


def render_markdown(summary: dict[str, Any]) -> str:
    run = summary["run"]
    lines: list[str] = [f"# Text-to-SQL evaluation: {run['run_id']}", ""]
    if run["dry_run"]:
        lines += [
            "> **DRY RUN.** A fake model answered; no API was called. The numbers below "
            "exercise the harness and measure nothing about any model.",
            "",
        ]
    lines += [
        f"- Run started (UTC): {run['created_at']}; this report written (UTC): "
        f"{summary['generated_at']}",
        f"- Models: {', '.join(run['models'])} (effort: {run['effort']}; server-side "
        "fallbacks off, so each model is measured alone)",
        f"- anthropic SDK: {run['sdk_version']}; code: commit {run['git_commit']}"
        f"{' with uncommitted changes' if run['git_dirty'] else ''} "
        f"(source hash {str(run['code_sha256'])[:12]})",
        f"- Repair loop: up to {run['max_repairs']} repairs after the first attempt; "
        f"output cap {run['max_output_tokens']:,} tokens per model call (thinking included)",
        f"- Concurrency: {run['concurrency']}; per-query timeout {run['query_timeout_seconds']:g} "
        f"s; row cap {run['row_cap']:,}",
        f"- Suites: {', '.join(run['suites'])}",
        "",
        "Rerun:",
        "",
        f"- Resume this run (skips finished questions): `{run['resume_command']}`",
        f"- Same questions, fresh run: `{run['fresh_command']}`",
        "- Exactly this run's question IDs in a new run, whatever the code version: pass "
        "`--ids-from` with this run's run.json instead of `--size`/`--seed`/`--limit`.",
        "",
        "Model answers vary from run to run, so a fresh run asks the identical questions "
        "but its scores can differ.",
        "",
    ]
    for suite_name, suite in summary["suites"].items():
        lines += _render_suite(suite_name, suite, run)
    lines += _render_method(run)
    return "\n".join(lines).rstrip() + "\n"


def _render_suite(name: str, suite: dict[str, Any], run: dict[str, Any]) -> list[str]:
    title = "BIRD dev subset" if name == "bird" else "Taxi questions"
    lines = [f"## {title}", ""]
    if suite["status"] != "measured":
        return [*lines, suite["message"], ""]
    lines += [f"Questions selected: {suite['selected']}. {suite['selection']}", ""]
    models = list(suite["models"])
    stats = suite["models"]
    unfinished = sum(stats[m]["incomplete"] for m in models)
    # Rates over a run that hasn't finished would read like final results.
    partial = " (partial: unfinished questions)" if unfinished else ""
    if unfinished:
        lines += [
            f"> **Partial results.** {unfinished} (model, question) pair(s) have no answer yet "
            "(see each model's details); every rate below leaves them out. Resume the run to "
            "finish it.",
            "",
        ]

    def row(label: str, cell: Any) -> str:
        return f"| {label} | " + " | ".join(cell(stats[m]) for m in models) + " |"

    lines += [
        "| | " + " | ".join(f"`{m}`" for m in models) + " |",
        "|---|" + "---|" * len(models),
        row(
            f"Execution accuracy, without repair{partial}",
            lambda s: _prop(s["accuracy"]["without_repair"]),
        ),
        row(
            f"Execution accuracy, with repair{partial}",
            lambda s: _prop(s["accuracy"]["with_repair"]),
        ),
        row("Valid SQL, without repair", lambda s: _prop(s["valid_sql"]["without_repair"])),
        row("Valid SQL, with repair", lambda s: _prop(s["valid_sql"]["with_repair"])),
        row(
            "Repair changed the SQL",
            lambda s: f"{s['repair']['changed_sql']} of {s['scored']}",
        ),
        row(
            "Repair fixed / broke an answer",
            lambda s: f"{s['repair']['fixed']} / {s['repair']['broke']}",
        ),
        row(
            "Refused answers, without / with repair (scored wrong)",
            lambda s: f"{s['refusals']['without_repair']} / {s['refusals']['with_repair']}",
        ),
        row("Questions with any refusal", lambda s: str(s["refusals"]["questions_with_any"])),
        row(
            "Answers cut off at the output cap, without / with repair",
            lambda s: f"{s['cut_off']['without_repair']} / {s['cut_off']['with_repair']}",
        ),
        row(
            "Scored / gold errors excluded", lambda s: f"{s['scored']} / {len(s['gold_excluded'])}"
        ),
        row("Not finished", lambda s: str(s["incomplete"])),
        row(
            "Tokens in / out (measured)",
            lambda s: f"{s['tokens']['input']:,} / {s['tokens']['output']:,}",
        ),
        row("Model calls", lambda s: str(s["tokens"]["replies"])),
        row("Cost, computed from list prices", lambda s: _money(s["cost_usd_list_prices"])),
        "",
    ]
    for model in models:
        lines += _render_model_detail(model, stats[model])
    lines += [
        "Question IDs in this suite (in order):",
        "",
        "```",
        " ".join(suite["ids"]),
        "```",
        "",
    ]
    return lines


def _render_model_detail(model: str, s: dict[str, Any]) -> list[str]:
    lines = [f"### `{model}`", "", "| Difficulty | Without repair | With repair |", "|---|---|---|"]
    for difficulty, data in s["by_difficulty"].items():
        lines.append(
            f"| {difficulty} | {_prop(data['without_repair'])} | {_prop(data['with_repair'])} |"
        )
    lines.append("")
    for which, label in (("without_repair", "without repair"), ("with_repair", "with repair")):
        f = s["prediction_failures"][which]
        lines.append(
            f"- Wrong because the prediction failed to run ({label}): no SQL {f['no_sql']}, "
            f"error {f['error']}, timeout {f['timeout']}, over the row cap {f['too_many_rows']}"
        )
    lines.append(
        f"- Questions where the repair loop made extra calls: "
        f"{s['repair']['questions_with_repair_calls']}"
    )
    if s["tokens"]["prompts_over_long_context_threshold"]:
        lines.append(
            f"- **{s['tokens']['prompts_over_long_context_threshold']} prompt(s) went over the "
            "model's long-prompt price threshold** and were priced at the higher rate."
        )
    if s["gold_excluded"]:
        excluded = ", ".join(f"{g['id']} ({g['status']}: {g['error']})" for g in s["gold_excluded"])
        lines.append(f"- Excluded because the gold SQL failed: {excluded}")
    if s["failed_ids"]:
        lines.append(
            f"- **Not finished: {len(s['failed_ids'])} question(s) failed before an answer** "
            f"({s['failed_service']} service failure(s), the rest unexpected errors); they are "
            f"left out of every rate. Resume the run to retry: {', '.join(s['failed_ids'])}"
        )
    not_attempted = s["incomplete"] - len(s["failed_ids"])
    if not_attempted:
        lines.append(f"- **Not finished:** {not_attempted} question(s) not attempted yet.")
    lines.append("")
    return lines


def _render_method(run: dict[str, Any]) -> list[str]:
    prices = ", ".join(
        f"`{model}` ${p.base.input_per_mtok:g} / ${p.base.output_per_mtok:g}"
        + (
            f" (over {p.long_prompt_threshold:,} prompt tokens: "
            f"${p.long.input_per_mtok:g} / ${p.long.output_per_mtok:g})"
            if p.long is not None and p.long_prompt_threshold is not None
            else ""
        )
        for model, p in PRICE_TABLE.items()
    )
    return [
        "## How this was measured",
        "",
        "- **Execution accuracy** is scored as BIRD scores it: the gold SQL and the model's "
        "SQL run on the same database, and the answer is correct if the two results are equal "
        "as sets of rows (row order, duplicates and column names ignored). SQL that errors, "
        "times out or returns more rows than the cap is wrong. A refusal is wrong.",
        "- **Without repair** scores the model's first attempt; **with repair** scores the final "
        "SQL after the validate-and-repair loop. Both come from the same run: the first attempt "
        "is the same call the pipeline makes with repairs turned off.",
        "- **Gold errors**: a question whose gold SQL fails (error, timeout, over the row cap) "
        "can't be scored. It's excluded from every rate, listed above, and the model is not "
        "asked it. Gold queries run one at a time before any model is asked, and their results "
        "are cached for the run, so every model (and every resume) is scored against the same "
        "gold result.",
        "- **Where this differs from BIRD's official script**: (1) BIRD counts a question "
        "whose gold SQL fails as wrong; here it's excluded and listed. (2) Text that isn't "
        "valid UTF-8 is read with the bad bytes replaced (the same way for gold and predicted "
        "results), where BIRD's script would fail on it. (3) BIRD stops queries after 30 s; "
        f"this run used {run['query_timeout_seconds']:g} s, and a {run['row_cap']:,}-row cap.",
        "- **Unfinished questions** (a service failure before any answer) are left out of "
        "every rate and listed; a refusal is an answer, scored wrong.",
        "- **Valid SQL**: the attempt parsed as one SELECT and passed EXPLAIN on the database.",
        "- **Intervals** are 95% Wilson score intervals, computed by the harness from the counts "
        "shown.",
        "- **Tokens** are the input and output token counts the API reported on every reply, "
        "summed (including replies to calls that later failed and were retried).",
        f"- **Cost** is computed from list prices, not billed cost: USD per million input / "
        f"output tokens {prices}; copied from {PRICES_SOURCE} on {PRICES_COPIED_ON}.",
        "",
    ]
