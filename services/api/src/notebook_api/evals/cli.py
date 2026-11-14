"""`python -m notebook_api.evals`: download BIRD, check gold and taxi questions, run the eval.

From the repo root:

    pnpm eval download                      # fetch + verify + extract BIRD dev
    pnpm eval check-gold                    # time every BIRD gold query (sets the timeout)
    pnpm eval check-taxi                    # validate services/api/evals/taxi_questions.toml
    pnpm eval run --dry-run --limit 5       # the whole pipeline with a fake model, no API
    pnpm eval run --limit 10 --models claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5 \
        --allow-spend                       # a measured pilot (calls the paid API)
    pnpm eval report --run-id <id>          # rebuild a run's report from its answers (free)

Results go to <data-dir>/eval-results/<run-id>/: run.json (the exact
configuration, code version and question IDs), gold.jsonl (the gold results
every model is scored against), results.jsonl (one line per finished model
and question), summary.json and report.md. Running again with the same
--run-id resumes: finished questions are skipped, and the summary and report
are rebuilt from everything recorded.
"""

import argparse
import asyncio
import hashlib
import inspect
import json
import os
import re
import shlex
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from notebook_api.ai import pipeline
from notebook_api.evals.bird import (
    DEV_ARCHIVE,
    Archive,
    BirdDataError,
    BirdQuestion,
    ChecksumMismatchError,
    Fetcher,
    UnsafeArchiveError,
    ensure_dev_set,
    httpx2_fetch,
)
from notebook_api.evals.bird_target import BirdTarget, bird_eval_question
from notebook_api.evals.clients import (
    DEFAULT_MODEL,
    EFFORTS,
    ClientFactory,
    EvalSetupError,
    anthropic_client_factory,
    dry_run_client_factory,
)
from notebook_api.evals.execution import ExecOutcome
from notebook_api.evals.gold_check import check_gold, describe
from notebook_api.evals.provenance import provenance
from notebook_api.evals.report import render_markdown, summarize_suite
from notebook_api.evals.runner import (
    DEFAULT_MAX_OUTPUT_TOKENS,
    EvalQuestion,
    GenerateFn,
    RunProgress,
    Target,
    load_records,
    run_eval,
)
from notebook_api.evals.subset import stratified_sample
from notebook_api.evals.taxi import (
    NOT_MEASURED,
    DuckDbExecutor,
    TaxiAIWiring,
    TaxiQuestion,
    TaxiQuestionsError,
    TaxiSetupError,
    TaxiTarget,
    check_gold_sql,
    default_taxi_wiring,
    load_taxi_file,
    load_taxi_questions,
    scored_questions,
)

# 200 of BIRD dev's 1534 questions: enough that a 95% interval on accuracy is
# at most about ±7 percentage points wide (the normal-approximation half-width
# at 50%, n=200, is 1.96·sqrt(0.25/200) ≈ 0.069; the report's Wilson interval
# is about as wide there), while keeping a three-model run
# small enough to approve as one budget. The size is a flag; the report
# shows n and the interval for whatever size is used.
DEFAULT_SUBSET_SIZE = 200
DEFAULT_SEED = 20261113
# Requests in flight at once, across all models. Not tuned: low enough to
# stay clear of API rate limits, high enough that a run takes minutes.
DEFAULT_CONCURRENCY = 4
# BIRD's own evaluation script stops queries after 30 s. Some gold queries
# take longer than that on a laptop: `pnpm eval check-gold` times every gold
# query (one at a time) and lists the slow ones and those that never finish.
# The default leaves room above BIRD's 30 s for those; gold queries run one
# at a time before any model is asked, so the limit isn't shared with other
# queries. The value used is recorded in every report.
DEFAULT_QUERY_TIMEOUT_SECONDS = 60.0
# check-gold's own limit: long enough to see how slow the slow ones really are.
DEFAULT_CHECK_GOLD_TIMEOUT_SECONDS = 120.0
# Rows fetched per query before it's called "too many rows". Some BIRD gold
# answers have hundreds of thousands of rows (check-gold shows each row
# count); this cap keeps them scorable.
DEFAULT_ROW_CAP = 1_000_000
DEFAULT_MAX_REPAIRS = 2

