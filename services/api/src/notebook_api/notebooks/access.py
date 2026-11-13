"""Who may do what to a notebook, shared by every notebook route.

Roles, lowest to highest:
- viewer: read the notebook, its document, its runs and its members
- editor: also rename it, save its document and run cells
- owner: also delete it, share it and manage its members

A notebook you aren't a member of answers 404, exactly like one that
doesn't exist, so IDs can't be probed to learn which notebooks exist.
"""

import uuid
from typing import Annotated, Literal, cast

from fastapi import Depends, HTTPException, Path
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from notebook_api.db.models import Notebook, NotebookMember
from notebook_api.db.session import get_session

Session = Annotated[AsyncSession, Depends(get_session)]
NotebookId = Annotated[uuid.UUID, Path()]

Role = Literal["owner", "editor", "viewer"]
RANK: dict[str, int] = {"viewer": 0, "editor": 1, "owner": 2}


def not_found() -> HTTPException:
    return HTTPException(
        status_code=404, detail={"kind": "not_found", "message": "Notebook not found."}
    )


def forbidden(message: str) -> HTTPException:
    return HTTPException(status_code=403, detail={"kind": "forbidden", "message": message})


async def membership(
    session: AsyncSession, notebook_id: uuid.UUID, user_id: uuid.UUID, at_least: Role = "viewer"
) -> tuple[Notebook, Role]:
    """The notebook and the user's role in it.

    404 if it doesn't exist or the user isn't a member; 403 if the user is
    a member whose role is below `at_least`.
    """
    row = (
        await session.execute(
            select(Notebook, NotebookMember.role)
            .join(NotebookMember, NotebookMember.notebook_id == Notebook.id)
            .where(Notebook.id == notebook_id, NotebookMember.user_id == user_id)
        )
    ).first()
    if row is None:
        raise not_found()
    notebook = row[0]
    # The ck_notebook_members_role check constraint limits the column to Role.
    role = cast(Role, row[1])
    if RANK[role] < RANK[at_least]:
        raise forbidden(f"You need {at_least} access to do that. Your role is {role}.")
    return notebook, role


async def lock_notebook(
    session: AsyncSession, notebook_id: uuid.UUID, *, exclusive: bool = False
) -> bool:
    """Lock the notebook's row for this transaction; False if it doesn't exist.

    Lock order: every transaction that writes a notebook's dependent rows
    (runs, the execution lock, share links, the document) and could meet a
    concurrent DELETE of the notebook locks the notebook row first. Deleting
    a notebook also locks that row first and then cascades to the dependent
    rows, so the two always take locks in the same order and can't deadlock.

    The default is FOR KEY SHARE, the weakest row lock: it only conflicts
    with deleting the notebook (or changing its ID), so, for example, two
    cells claiming their execution locks don't queue behind each other.
    `exclusive` (FOR NO KEY UPDATE) also serializes with other exclusive
    holders, for read-then-write sequences such as "count, then insert".
    """
    query = select(Notebook.id).where(Notebook.id == notebook_id)
    # On PostgreSQL, key_share alone renders FOR NO KEY UPDATE, and with
    # read=True it renders FOR KEY SHARE.
    query = query.with_for_update(read=not exclusive, key_share=True)
    return (await session.scalar(query)) is not None
