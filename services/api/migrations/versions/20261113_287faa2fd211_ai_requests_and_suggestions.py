"""AI requests (the log of every AI query) and the suggestions they produce.

Revision ID: 287faa2fd211
Revises: 5ef42c364795
Create Date: 2026-11-13 15:24:26.899577
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "287faa2fd211"
down_revision: str | None = "5ef42c364795"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ai_requests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("notebook_id", sa.Uuid(), nullable=False),
        sa.Column("cell_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("prompt", sa.JSON(), nullable=False),
        sa.Column("model", sa.String(length=100), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("attempts", sa.JSON(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('generate', 'fix', 'explain')", name="ck_ai_requests_kind"),
        sa.CheckConstraint(
            "status IN ('running', 'succeeded', 'failed')", name="ck_ai_requests_status"
        ),
        sa.ForeignKeyConstraint(["notebook_id"], ["notebooks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_ai_requests_notebook_cell_created",
        "ai_requests",
        ["notebook_id", "cell_id", "created_at"],
        unique=False,
    )
    op.create_table(
        "ai_suggestions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("notebook_id", sa.Uuid(), nullable=False),
        sa.Column("cell_id", sa.String(length=64), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("sql", sa.Text(), nullable=True),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column("base_sql", sa.Text(), nullable=True),
        sa.Column("valid", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('generate', 'fix', 'explain')", name="ck_ai_suggestions_kind"),
        sa.CheckConstraint(
            "status IN ('pending', 'accepted', 'rejected')", name="ck_ai_suggestions_status"
        ),
        sa.ForeignKeyConstraint(["decided_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["notebook_id"], ["notebooks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["request_id"], ["ai_requests.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_ai_suggestions_notebook_cell",
        "ai_suggestions",
        ["notebook_id", "cell_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_ai_suggestions_notebook_cell", table_name="ai_suggestions")
    op.drop_table("ai_suggestions")
    op.drop_index("ix_ai_requests_notebook_cell_created", table_name="ai_requests")
    op.drop_table("ai_requests")