API_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_TAXI_QUESTIONS = API_ROOT / "evals" / "taxi_questions.toml"
_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_MODEL = re.compile(r"^[a-z0-9][a-z0-9.\-]{0,99}$")
SUITES = ("bird", "taxi")
_MAX_RUN_JSON_BYTES = 5 * 1024 * 1024

# Keys of run.json that must match for a resume to add to an existing run.
# The code and SDK versions are included so that answers from different
# versions never end up in one report.
_FINGERPRINT = (
    "dry_run",
    "models",
    "effort",
    "max_repairs",
    "max_output_tokens",
    "suites",
    "seed",
    "size",
    "limit",
    "ids_from",
    "query_timeout_seconds",
    "row_cap",
    "bird_archive_sha256",
    "taxi_questions_sha256",
    "taxi_schema_sha256",
    "taxi_query_limits",
    "ids",
    "sdk_version",
    "git_commit",
    "git_dirty",
    "code_sha256",
)


@dataclass
class Dependencies:
    """What a run talks to; tests replace these with fakes."""

    generate: GenerateFn = field(default=pipeline.generate_sql)
    client_factory: ClientFactory = field(default=anthropic_client_factory)
    taxi_wiring: Callable[[Path], TaxiAIWiring] = field(default=default_taxi_wiring)
    fetch: Fetcher = field(default=httpx2_fetch)
    archive: Archive = field(default=DEV_ARCHIVE)
    out: Callable[[str], None] = field(default=print)
    provenance: Callable[[], dict[str, Any]] = field(default=provenance)


def main(argv: Sequence[str] | None = None, deps: Dependencies | None = None) -> int:
    deps = deps or Dependencies()
    args = _parser().parse_args(argv)
    data_dir: Path = args.data_dir.resolve()
    try:
        if args.command == "download":
            return _download(data_dir, deps)
        if args.command == "check-gold":
            return _check_gold(args, data_dir, deps)
        if args.command == "check-taxi":
            return _check_taxi(args, deps)
        if args.command == "report":
            return _rebuild_report(args.run_id, data_dir, deps)
        return asyncio.run(_run(args, data_dir, deps))
    except (
        EvalSetupError,
        ChecksumMismatchError,
        UnsafeArchiveError,
        BirdDataError,
        TaxiQuestionsError,
        TaxiSetupError,
    ) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="notebook_api.evals", description="Text-to-SQL evaluation harness."
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        required=True,
        help="Data directory: BIRD goes to <dir>/bird, results to <dir>/eval-results.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "download", help="Download, verify and extract the BIRD dev set (re-hashes every file)."
    )
    gold = commands.add_parser("check-gold", help="Time every BIRD dev gold query.")
    gold.add_argument("--timeout", type=_positive_float, default=DEFAULT_CHECK_GOLD_TIMEOUT_SECONDS)
    gold.add_argument("--row-cap", type=_positive_int, default=DEFAULT_ROW_CAP)
    gold.add_argument("--out", type=Path, default=None, help="Where to write the JSON results.")
    check = commands.add_parser("check-taxi", help="Validate the taxi questions file.")
    _taxi_args(check)

    report = commands.add_parser(
        "report",
        help="Rebuild a run's summary.json and report.md from its stored answers "
        "(no model calls, nothing spent).",
    )
    report.add_argument("--run-id", type=_run_id, required=True)

    run = commands.add_parser("run", help="Run the eval.")
    run.add_argument("--suite", choices=(*SUITES, "all"), default="all")
    run.add_argument(
        "--models",
        type=_models,
        default=os.environ.get("AI_MODEL") or DEFAULT_MODEL,
        help="Comma-separated model IDs; every model answers the same questions. "
        "Default: AI_MODEL, else claude-haiku-5-5.",
    )
    run.add_argument(
        "--effort",
        choices=EFFORTS,
        default=os.environ.get("AI_EFFORT") or "medium",
        help="The same effort for every model. Default: AI_EFFORT, else medium.",
    )
    run.add_argument(
        "--max-output-tokens",
        type=_positive_int,
        default=DEFAULT_MAX_OUTPUT_TOKENS,
        help="Cap on output tokens per model call, thinking included.",
    )
    run.add_argument("--size", type=_positive_int, default=DEFAULT_SUBSET_SIZE)
    run.add_argument("--seed", type=int, default=DEFAULT_SEED)
    run.add_argument(
        "--limit",
        type=_positive_int,
        default=None,
        help="Pilot: a stratified sample of this many questions from each suite's selection.",
    )
    run.add_argument(
        "--ids-from",
        type=Path,
        default=None,
        help="Ask exactly the questions listed in an earlier run's run.json.",
    )
    run.add_argument("--max-repairs", type=int, choices=range(0, 6), default=DEFAULT_MAX_REPAIRS)
    run.add_argument("--concurrency", type=_positive_int, default=DEFAULT_CONCURRENCY)
    run.add_argument(
        "--query-timeout",
        type=_positive_float,
        default=DEFAULT_QUERY_TIMEOUT_SECONDS,
        dest="query_timeout",
    )
    run.add_argument("--row-cap", type=_positive_int, default=DEFAULT_ROW_CAP)
    run.add_argument("--run-id", type=_run_id, default=None, help="Resume (or name) a run.")
    run.add_argument(
        "--dry-run", action="store_true", help="Use a fake model: no API calls, nothing spent."
    )
    run.add_argument(
        "--allow-spend",
        action="store_true",
        help="Required for any run that calls the paid API (anything but --dry-run).",
    )
    _taxi_args(run)
    return parser


