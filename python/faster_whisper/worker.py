"""NexQ's private stdio STT worker. No listening port and no cloud inference."""
import argparse
import base64
import gc
import json
import logging
import math
import os
from pathlib import Path
import sys
import threading
import time

# -I isolates Python from PYTHONPATH/user packages; allow only our bundled code.
sys.path.insert(0, str(Path(__file__).resolve().parent))
PACKAGE_DIR = Path(__file__).resolve().parent / "packages"
if not PACKAGE_DIR.is_dir():
    PACKAGE_DIR = Path(__file__).resolve().parents[2] / "runtime" / "faster-whisper" / "packages"
sys.path.insert(1, str(PACKAGE_DIR))
from models import DEFAULT_MODEL, install_model, validate_model

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
logging.basicConfig(level=logging.WARNING)


def log(event, **fields):
    # Never put PCM, transcript text, prompts, or hotwords into diagnostic logs.
    sys.stderr.write(json.dumps({"event": event, **fields}, ensure_ascii=True) + "\n")
    sys.stderr.flush()


def reliable_segment(segment):
    # A decoder can return its best guess even after a confidence threshold
    # failed (there is no temperature fallback at temperature=0). Do not publish
    # that guess, silence tokens or repetition to the live transcript.
    scores = (segment.avg_logprob, segment.no_speech_prob,
              getattr(segment, "compression_ratio", 0.0))
    return (all(math.isfinite(value) for value in scores)
            and scores[0] >= -1.0 and scores[1] < 0.6 and scores[2] <= 2.4)


def register_cuda_libraries():
    handles = []
    if os.name == "nt":
        import site
        for root in [str(PACKAGE_DIR), *site.getsitepackages()]:
            for name in ("cublas", "cudnn", "cuda_runtime"):
                directory = Path(root) / "nvidia" / name / "bin"
                if directory.is_dir():
                    handles.append(os.add_dll_directory(str(directory)))
                    os.environ["PATH"] = str(directory) + os.pathsep + os.environ.get("PATH", "")
    return handles


def resolve_hardware(config, ct2):
    requested = config.get("device", "auto")
    if requested not in ("auto", "cpu", "cuda"):
        raise ValueError("Unsupported device selection")
    warning = None
    device = "cpu"
    if requested != "cpu":
        try:
            if ct2.get_cuda_device_count() > 0:
                if os.name == "nt":
                    import ctypes
                    ctypes.WinDLL("cublas64_12.dll")
                    ctypes.WinDLL("cudnn64_9.dll")
                device = "cuda"
        except Exception:
            warning = "CUDA libraries/driver unavailable; using CPU INT8"
    if requested == "cuda" and device == "cpu":
        warning = "Requested CUDA is unavailable; using CPU INT8"
    supported = ct2.get_supported_compute_types(device)
    compute = config.get("computeType", "auto")
    if compute not in ("auto", "int8", "int8_float16", "float16", "float32"):
        raise ValueError("Unsupported compute type")
    if compute == "auto" or compute not in supported:
        if compute != "auto":
            warning = "Requested compute type unsupported; using a compatible compute type"
        preferred = ("int8_float16", "int8", "float16", "float32") if device == "cuda" else ("int8", "int8_float32", "float32")
        compute = next((value for value in preferred if value in supported), None)
        if compute is None:
            raise RuntimeError("No compatible CTranslate2 compute type")
    return device, compute, warning


