"""Small offline tests. Run with the bundled Python; no model download needed."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("nexq_fw", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
from models import DEFAULT_MODEL, REQUIRED_FILES, install_model, validate_model


class WorkerTests(unittest.TestCase):
    def test_unreliable_decoder_guesses_are_not_published(self):
        engine=worker.Engine.__new__(worker.Engine); engine.hardware={"device":"cuda"}
        def segment(text, **scores):
            return SimpleNamespace(text=text,start=0,end=1,avg_logprob=scores.get("avg_logprob",-0.2),
                                   no_speech_prob=scores.get("no_speech_prob",0.01),
                                   compression_ratio=scores.get("compression_ratio",1.0))
        candidates=[segment("Настоящий вопрос"),segment("noise guess",no_speech_prob=0.8),
                    segment("uncertain guess",avg_logprob=-1.5),segment("repeated guess",compression_ratio=3.0),
                    segment("invalid confidence",avg_logprob=float("nan"))]
        engine.model=SimpleNamespace(transcribe=lambda audio,**settings:(iter(candidates),SimpleNamespace(language="ru")))
        audio=worker.base64.b64encode((1000).to_bytes(2,'little',signed=True)*16000).decode()
        with patch.object(engine,"initialize"):
            result=engine.transcribe(dict(model_path="cached",pcm16=audio,config={"vadFilter":False,"language":"ru"}))
        self.assertEqual([segment["text"] for segment in result["segments"]],["Настоящий вопрос"])

    def test_russian_language_and_short_noise_gate_reach_the_decoder(self):
        import numpy as np
        engine=worker.Engine.__new__(worker.Engine); engine.hardware={"device":"cuda"}
        engine.model=Mock(return_value=None)
        engine.model.transcribe.return_value=(iter([]),SimpleNamespace(language="ru"))
        audio=worker.base64.b64encode((1000).to_bytes(2,'little',signed=True)*16000).decode()
        chunks=[{"start":0,"end":16000}]
        with patch.object(engine,"initialize"), patch("faster_whisper.vad.get_speech_timestamps",return_value=chunks) as vad, patch("faster_whisper.vad.collect_chunks",return_value=([np.zeros(16000,dtype=np.float32)],None)):
            engine.transcribe(dict(model_path="cached",pcm16=audio,config={"language":"ru","vadFilter":True}))
        self.assertEqual(vad.call_args.args[1].min_speech_duration_ms,150)
        self.assertEqual(engine.model.transcribe.call_args.kwargs["language"],"ru")

    def test_vad_empty_packet_never_calls_the_whisper_decoder(self):
        engine=worker.Engine.__new__(worker.Engine)
        engine.hardware={"device":"cuda"}; engine.model=Mock()
        audio=worker.base64.b64encode((1000).to_bytes(2,'little',signed=True)*64000).decode()
        with patch.object(engine,"initialize"), patch("faster_whisper.vad.get_speech_timestamps",return_value=[]):
            result=engine.transcribe(dict(model_path="cached",pcm16=audio))
        self.assertEqual(result["segments"],[])
        self.assertTrue(result["skipped_no_speech"])
        engine.model.transcribe.assert_not_called()

    def test_provisional_decode_is_fast_and_final_quality_is_preserved(self):
        engine=worker.Engine.__new__(worker.Engine); engine.hardware={"device":"cuda"}
        options=[]
        def decode(audio,**settings):
            options.append(settings)
            return iter([SimpleNamespace(text="Ответ",start=0,end=1,avg_logprob=-0.1,no_speech_prob=0.01)]),SimpleNamespace(language="ru")
        engine.model=SimpleNamespace(transcribe=decode)
        audio=worker.base64.b64encode((1000).to_bytes(2,'little',signed=True)*16000).decode()
        with patch.object(engine,"initialize"):
            for provisional in [False,True]:
                engine.transcribe(dict(model_path="cached",pcm16=audio,provisional=provisional,config={"quality":"balanced","vadFilter":False}))
            engine.transcribe(dict(model_path="cached",pcm16=audio,config={"quality":"accurate","vadFilter":False}))
        self.assertEqual([(s["beam_size"],s["without_timestamps"]) for s in options],[(3,False),(1,True),(5,False)])

    def test_cached_install_never_imports_download_client(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "voxta-large-v3-turbo-int8"
            folder.mkdir()
            files = []
            for name in REQUIRED_FILES:
                (folder / name).write_bytes(b"fixture")
                files.append(dict(name=name, size=7, sha256=hashlib.sha256(b"fixture").hexdigest()))
            manifest = dict(repo=DEFAULT_MODEL, complete=True, files=files)
            (folder / "MODEL-MANIFEST.json").write_text(json.dumps(manifest), encoding="utf-8")
            progress = []
            with patch.dict("sys.modules", {"huggingface_hub": None}):
                self.assertEqual(install_model(DEFAULT_MODEL, root, progress.append), folder)
            self.assertTrue(progress[0]["cached"])
            (folder / "model.bin").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "checksum"):
                validate_model(folder, hashes=True)

    def test_unsupported_cuda_compute_falls_back_to_cpu_int8(self):
        class CpuOnly:
            get_cuda_device_count = staticmethod(lambda: 0)
            get_supported_compute_types = staticmethod(lambda device: {"int8", "float32"})
        device, compute, warning = worker.resolve_hardware({"device": "cuda", "computeType": "float16"}, CpuOnly)
        self.assertEqual((device, compute), ("cpu", "int8"))
        self.assertTrue(warning)
        with self.assertRaises(ValueError):
            worker.resolve_hardware({"device": "bad"}, CpuOnly)

    def test_decode_rejects_broken_pcm_without_loading_another_model(self):
        engine = worker.Engine.__new__(worker.Engine)
        engine.hardware = {"device": "cpu"}
        with patch.object(engine, "initialize") as initialize:
            with self.assertRaisesRegex(ValueError, "PCM16"):
                engine.transcribe(dict(model_path="cached", pcm16="AA=="))
            initialize.assert_called_once()

    def test_cuda_initialization_failure_reuses_cpu_model_on_next_auto_request(self):
        engine = worker.Engine.__new__(worker.Engine)
        engine.ct2 = object()
        engine.model, engine.requested_key, engine.loads = None, None, 0
        attempts = []
        def load(path, **settings):
            attempts.append(settings)
            if settings["device"] == "cuda":
                raise RuntimeError("simulated CUDA load failure")
            return object()
        engine.model_class = load
        with patch.object(worker, "validate_model"), patch.object(worker, "resolve_hardware", return_value=("cuda", "int8_float16", None)):
            first = engine.initialize("fixture-model", {"device": "auto"})
            second = engine.initialize("fixture-model", {"device": "auto"})
        self.assertIs(first, second)
        self.assertEqual((first["device"], first["compute_type"]), ("cpu", "int8"))
        self.assertTrue(first["warning"])
        self.assertEqual(len(attempts), 2)
        self.assertEqual(engine.loads, 1)


if __name__ == "__main__":
    unittest.main()