def _taxi_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--taxi-questions", type=Path, default=DEFAULT_TAXI_QUESTIONS)
    parser.add_argument(
        "--duckdb-path",
        type=Path,
        default=Path(os.environ["DUCKDB_PATH"]) if os.environ.get("DUCKDB_PATH") else None,
        help="taxi.duckdb (default: DUCKDB_PATH).",
    )


def _models(value: str) -> list[str]:
    models = [m.strip() for m in value.split(",") if m.strip()]
    if not models or len(set(models)) != len(models):
        raise argparse.ArgumentTypeError("give one or more distinct, comma-separated model IDs")
    for model in models:
        if not _MODEL.match(model):
            raise argparse.ArgumentTypeError(f"not a model ID: {model!r}")
    return models


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def _positive_float(value: str) -> float:
    number = float(value)
    if not number > 0:
        raise argparse.ArgumentTypeError("must be a positive number")
    return number


def _run_id(value: str) -> str:
    # It names a directory, so no slashes, dots-only names or leading dashes.
    if not _RUN_ID.match(value) or set(value) <= {"."}:
        raise argparse.ArgumentTypeError("1-64 characters of letters, digits, '.', '_', '-'")
    return value


def _download(data_dir: Path, deps: Dependencies) -> int:
    dataset = ensure_dev_set(data_dir / "bird", deps.archive, deps.fetch, full_check=True)
    archive = data_dir / "bird" / deps.archive.filename
    manifest = json.loads((dataset.root / ".extracted.json").read_text())
    total = sum(entry["size"] for entry in manifest["files"].values())
    size = f"{archive.stat().st_size:,} bytes" if archive.exists() else "not kept"
    deps.out(f"BIRD dev archive: {archive} ({size}; pinned sha256 {deps.archive.sha256})")
    deps.out(
        f"extracted to {dataset.root}: {len(manifest['files'])} files, {total:,} bytes, "
        "every file's sha256 checked against the manifest"
    )
    deps.out(f"questions: {len(dataset.questions())}")
    return 0


def _check_gold(args: argparse.Namespace, data_dir: Path, deps: Dependencies) -> int:
    dataset = ensure_dev_set(data_dir / "bird", deps.archive, deps.fetch)
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    out_path: Path = args.out or data_dir / "eval-results" / f"gold-check-{stamp}.json"
    deps.out(f"timing {len(dataset.questions())} gold queries one at a time...")
    report = check_gold(
        dataset,
        timeout_seconds=args.timeout,
        row_cap=args.row_cap,
        out_path=out_path,
        progress=deps.out,
    )
    for line in describe(report):
        deps.out(line)
    deps.out(f"results: {out_path}")
    return 0


