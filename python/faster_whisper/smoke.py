"""Repeatable real-model offline smoke test. WAV paths must be public/test audio."""
import argparse
import importlib.util
import json
from pathlib import Path
import socket
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("nexq_fw", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--russian", required=True)
parser.add_argument("--english", required=True)
parser.add_argument("--mixed", required=True)
parser.add_argument("--report", required=True)
args = parser.parse_args()
report = {"offline": True, "cases": []}
with patch.object(socket.socket, "connect", side_effect=AssertionError("Network forbidden during inference")):
    engine = worker.Engine()
    for name, path in (("russian", args.russian), ("english", args.english), ("mixed", args.mixed), ("cache_repeat", args.mixed)):
        result = engine.transcribe(dict(op="transcribe", model_path=args.model, path=path, config={"device": "auto"}))
        text = " ".join(s["text"] for s in result["segments"])
        assert text, name
        report["cases"].append(dict(case=name, text=text, seconds=result["seconds"], audio_seconds=result["audio_seconds"], hardware=dict(result["hardware"])))
    assert engine.loads == 1, "Model was reloaded"
    result = engine.transcribe(dict(op="transcribe", model_path=args.model, path=args.russian, config={"device": "cpu", "computeType": "int8", "language": "ru"}))
    assert result["segments"] and result["hardware"]["device"] == "cpu"
    report["cpu"] = result
Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"passed": True, "network_blocked": True, "model_reused": True}))
