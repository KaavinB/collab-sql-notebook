"""Indexes for looking up AI rows by request and by user.

The sync server finds a request's suggestion by `ai_suggestions.request_id`.
Deleting a user sets `ai_requests.user_id` and `ai_suggestions.decided_by`
to NULL (ON DELETE SET NULL), which without an index scans the whole table.

Revision ID: 46eb1058192a
Revises: 287faa2fd211
Create Date: 2026-11-13 18:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "46eb1058192a"
down_revision: str | None = "287faa2fd211"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("ix_ai_suggestions_request_id", "ai_suggestions", ["request_id"])
    op.create_index("ix_ai_suggestions_decided_by", "ai_suggestions", ["decided_by"])
    op.create_index("ix_ai_requests_user_id", "ai_requests", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_ai_requests_user_id", table_name="ai_requests")
    op.drop_index("ix_ai_suggestions_decided_by", table_name="ai_suggestions")
    op.drop_index("ix_ai_suggestions_request_id", table_name="ai_suggestions")