def _check_taxi(args: argparse.Namespace, deps: Dependencies) -> int:
    questions = load_taxi_questions(args.taxi_questions)
    executor = _taxi_executor(args.duckdb_path, DEFAULT_QUERY_TIMEOUT_SECONDS, DEFAULT_ROW_CAP)
    try:
        check_gold_sql(questions, executor)
    finally:
        executor.close()
    real = scored_questions(questions)
    deps.out(
        f"{args.taxi_questions}: {len(questions)} entries, all gold SQL runs; "
        f"{len(real)} scored question(s), {len(questions) - len(real)} example(s)"
    )
    if not real:
        deps.out(NOT_MEASURED)
    return 0


def _taxi_executor(duckdb_path: Path | None, timeout: float, row_cap: int) -> DuckDbExecutor:
    if duckdb_path is None or not duckdb_path.is_file():
        raise EvalSetupError("taxi.duckdb not found: set DUCKDB_PATH or pass --duckdb-path")
    return DuckDbExecutor(duckdb_path, timeout_seconds=timeout, row_cap=row_cap)


@dataclass
class _Suite:
    questions: list[EvalQuestion]
    target: Target | None
    selection: str
    status: str = "measured"
    message: str = ""


def _load_ids_from(path: Path) -> dict[str, Any]:
    try:
        if path.stat().st_size > _MAX_RUN_JSON_BYTES:
            raise EvalSetupError(f"{path} is too large to be a run.json")
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise EvalSetupError(f"can't read question IDs from {path}: {error}") from None
    ids = data.get("ids") if isinstance(data, dict) else None
    if not isinstance(ids, dict) or not all(
        isinstance(v, list) and all(isinstance(i, str) for i in v) for v in ids.values()
    ):
        raise EvalSetupError(f"{path} has no question IDs (expected a run.json)")
    return {"ids": ids, "bird_archive_sha256": data.get("bird_archive_sha256")}


async def _run(args: argparse.Namespace, data_dir: Path, deps: Dependencies) -> int:
    if not args.dry_run and not args.allow_spend:
        raise EvalSetupError(
            "this run calls the paid API; pass --allow-spend (after an approved pilot), "
            "or use --dry-run"
        )
    if args.effort not in EFFORTS:  # e.g. a bad AI_EFFORT (argparse only checks typed values)
        raise EvalSetupError(f"effort must be one of {', '.join(EFFORTS)}, not {args.effort!r}")
    if args.ids_from is not None and args.limit is not None:
        raise EvalSetupError("--ids-from asks an exact list; it can't be combined with --limit")
    source = _load_ids_from(args.ids_from) if args.ids_from is not None else None
    suites = list(SUITES) if args.suite == "all" else [args.suite]
    prepared: dict[str, _Suite] = {}
    # Cleanup for whatever the suites started; some are async (worker pools).
    closers: list[Callable[[], object]] = []
    config: dict[str, Any] = {
        "bird_archive_sha256": None,
        "taxi_questions_sha256": None,
        "taxi_schema_sha256": None,
        "taxi_query_limits": None,
        "ids": {},
        "ids_from": str(args.ids_from.resolve()) if args.ids_from is not None else None,
    }
    try:
        if "bird" in suites:
            prepared["bird"] = _prepare_bird(args, data_dir, deps, config, source)
        if "taxi" in suites:
            prepared["taxi"] = _prepare_taxi(args, deps, config, closers, source)
            await _read_taxi_schema(prepared["taxi"], config)
        # Every check that could stop the run happens before the first model call.
        factory = dry_run_client_factory if args.dry_run else deps.client_factory
        clients = {model: factory(model, args.effort) for model in args.models}

        run_id = args.run_id or _new_run_id(args.dry_run)
        run_dir = data_dir / "eval-results" / run_id
        run = _run_config(args, run_id, suites, config, deps.provenance())
        run = _start_or_resume(run_dir, run)

        questions = [q for suite in prepared.values() for q in suite.questions]
        targets = {name: s.target for name, s in prepared.items() if s.target is not None}
        results_path = run_dir / "results.jsonl"
        deps.out(f"run {run_id}: {len(questions)} question(s) x {len(args.models)} model(s)")
        progress = await run_eval(
            questions,
            models=args.models,
            targets=targets,
            clients=clients,
            generate=deps.generate,
            results_path=results_path,
            gold_path=run_dir / "gold.jsonl",
            concurrency=args.concurrency,
            max_repairs=args.max_repairs,
            max_output_tokens=args.max_output_tokens,
            on_progress=lambda p, r: deps.out(_progress_line(p, r)),
            on_gold=lambda i, n, q, o: deps.out(_gold_line(i, n, q, o)),
        )
    finally:
        # Every closer runs even if one fails: a worker pool must always stop.
        for close in closers:
            try:
                result = close()
                if inspect.isawaitable(result):
                    await result
            except Exception as error:
                deps.out(f"warning: cleanup failed: {type(error).__name__}: {error}")

    summary = build_summary(run, prepared, load_records(results_path))
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (run_dir / "report.md").write_text(render_markdown(summary))
    _print_totals(summary, deps.out)
    deps.out(f"report: {run_dir / 'report.md'}")
    if progress.failed:
        deps.out(
            f"{progress.failed} question(s) failed before an answer and are left out of the "
            f"scores; resume with: {run['resume_command']}"
        )
        return 1
    return 0


