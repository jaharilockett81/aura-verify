"""Amazon Bedrock planner (Converse API with forced tool use for strict structured output).

The model only proposes a plan. Everything it returns is validated with Pydantic, unknown devices or actions are
rejected, routines are expanded from stored memory (not from model output), and risk is assigned afterwards by
the policy module. If the call fails, the orchestrator falls back to the local planner and says so.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from ..models import PlanDraft, PlannedAction

PLAN_TOOL = {
    "toolSpec": {
        "name": "submit_plan",
        "description": "Submit the structured household plan for the user's request.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "intent": {"type": "string",
                               "enum": ["routine", "device_control", "preference_update", "query", "clarify",
                                        "unknown", "timer"]},
                    "summary": {"type": "string", "description": "Short title for the plan (max 80 chars)."},
                    "spoken_response": {"type": "string",
                                        "description": "One or two short sentences to speak aloud. Never claim an "
                                                       "action already happened: nothing has executed yet."},
                    "routine_id": {"type": "string", "description": "Required when intent is routine."},
                    "thermostat_setpoint_f": {"type": "integer",
                                              "description": "Only with intent routine: a temperature the user "
                                                             "stated explicitly for this run (overrides the saved "
                                                             "preference for this run only)."},
                    "clarification_question": {"type": "string"},
                    "actions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "action": {"type": "string",
                                           "enum": ["read_device", "set_device", "create_reminder",
                                                    "update_preference", "timer"]},
                                "timer": {"type": "object",
                                          "description": "For action timer: {op: create|create_and_start|start|"
                                                         "pause|resume|cancel|check, label?, duration_s?}"},
                                "title": {"type": "string"},
                                "rationale": {"type": "string"},
                                "device_id": {"type": "string"},
                                "attributes": {"type": "object"},
                                "reminder": {"type": "object",
                                             "properties": {"title": {"type": "string"}, "due": {"type": "string"},
                                                            "note": {"type": "string"}}},
                                "preference_key": {"type": "string"},
                                "preference_value": {"type": "string",
                                                     "description": "New value as text, e.g. \"70\" or \"21:30\"."},
                            },
                            "required": ["action", "title"],
                        },
                    },
                },
                "required": ["intent", "summary", "spoken_response"],
            }
        },
    }
}

SYSTEM_PROMPT = """You are the planning module of AURA Verify, a household assistant that controls SIMULATED devices.
You do not execute anything. You turn one user request into a plan by calling submit_plan exactly once.

Rules:
- If the request matches a saved routine, use intent "routine" with its routine_id and NO actions (the system expands
  routines from stored memory). If the user also states a temperature for that routine, put it in
  thermostat_setpoint_f; never drop or replace an explicit value. If it is outside the thermostat's allowed range,
  or more than one temperature is given, use intent "clarify" instead.
- If the user states a lasting preference ("I prefer...", "from now on...", "actually..."), use intent
  "preference_update" with one update_preference action using an existing preference key.
- For direct device commands use set_device with attributes allowed for that device. For questions use read_device.
- If required information is missing (e.g. no temperature given), use intent "clarify" with a short question.
- Only use device ids, attribute names and preference keys listed in the context. Never invent devices.
- Several actions in one request become one plan with one action each; never drop part of a request.
- Timers use action "timer" (intent "timer", or "query" for checking time left).
- spoken_response must not claim anything has happened yet.
"""


class BedrockPlanner:
    name = "bedrock"

    def __init__(self, model_id: str, region: str, timeout_s: float = 20.0, client: Any = None):
        self.model_id = model_id
        self.region = region
        self.timeout_s = timeout_s
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            import boto3
            from botocore.config import Config

            self._client = boto3.client("bedrock-runtime", region_name=self.region,
                                        config=Config(read_timeout=self.timeout_s, connect_timeout=5,
                                                      retries={"max_attempts": 2}))
        return self._client

    @staticmethod
    def _context_block(context: dict[str, Any], pending: dict[str, Any] | None) -> str:
        compact = {
            "devices": [{"device_id": d["device_id"], "name": d["name"], "type": d["type"],
                         "settable_attributes": d["settable_attributes"]} for d in context.get("devices", [])],
            "routines": context.get("routines", []),
            "preferences": [{"key": p["key"], "label": p["label"], "value": p["value"], "unit": p["unit"]}
                            for p in context.get("preferences", [])],
            "pending_clarification": pending,
        }
        return json.dumps(compact, default=str)

    async def _converse(self, request: dict[str, Any]) -> dict[str, Any]:
        return await asyncio.wait_for(asyncio.to_thread(self._get_client().converse, **request),
                                      timeout=self.timeout_s + 5)

    async def plan(self, utterance: str, context: dict[str, Any], pending: dict[str, Any] | None) -> PlanDraft:
        started = time.perf_counter()
        request = {
            "modelId": self.model_id,
            "system": [{"text": SYSTEM_PROMPT}],
            "messages": [{"role": "user", "content": [
                {"text": f"Household context (JSON):\n{self._context_block(context, pending)}"},
                {"text": f"User request: {utterance}"},
            ]}],
            "toolConfig": {"tools": [PLAN_TOOL], "toolChoice": {"any": {}}},
            "inferenceConfig": {"maxTokens": 1200, "temperature": 0},
        }
        note = ""
        try:
            response = await self._converse(request)
        except Exception as exc:  # noqa: BLE001
            # Some models reject forced tool choice; retry once with the default (auto) and say so.
            if "toolchoice" not in str(exc).lower():
                raise
            request["toolConfig"] = {"tools": [PLAN_TOOL]}
            response = await self._converse(request)
            note = " · toolChoice=any unsupported, used auto"
        latency = int((time.perf_counter() - started) * 1000)
        blocks = response.get("output", {}).get("message", {}).get("content", [])
        tool_use = next((b["toolUse"] for b in blocks if "toolUse" in b), None)
        if tool_use is None or tool_use.get("name") != "submit_plan":
            raise ValueError("Model did not return a submit_plan tool call.")
        raw = tool_use["input"]
        usage = response.get("usage", {})
        actions = [PlannedAction.model_validate(a) for a in raw.get("actions") or []]
        return PlanDraft(
            intent=raw["intent"],
            summary=str(raw.get("summary", ""))[:120] or "Plan",
            spoken_response=str(raw.get("spoken_response", ""))[:400],
            routine_id=raw.get("routine_id") or None,
            actions=[] if raw["intent"] == "routine" else actions,
            overrides={"thermostat": {"setpoint_f": int(raw["thermostat_setpoint_f"])}}
            if raw["intent"] == "routine" and raw.get("thermostat_setpoint_f") is not None else {},
            clarification_question=raw.get("clarification_question"),
            pending_slot={"slot": "freeform", "question": raw.get("clarification_question")}
            if raw["intent"] == "clarify" else None,
            planner="bedrock",
            planner_detail=f"Amazon Bedrock · {self.model_id} · {latency} ms · "
                           f"{usage.get('inputTokens', '?')} in / {usage.get('outputTokens', '?')} out tokens{note}",
        )
