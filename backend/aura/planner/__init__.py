"""Planners turn an utterance into a PlanDraft. They never execute anything and never assign risk."""

from __future__ import annotations

from typing import Any, Protocol

from ..models import PlanDraft


class Planner(Protocol):
    name: str

    async def plan(self, utterance: str, context: dict[str, Any], pending: dict[str, Any] | None) -> PlanDraft: ...