def _pick_ids[T](
    questions: list[T], wanted: list[str], id_of: Callable[[T], str], what: str
) -> list[T]:
    by_id = {id_of(q): q for q in questions}
    missing = [i for i in wanted if i not in by_id]
    if missing:
        raise EvalSetupError(f"{what} IDs not found: {', '.join(missing[:10])}")
    return [by_id[i] for i in wanted]


def _prepare_bird(
    args: argparse.Namespace,
    data_dir: Path,
    deps: Dependencies,
    config: dict[str, Any],
    source: dict[str, Any] | None,
) -> _Suite:
    dataset = ensure_dev_set(data_dir / "bird", deps.archive, deps.fetch)
    every = dataset.questions()

    def key(q: BirdQuestion) -> str:
        return f"{q.question_id:09d}"

    def difficulty(q: BirdQuestion) -> str:
        return q.difficulty

    if source is not None:
        if source.get("bird_archive_sha256") not in (None, dataset.archive_sha256):
            raise EvalSetupError("--ids-from names a run on a different BIRD archive")
        subset = _pick_ids(
            every, source["ids"].get("bird", []), lambda q: str(q.question_id), "BIRD"
        )
        selection = f"The exact {len(subset)} question IDs from {args.ids_from}"
    else:
        subset = stratified_sample(
            every, size=args.size, seed=args.seed, key=key, stratum=difficulty
        )
        selection = (
            f"Stratified by difficulty from the {len(every)} BIRD dev questions "
            f"(seed {args.seed}, size {args.size})"
        )
        if args.limit is not None and args.limit < len(subset):
            subset = stratified_sample(
                subset, size=args.limit, seed=args.seed, key=key, stratum=difficulty
            )
            selection += f", then a stratified pilot of {args.limit}"
    config["bird_archive_sha256"] = dataset.archive_sha256
    config["ids"]["bird"] = [str(q.question_id) for q in subset]
    return _Suite(
        questions=[bird_eval_question(q) for q in subset],
        target=BirdTarget(dataset, timeout_seconds=args.query_timeout, row_cap=args.row_cap),
        selection=selection + ".",
    )


