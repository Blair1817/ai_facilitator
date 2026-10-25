"""Extract anonymized replay material; never modify the diagnostic evidence.

Run from repository root: python3 server/scripts/extract-adaptive-closeout-replay.py
This fixture contains historical outputs, not assertions that a new model
will produce them. Source checksums and transcript membership are verified
before anonymization. Raw evidence must remain in the ignored outputs directory.
"""
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
source = root / "outputs/adaptive-diagnostic-20261025"
summary = json.loads((source / "diagnostic-summary.json").read_text())
audit = [entry for entry in map(json.loads, (source / "llm-audit.jsonl").read_text().splitlines())
         if entry.get("facilitation") == "adaptive" and not entry.get("participantRequested")
         and entry.get("detectorRawResponse")]
transcript = (source / "transcript.md").read_text().split("## Formal Round 2")[0]
fixtures = []
for entry, observed in zip(audit, summary["checkpoints"], strict=True):
    chat = entry["agentState"]["cumulativeContext"]
    assert entry["humanMessageCount"] == observed["humanMessageCount"]
    for message in chat:
        if message.get("speakerType") == "human":
            assert message["text"] in transcript
    fixtures.append({
        "checkpoint": entry["humanMessageCount"], "remainingTimeMs": entry["remainingTime"],
        "chat": [{key: message[key] for key in ["messageId", "text", "sender", "timestamp", "speakerType", "messageType", "stage"] if key in message} for message in chat],
        "taskGeneralContext": entry["agentState"]["generalInfo"],
        "detectorRawResponse": entry["detectorRawResponse"], "plan": entry.get("plan"),
        "specialistValidator": entry.get("specialistFailure", {}).get("validator") or entry.get("validator"),
        "generatorRawResponses": entry.get("generatorRawResponses", []), "observed": observed,
    })
assert len(fixtures) == 10
participant_ids = {}
for fixture in fixtures:
    for message in fixture["chat"]:
        if message.get("speakerType") == "human":
            identity = message["sender"]["id"]
            participant_ids.setdefault(identity, f"participant-{len(participant_ids) + 1}")
time_origin = min(message["timestamp"] for fixture in fixtures for message in fixture["chat"])
replacements = {summary["gameId"]: "adaptive-replay-session", **participant_ids,
                "I'm vegan": "[personal aside omitted]"}


def anonymize(value):
    if isinstance(value, str):
        for original, replacement in replacements.items():
            value = value.replace(original, replacement)
        return value
    if isinstance(value, list):
        return [anonymize(item) for item in value]
    if isinstance(value, dict):
        result = {key: anonymize(item) for key, item in value.items()}
        if "sender" in result:
            result["sender"] = {key: result["sender"][key] for key in ("id", "name")}
        if isinstance(result.get("timestamp"), (int, float)):
            result["timestamp"] -= time_origin
        return result
    return value


result = anonymize({
    "gameId": "adaptive-replay-session",
    "mode": "historical evidence; deterministic and mocked replay, not a real-model evaluation",
    "anonymization": "Session and participant IDs replaced; avatar/color metadata removed; timestamps relative to first message; personal dietary aside omitted. Task discussion and historical model outputs retained.",
    "sources": {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in ["transcript.md", "llm-audit.jsonl", "diagnostic-summary.json"]},
    "checkpoints": fixtures,
})
serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
assert not re.search(r"\b[0-9A-Z]{26}\b|https?://|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", serialized)
(root / "server/test/fixtures/adaptive-closeout-replay.json").write_text(serialized)
