"""Live Amazon Bedrock check for AURA Verify.

Runs real AWS calls with your local AWS profile and records what happened. Nothing here is mocked.

    cd backend
    .venv/bin/python scripts/bedrock_check.py --profile aura-verify --region us-east-1

Steps:
  1. STS GetCallerIdentity (which account/principal the profile resolves to)
  2. List Bedrock text models and system inference profiles available in the region
  3. One minimal Converse call to the chosen model
  4. AURA's BedrockPlanner on the demo utterances (real household context, temp database)
  5. Full agent workflows with the Bedrock planner: plan -> approve -> execute over MCP -> verify
     (bedtime routine, thermostat-failure recovery, preference update)

Results are written to bedrock-check-results.json (no credentials are written). Exit code 0 only if every
step passed with the Bedrock planner actually used (no silent fallback to the local planner).
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

RESULTS: dict = {"started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "steps": []}


def record(name: str, ok: bool, **detail) -> bool:
    RESULTS["steps"].append({"step": name, "ok": ok, **detail})
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}")
    for k, v in detail.items():
        text = v if isinstance(v, str) else json.dumps(v, default=str)
        print(f"       {k}: {text[:600]}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default=os.getenv("AWS_PROFILE"), help="AWS CLI profile name")
    ap.add_argument("--region", default=os.getenv("AWS_REGION", "us-east-1"))
    ap.add_argument("--model", default=os.getenv("AURA_BEDROCK_MODEL_ID", "us.amazon.nova-pro-v1:0"))
    ap.add_argument("--out", default="bedrock-check-results.json")
    args = ap.parse_args()

    if args.profile:
        os.environ["AWS_PROFILE"] = args.profile
    os.environ["AWS_REGION"] = args.region
    os.environ.pop("AURA_DISABLE_BEDROCK", None)
    RESULTS.update({"profile": args.profile, "region": args.region, "model": args.model})

    import boto3

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    ok = True

    # 1. Identity
    try:
        ident = session.client("sts").get_caller_identity()
        ok &= record("sts:GetCallerIdentity", True, account=ident["Account"], arn=ident["Arn"])
    except Exception as exc:  # noqa: BLE001
        record("sts:GetCallerIdentity", False, error=repr(exc))
        print("\nCredentials are not usable; stopping. See README 'Amazon Bedrock setup'.")
        return finish(args.out, False)

    # 2. Models
    bedrock = session.client("bedrock")
    try:
        models = bedrock.list_foundation_models(byOutputModality="TEXT")["modelSummaries"]
        text_models = sorted(
            m["modelId"] for m in models
            if m.get("modelLifecycle", {}).get("status") == "ACTIVE"
            and ("amazon.nova" in m["modelId"] or "anthropic." in m["modelId"])
        )
        profiles = []
        try:
            for page in bedrock.get_paginator("list_inference_profiles").paginate(typeEquals="SYSTEM_DEFINED"):
                profiles += [p["inferenceProfileId"] for p in page["inferenceProfileSummaries"]]
        except Exception as exc:  # noqa: BLE001
            profiles = [f"(could not list inference profiles: {exc!r})"]
        relevant = sorted(p for p in profiles if "nova" in p or "anthropic" in p)
        ok &= record("bedrock:ListFoundationModels / ListInferenceProfiles", True,
                     nova_and_anthropic_models=text_models, inference_profiles=relevant,
                     chosen_model_listed=args.model in text_models or args.model in profiles)
    except Exception as exc:  # noqa: BLE001
        ok &= record("bedrock:ListFoundationModels", False, error=repr(exc),
                     hint="IAM needs bedrock:ListFoundationModels (optional for the app itself).")

    # 3. Minimal Converse
    runtime = session.client("bedrock-runtime")
    try:
        t0 = time.perf_counter()
        resp = runtime.converse(modelId=args.model,
                                messages=[{"role": "user", "content": [{"text": "Reply with exactly: OK"}]}],
                                inferenceConfig={"maxTokens": 10, "temperature": 0})
        text = resp["output"]["message"]["content"][0].get("text", "")
        ok &= record("bedrock-runtime:Converse (hello)", True, reply=text.strip(),
                     latency_ms=int((time.perf_counter() - t0) * 1000), usage=resp.get("usage"))
    except Exception as exc:  # noqa: BLE001
        record("bedrock-runtime:Converse (hello)", False, error=repr(exc),
               hint="AccessDeniedException: add bedrock:InvokeModel. ValidationException on the model id: "
                    "try another region or model from step 2.")
        return finish(args.out, False)

    # 4 + 5. AURA planner and full workflows
    ok &= asyncio.run(aura_checks(args))
    return finish(args.out, ok)


async def aura_checks(args) -> bool:
    from aura.config import load_settings
    from aura.engine import WorkflowEngine
    from aura.gateway import MCPToolGateway
    from aura.mcp_server import build_mcp_server
    from aura.models import RunStatus, StepStatus
    from aura.planner.bedrock import BedrockPlanner
    from aura.services import HouseholdServices

    tmp = Path(tempfile.mkdtemp(prefix="aura-bedrock-"))
    settings = dataclasses.replace(load_settings(), db_path=tmp / "aura.db", sim_settle_ms=200,
                                   verify_timeout_s=1.5, verify_poll_s=0.3)
    services = HouseholdServices(settings)
    services.seed()
    gateway = MCPToolGateway(build_mcp_server(services))
    planner = BedrockPlanner(args.model, args.region)
    ok = True

    context = (await gateway.call("get_household_context", {})).data
    expectations = [
        ("Alexa, prepare the house before my overnight shift.", "routine", "overnight_shift"),
        ("Get everything prepared for bedtime.", "routine", "bedtime"),
        ("Actually, I prefer my bedtime temperature at 70 degrees.", "preference_update", None),
        ("Set the thermostat", "clarify", None),
    ]
    for utterance, intent, routine in expectations:
        try:
            draft = await planner.plan(utterance, context, None)
            good = draft.intent == intent and (routine is None or draft.routine_id == routine)
            ok &= record(f"BedrockPlanner: {utterance!r}", good, intent=draft.intent, routine_id=draft.routine_id,
                         actions=[a.model_dump(exclude_none=True) for a in draft.actions],
                         spoken=draft.spoken_response, detail=draft.planner_detail,
                         expected=f"intent={intent} routine={routine}")
        except Exception as exc:  # noqa: BLE001
            ok &= record(f"BedrockPlanner: {utterance!r}", False, error=repr(exc), trace=traceback.format_exc()[-800:])

    engine = WorkflowEngine(settings, services.ledger, gateway, planner=planner)

    async def run_flow(name: str, utterance: str, recover_with: str | None = None) -> bool:
        sid = services.ledger.new_session()
        out = await engine.handle_utterance(sid, utterance)
        run = out["run"]
        if run is None:
            return record(name, False, reply=out["message"]["text"])
        if run["planner"] != "bedrock":
            return record(name, False, error="Engine fell back to the local planner", detail=run["planner_detail"])
        run_id = run["id"]
        if run["status"] == RunStatus.AWAITING_APPROVAL:
            await engine.approve_run(run_id)
        r = await engine.wait_idle(run_id)
        for _ in range(8):
            if r.status != RunStatus.PAUSED:
                break
            waiting = next((s for s in r.steps if s.status == StepStatus.AWAITING_APPROVAL), None)
            failing = next((s for s in r.steps if s.recovery_options), None)
            if waiting:
                await engine.decide_step(run_id, waiting.id, True)
            elif failing and recover_with:
                await engine.choose_recovery(run_id, failing.id, recover_with)
            else:
                break
            r = await engine.wait_idle(run_id)
        recovered = [s.title for s in r.steps if any(x.get("event") == "recovered" for x in s.recovery_log)]
        good = r.status == RunStatus.COMPLETED and (recover_with is None or bool(recovered))
        return record(name, good, run_status=r.status, planner_detail=r.planner_detail,
                      steps=[f"{s.title}: {s.status} (attempts {s.attempts})" for s in r.steps],
                      recovered=recovered, report=r.final_report)

    try:
        ok &= await run_flow("Workflow (Bedrock): bedtime routine end to end", "Get everything prepared for bedtime.")
        services.sim.seed(force=True)
        services.sim.inject_fault("thermostat", "energy_saver_hold")
        ok &= await run_flow("Workflow (Bedrock): overnight routine with thermostat failure + recovery",
                             "Alexa, prepare the house before my overnight shift.", recover_with="release_hold")
        ok &= await run_flow("Workflow (Bedrock): preference update verified by read-back",
                             "Actually, I prefer my bedtime temperature at 70 degrees.")
        pref = services.memory.get_preference("bedtime_temperature_f")["value"]
        ok &= record("Preference persisted", pref == 70, value=pref)
    finally:
        await engine.shutdown()
        await gateway.close()
    return ok


def finish(out: str, ok: bool) -> int:
    RESULTS["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    RESULTS["all_passed"] = bool(ok)
    Path(out).write_text(json.dumps(RESULTS, indent=2, default=str))
    print(f"\n{'ALL CHECKS PASSED' if ok else 'SOME CHECKS FAILED'} - results written to {out}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