def _prepare_taxi(
    args: argparse.Namespace,
    deps: Dependencies,
    config: dict[str, Any],
    closers: list[Callable[[], object]],
    source: dict[str, Any] | None,
) -> _Suite:
    path: Path = args.taxi_questions
    every, written_by = load_taxi_file(path)
    config["taxi_questions_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    real = scored_questions(every)
    if source is not None:
        real = _pick_ids(real, source["ids"].get("taxi", []), lambda q: q.id, "taxi")
    if not real:
        config["ids"]["taxi"] = []
        return _Suite(
            questions=[], target=None, selection="", status="not_measured", message=NOT_MEASURED
        )
    executor = _taxi_executor(args.duckdb_path, args.query_timeout, args.row_cap)
    closers.append(executor.close)
    check_gold_sql(every, executor)
    wiring = deps.taxi_wiring(args.duckdb_path)
    aclose = getattr(wiring, "aclose", None)
    if aclose is not None:
        closers.append(aclose)

    if source is not None:
        selection = f"The exact {len(real)} question IDs from {args.ids_from}"
    else:
        selection = f"All {len(real)} questions in {path.name}"
        if args.limit is not None and args.limit < len(real):

            def key(q: TaxiQuestion) -> str:
                return q.id

            real = stratified_sample(
                real, size=args.limit, seed=args.seed, key=key, stratum=lambda q: q.difficulty
            )
            selection += f", then a stratified pilot of {args.limit} (seed {args.seed})"
    selection += (
        f". Questions and gold SQL written by: {written_by}"
        if written_by
        else ". The file doesn't say who wrote the questions"
    )
    config["ids"]["taxi"] = [q.id for q in real]
    return _Suite(
        questions=[q.to_eval_question() for q in real],
        target=TaxiTarget(executor, wiring),
        selection=selection + ".",
    )


async def _read_taxi_schema(suite: _Suite, config: dict[str, Any]) -> None:
    """Read the taxi schema now, before any model call (BIRD questions may run
    in the same run): a pool that can't start or a schema missing sample values
    stops the run here, having spent nothing. Its hash and the query limits go
    into run.json and the resume fingerprint."""
    if not isinstance(suite.target, TaxiTarget):
        return
    schema = await suite.target.schema("taxi")
    config["taxi_schema_sha256"] = hashlib.sha256(schema.text.encode()).hexdigest()
    config["taxi_query_limits"] = suite.target.query_limits


def _new_run_id(dry_run: bool) -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return f"{stamp}-dry" if dry_run else stamp


def _run_config(
    args: argparse.Namespace,
    run_id: str,
    suites: list[str],
    config: dict[str, Any],
    versions: dict[str, Any],
) -> dict[str, Any]:
    flags = [
        "run",
        "--suite", args.suite,
        "--models", ",".join(args.models),
        "--effort", args.effort,
        "--max-repairs", str(args.max_repairs),
        "--max-output-tokens", str(args.max_output_tokens),
        "--query-timeout", f"{args.query_timeout:g}",
        "--row-cap", str(args.row_cap),
    ]  # fmt: skip
    if args.ids_from is not None:
        flags += ["--ids-from", str(args.ids_from.resolve())]
    else:
        flags += ["--size", str(args.size), "--seed", str(args.seed)]
        if args.limit is not None:
            flags += ["--limit", str(args.limit)]
    if args.taxi_questions != DEFAULT_TAXI_QUESTIONS:
        flags += ["--taxi-questions", str(args.taxi_questions)]
    flags += ["--dry-run"] if args.dry_run else ["--allow-spend"]
    fresh = "pnpm eval " + shlex.join(flags)
    return {
        "run_id": run_id,
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "dry_run": args.dry_run,
        "models": args.models,
        "effort": args.effort,
        "max_repairs": args.max_repairs,
        "max_output_tokens": args.max_output_tokens,
        "concurrency": args.concurrency,
        "query_timeout_seconds": args.query_timeout,
        "row_cap": args.row_cap,
        "suites": suites,
        "seed": args.seed,
        "size": args.size,
        "limit": args.limit,
        "fresh_command": fresh,
        "resume_command": f"{fresh} --run-id {shlex.quote(run_id)}",
        **versions,
        **config,
    }


def _start_or_resume(run_dir: Path, run: dict[str, Any]) -> dict[str, Any]:
    """Write run.json for a new run; for an existing one, insist on the same setup and code."""
    config_path = run_dir / "run.json"
    if config_path.exists():
        existing = json.loads(config_path.read_text())
        different = [key for key in _FINGERPRINT if existing.get(key) != run.get(key)]
        if different:
            raise EvalSetupError(
                f"run {run['run_id']} was started with a different setup or code version "
                f"({', '.join(different)}); its answers can't be mixed with this one's. "
                "Start a new run (drop --run-id, or pass a new one)."
            )
        return dict(existing)
    run_dir.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(run, indent=2) + "\n")
    return run


