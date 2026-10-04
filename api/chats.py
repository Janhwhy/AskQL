"""Saved chats (Phase 8): list / open / rename / pin / delete.

Chats are CREATED implicitly by `/chat` (api/main.py) on a thread's first
message, and their turns are written there too, server-side, when the agent's
stream reaches a terminal event -- not by the frontend after the fact, so a
tab closed mid-answer can't leave a transcript that disagrees with what the
agent's own checkpointed context thinks was said.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agent.graph import forget_thread

from . import chats_db as db

router = APIRouter(prefix="/chats", tags=["chats"])


class ChatUpdate(BaseModel):
    title: Optional[str] = None
    pinned: Optional[bool] = None


@router.get("")
def list_chats() -> list[dict]:
    return db.list_chats()


@router.get("/{chat_id}")
def get_chat(chat_id: str) -> dict:
    chat = db.get_chat(chat_id)
    if chat is None:
        raise HTTPException(404, "chat not found")
    return chat


@router.patch("/{chat_id}")
def update_chat(chat_id: str, body: ChatUpdate) -> dict:
    title = body.title.strip() if body.title is not None else None
    if title is not None and not title:
        raise HTTPException(400, "title must not be empty")
    chat = db.update_chat(chat_id, title=title, pinned=body.pinned)
    if chat is None:
        raise HTTPException(404, "chat not found")
    return chat


@router.delete("/{chat_id}")
def delete_chat(chat_id: str) -> dict:
    if not db.delete_chat(chat_id):
        raise HTTPException(404, "chat not found")
    # Also drop the agent's checkpointed context for this thread -- otherwise
    # "deleted" would only mean "hidden from the sidebar".
    forget_thread(chat_id)
    return {"deleted": True}
