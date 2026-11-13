"""The BIRD suite: questions from the selected subset, run on BIRD's SQLite files."""

import asyncio

from notebook_api.ai.pipeline import SchemaContext, Validator
from notebook_api.evals.bird import BirdDataset, BirdQuestion
from notebook_api.evals.execution import ExecOutcome
from notebook_api.evals.runner import EvalQuestion
from notebook_api.evals.sqlite_db import SqliteValidator, execute_query, sqlite_schema_context


def bird_eval_question(question: BirdQuestion) -> EvalQuestion:
    return EvalQuestion(
        id=str(question.question_id),
        suite="bird",
        database=question.db_id,
        question=question.question,
        evidence=question.evidence or None,
        gold_sql=question.gold_sql,
        difficulty=question.difficulty,
    )


class BirdTarget:
    def __init__(self, dataset: BirdDataset, *, timeout_seconds: float, row_cap: int) -> None:
        self._dataset = dataset
        self._timeout_seconds = timeout_seconds
        self._row_cap = row_cap
        self._schemas: dict[str, asyncio.Task[SchemaContext]] = {}

    async def schema(self, database: str) -> SchemaContext:
        # Built once per database per run, and shared by every question on it.
        if database not in self._schemas:
            path = self._dataset.database_path(database)
            self._schemas[database] = asyncio.ensure_future(
                asyncio.to_thread(sqlite_schema_context, path)
            )
        return await self._schemas[database]

    def validator(self, database: str) -> Validator:
        return SqliteValidator(self._dataset.database_path(database))

    async def execute(self, database: str, sql: str) -> ExecOutcome:
        return await asyncio.to_thread(
            execute_query,
            self._dataset.database_path(database),
            sql,
            timeout_seconds=self._timeout_seconds,
            row_cap=self._row_cap,
        )