def _rebuild_report(run_id: str, data_dir: Path, deps: Dependencies) -> int:
    """Re-score a run's stored answers with this code's report, asking no model.

    Resuming refuses a run started by other code (its answers can't be mixed
    with new ones), but rebuilding only re-reads them, so it works on any run:
    an old report can be corrected when the way it's summarized changes. The
    report says which code rebuilt it.
    """
    run_dir = data_dir / "eval-results" / run_id
    config_path = run_dir / "run.json"
    if not config_path.is_file():
        raise EvalSetupError(f"no run {run_id} in {run_dir.parent}")
    _load_ids_from(config_path)  # size-checked, and must list its question IDs
    run = json.loads(config_path.read_text(encoding="utf-8"))
    # The suites' selection text and any "not measured" message were written
    # by the run itself; they don't depend on how answers are summarized.
    previous: dict[str, Any] = {}
    summary_path = run_dir / "summary.json"
    if summary_path.is_file():
        previous = json.loads(summary_path.read_text(encoding="utf-8")).get("suites", {})
    records = load_records(run_dir / "results.jsonl")
    summary = _summary_head(run)
    for name in run["suites"]:
        earlier = previous.get(name, {})
        if earlier.get("status", "measured") != "measured":
            summary["suites"][name] = {
                "status": earlier["status"],
                "message": earlier.get("message", ""),
            }
            continue
        ids = list(run["ids"].get(name, []))
        selection = str(earlier.get("selection", ""))
        summary["suites"][name] = _measured_suite(run, name, ids, selection, records)
    summary["rebuilt_by"] = deps.provenance()
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (run_dir / "report.md").write_text(render_markdown(summary))
    _print_totals(summary, deps.out)
    deps.out(f"report: {run_dir / 'report.md'}")
    return 0


def build_summary(
    run: dict[str, Any], suites: dict[str, _Suite], records: list[dict[str, Any]]
) -> dict[str, Any]:
    out = _summary_head(run)
    for name, suite in suites.items():
        if suite.status != "measured":
            out["suites"][name] = {"status": suite.status, "message": suite.message}
            continue
        ids = [q.id for q in suite.questions]
        out["suites"][name] = _measured_suite(run, name, ids, suite.selection, records)
    return out


def _summary_head(run: dict[str, Any]) -> dict[str, Any]:
    return {
        "run": run,
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "suites": {},
    }


def _measured_suite(
    run: dict[str, Any], name: str, ids: list[str], selection: str, records: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "status": "measured",
        "selected": len(ids),
        "selection": selection,
        "ids": ids,
        "models": {
            model: summarize_suite(records, suite=name, model=model, selected_ids=ids)
            for model in run["models"]
        },
    }


def _gold_line(index: int, total: int, question: EvalQuestion, outcome: ExecOutcome) -> str:
    return (
        f"[gold {index}/{total}] {question.suite} {question.id}: {outcome.status} "
        f"({outcome.duration_ms / 1000:.1f} s)"
    )


def _progress_line(progress: RunProgress, record: dict[str, Any]) -> str:
    head = (
        f"[{progress.finished}/{progress.total}] {record['model']} {record['suite']} {record['id']}"
    )
    if record["status"] == "failed":
        return f"{head}: failed, will be retried on resume ({record['error']})"
    if record.get("gold_excluded"):
        return f"{head}: gold SQL failed ({record['gold']['status']}), excluded"
    first = "right" if record["first"]["correct"] else "wrong"
    final = "right" if record["final"]["correct"] else "wrong"
    return f"{head}: without repair {first}, with repair {final}"


def _print_totals(summary: dict[str, Any], out: Callable[[str], None]) -> None:
    for name, suite in summary["suites"].items():
        if suite["status"] != "measured":
            out(suite["message"])
            continue
        for model, stats in suite["models"].items():
            tokens = stats["tokens"]
            cost = stats["cost_usd_list_prices"]
            if not tokens["cache_breakdown_recorded"]:
                cost_text = "not computable (cache writes and reads weren't recorded)"
            elif cost is None:
                cost_text = "not computed (no list price)"
            else:
                cost_text = f"${cost:.4f}"
            acc = stats["accuracy"]
            unfinished = f"; {stats['incomplete']} unfinished" if stats["incomplete"] else ""
            out(
                f"{name} {model}: n={stats['scored']}{unfinished} "
                f"accuracy without repair {_pct(acc['without_repair'])}, "
                f"with repair {_pct(acc['with_repair'])}; "
                f"tokens in {tokens['input']:,} out {tokens['output']:,} "
                f"({tokens['replies']} calls); cost computed from list prices {cost_text}"
            )


def _pct(data: dict[str, Any]) -> str:
    rate = data["rate"]
    return "n/a" if rate is None else f"{rate * 100:.1f}% ({data['successes']}/{data['n']})"
