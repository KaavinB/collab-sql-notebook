"""Notebooks, Yjs snapshots and cell runs (D6, D7).

Revision ID: 32069987f4a9
Revises:
Create Date: 2026-11-13 01:27:49.731965
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "32069987f4a9"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "notebooks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "cell_runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("notebook_id", sa.Uuid(), nullable=False),
        sa.Column("cell_id", sa.String(length=64), nullable=False),
        sa.Column("sql", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("error", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(status = 'ok' AND result IS NOT NULL AND error IS NULL) OR "
            "(status = 'error' AND result IS NULL AND error IS NOT NULL)",
            name="ck_cell_runs_outcome",
        ),
        sa.CheckConstraint("status IN ('ok', 'error')", name="ck_cell_runs_status"),
        sa.ForeignKeyConstraint(["notebook_id"], ["notebooks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_cell_runs_notebook_cell_created",
        "cell_runs",
        ["notebook_id", "cell_id", "created_at"],
        unique=False,
    )
    op.create_table(
        "notebook_snapshots",
        sa.Column("notebook_id", sa.Uuid(), nullable=False),
        sa.Column("state", sa.LargeBinary(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["notebook_id"], ["notebooks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("notebook_id"),
    )


def downgrade() -> None:
    op.drop_table("notebook_snapshots")
    op.drop_index("ix_cell_runs_notebook_cell_created", table_name="cell_runs")
    op.drop_table("cell_runs")
    op.drop_table("notebooks")