class Engine:
    def __init__(self):
        self.dll_handles = register_cuda_libraries()
        import ctranslate2
        from faster_whisper import WhisperModel
        self.ct2, self.model_class = ctranslate2, WhisperModel
        self.model = None
        self.key = None
        self.requested_key = None
        self.loads = 0
        self.hardware = {}

    def initialize(self, path, config):
        path = str(Path(path).resolve())
        validate_model(path)
        key = (path, config.get("device", "auto"), config.get("computeType", "auto"))
        if self.model is not None and self.requested_key == key:
            return self.hardware
        device, compute, warning = resolve_hardware(config, self.ct2)
        if self.model is not None:
            self.model = None
            gc.collect()
        started = time.monotonic()
        try:
            self.model = self.model_class(path, device=device, compute_type=compute,
                                          cpu_threads=4, num_workers=1, local_files_only=True)
        except Exception:
            if device != "cuda":
                raise
            device, compute = "cpu", "int8"
            warning = "CUDA model initialization failed; using CPU INT8"
            self.model = self.model_class(path, device=device, compute_type=compute,
                                          cpu_threads=4, num_workers=1, local_files_only=True)
        self.loads += 1
        self.key, self.requested_key = (path, device, compute), key
        self.hardware = {"device": device, "compute_type": compute, "model_loads": self.loads,
                         "load_seconds": round(time.monotonic() - started, 3), "warning": warning}
        log("model_ready", **self.hardware)
        return self.hardware

    def transcribe(self, request):
        import numpy as np
        config = request.get("config", {})
        self.initialize(request["model_path"], config)
        if request.get("op") == "initialize":
            return {"hardware": self.hardware}
        if "path" in request:
            from faster_whisper.audio import decode_audio
            audio = decode_audio(request["path"], sampling_rate=16000)
        else:
            raw = base64.b64decode(request.get("pcm16", ""), validate=True)
            if len(raw) > 16000 * 2 * 31 or len(raw) % 2:
                raise ValueError("Invalid PCM16 audio packet")
            audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        started = time.monotonic()
        if len(audio) == 0 or float(np.mean(audio * audio)) < 1e-7:
            return {"segments": [], "language": None, "hardware": self.hardware, "seconds": 0.0}
        language = config.get("language", "auto")
        if language == "auto":
            language = None
        if language not in (None, "ru", "en"):
            raise ValueError("Unsupported language selection")
        quality = config.get("quality", "balanced")
        beams = {"fast": 1, "balanced": 3, "accurate": 5}
        if quality not in beams:
            raise ValueError("Unsupported quality selection")
        provisional = bool(request.get("provisional", False))
        options = dict(language=language, task="transcribe", beam_size=1 if provisional else beams[quality], temperature=0,
                       without_timestamps=provisional,
                       vad_filter=bool(config.get("vadFilter", True)),
                       vad_parameters=dict(min_speech_duration_ms=150, min_silence_duration_ms=400, speech_pad_ms=200),
                       condition_on_previous_text=False, no_speech_threshold=0.6,
                       compression_ratio_threshold=2.4, log_prob_threshold=-1.0,
                       hotwords=str(config.get("hotwords", ""))[:2000] or None)
        # faster-whisper 1.2.1 still detects a language on empty post-VAD audio.
        # That needlessly occupies the shared GPU on background-noise packets.
        # Reuse the same bundled VAD/options and timestamp restoration as the
        # upstream decoder, without running the VAD twice on actual speech.
        audio_seconds = len(audio) / 16000
        speech_chunks = None
        if options["vad_filter"]:
            from faster_whisper.vad import get_speech_timestamps, VadOptions, collect_chunks
            speech_chunks = get_speech_timestamps(audio, VadOptions(**options["vad_parameters"]))
            if not speech_chunks:
                seconds = time.monotonic() - started
                log("no_speech", audio_seconds=round(len(audio) / 16000, 3), seconds=round(seconds, 3),
                    segment_count=0, device=self.hardware["device"])
                return {"segments": [], "language": None, "seconds": seconds,
                        "audio_seconds": len(audio) / 16000, "hardware": self.hardware, "skipped_no_speech": True}
            chunks, _ = collect_chunks(audio, speech_chunks)
            audio = np.concatenate(chunks, axis=0)
            options["vad_filter"] = False
        try:
            segments, info = self.model.transcribe(audio, **options)
            segments = list(segments)  # Inference is lazy: consume before replying.
        except Exception:
            if self.hardware["device"] != "cuda":
                raise
            fallback = {**config, "device": "cpu", "computeType": "int8"}
            self.initialize(request["model_path"], fallback)
            self.requested_key = (str(Path(request["model_path"]).resolve()), config.get("device", "auto"), config.get("computeType", "auto"))
            self.hardware["warning"] = "CUDA inference failed; continued on CPU INT8"
            segments, info = self.model.transcribe(audio, **options)
            segments = list(segments)
        if speech_chunks:
            from faster_whisper.transcribe import restore_speech_timestamps
            segments = list(restore_speech_timestamps(segments, speech_chunks, 16000))
        result = [{"text": item.text.strip(), "start": item.start, "end": item.end,
                   "confidence": max(0.0, min(1.0, math.exp(item.avg_logprob)))}
                  for item in segments if item.text.strip() and reliable_segment(item)]
        seconds = time.monotonic() - started
        log("transcription", audio_seconds=round(audio_seconds, 3), seconds=round(seconds, 3),
            segment_count=len(result), language=info.language, device=self.hardware["device"])
        return {"segments": result, "language": info.language, "seconds": seconds,
                "audio_seconds": audio_seconds, "hardware": self.hardware}


def watch_parent(pid):
    if not pid or os.name != "nt":
        return
    import ctypes
    ctypes.windll.kernel32.OpenProcess.restype = ctypes.c_void_p
    ctypes.windll.kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    handle = ctypes.windll.kernel32.OpenProcess(0x100000, False, pid)
    if not handle:
        return
    while ctypes.windll.kernel32.WaitForSingleObject(handle, 1000) == 258:
        pass
    os._exit(0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent-pid", type=int, default=0)
    parser.add_argument("--download-model")
    parser.add_argument("--models-dir")
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    threading.Thread(target=watch_parent, args=(args.parent_pid,), daemon=True).start()
    if args.download_model:
        install_model(args.download_model, args.models_dir, lambda item: print(json.dumps(item)))
        return
    print(json.dumps({"event": "hello", "protocol": 1}))
    engine = None
    for line in sys.stdin:
        request_id = None
        try:
            if len(line) > 4 * 1024 * 1024:
                raise ValueError("Worker packet too large")
            request = json.loads(line)
            request_id = request.get("id")
            if request.get("op") == "shutdown":
                break
            if request.get("op") not in ("initialize", "transcribe"):
                raise ValueError("Unknown worker operation")
            if engine is None:
                engine = Engine()
            result = engine.transcribe(request)
            print(json.dumps({"id": request_id, "ok": True, **result}, ensure_ascii=False))
        except Exception as error:
            # Only bounded technical errors; never echo requests or microphone content.
            message = type(error).__name__ + ": " + str(error)[:400]
            log("error", error_type=type(error).__name__)
            print(json.dumps({"id": request_id, "ok": False, "error": message}, ensure_ascii=True))


if __name__ == "__main__":
    main()
