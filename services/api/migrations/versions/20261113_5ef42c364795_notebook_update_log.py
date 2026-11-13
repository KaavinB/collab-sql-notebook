"""Notebook update log, written by the sync server.

A notebook's document becomes its snapshot plus the rows in this log. The
sync server appends batches of Yjs updates here and periodically compacts
them into notebook_snapshots.

Revision ID: 5ef42c364795
Revises: 5b1d7e2a9c3f
Create Date: 2026-11-13 13:33:09.278833
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5ef42c364795"
down_revision: str | None = "5b1d7e2a9c3f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "notebook_updates",
        # BigInteger primary key without an explicit Identity renders as bigserial.
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("notebook_id", sa.Uuid(), nullable=False),
        sa.Column("update", sa.LargeBinary(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["notebook_id"], ["notebooks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_notebook_updates_notebook_id_id",
        "notebook_updates",
        ["notebook_id", "id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_notebook_updates_notebook_id_id", table_name="notebook_updates")
    op.drop_table("notebook_updates")
