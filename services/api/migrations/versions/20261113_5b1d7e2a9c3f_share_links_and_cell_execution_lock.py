"""Share links, the per-cell execution lock, the execution that produced each run,
and at most one owner per notebook.

Revision ID: 5b1d7e2a9c3f
Revises: c4174a9f412b
Create Date: 2026-11-13 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5b1d7e2a9c3f"
down_revision: str | None = "c4174a9f412b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "share_links",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("notebook_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("role IN ('editor', 'viewer')", name="ck_share_links_role"),
        sa.ForeignKeyConstraint(["notebook_id"], ["notebooks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index(
        op.f("ix_share_links_notebook_id"), "share_links", ["notebook_id"], unique=False
    )
    op.create_table(
        "cell_executions",
        sa.Column("notebook_id", sa.Uuid(), nullable=False),
        sa.Column("cell_id", sa.String(length=64), nullable=False),
        sa.Column("execution_id", sa.Uuid(), nullable=False),
        sa.Column("started_by", sa.Uuid(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["notebook_id"], ["notebooks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["started_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("notebook_id", "cell_id"),
    )
    op.add_column("cell_runs", sa.Column("execution_id", sa.Uuid(), nullable=True))
    op.create_index(
        "uq_notebook_members_one_owner",
        "notebook_members",
        ["notebook_id"],
        unique=True,
        postgresql_where=sa.text("role = 'owner'"),
    )
    op.create_index(op.f("ix_cell_runs_execution_id"), "cell_runs", ["execution_id"], unique=False)


def downgrade() -> None:
    op.drop_index(
        "uq_notebook_members_one_owner",
        table_name="notebook_members",
        postgresql_where=sa.text("role = 'owner'"),
    )
    op.drop_index(op.f("ix_cell_runs_execution_id"), table_name="cell_runs")
    op.drop_column("cell_runs", "execution_id")
    op.drop_table("cell_executions")
    op.drop_index(op.f("ix_share_links_notebook_id"), table_name="share_links")
    op.drop_table("share_links")
