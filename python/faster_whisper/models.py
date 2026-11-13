"""Explicit model installation; inference never downloads anything."""
import hashlib
import json
import os
from pathlib import Path

DEFAULT_MODEL = "voxta/faster-whisper-large-v3-turbo-int8"
PRIMARY_REVISION = "0af70a48d94da73866dd6e320c8830f8e57b9e11"
MODELS = {
    DEFAULT_MODEL: (DEFAULT_MODEL, "voxta-large-v3-turbo-int8", PRIMARY_REVISION),
    "large-v3-turbo": ("mobiuslabsgmbh/faster-whisper-large-v3-turbo", "large-v3-turbo", None),
    "large-v3": ("Systran/faster-whisper-large-v3", "large-v3", None),
}
REQUIRED_FILES = ("model.bin", "config.json", "tokenizer.json", "preprocessor_config.json", "vocabulary.json")


def model_spec(model_id):
    if model_id not in MODELS:
        raise ValueError("Unknown faster-whisper model")
    return MODELS[model_id]


def validate_model(path, hashes=False):
    path = Path(path)
    marker = path / "MODEL-MANIFEST.json"
    if not marker.is_file():
        raise ValueError("Model installation is incomplete: MODEL-MANIFEST.json is missing")
    manifest = json.loads(marker.read_text(encoding="utf-8"))
    if manifest.get("repo") not in {s[0] for s in MODELS.values()} or not manifest.get("complete"):
        raise ValueError("Invalid model installation manifest")
    files = {f["name"]: f for f in manifest["files"]}
    for name in REQUIRED_FILES:
        item = files.get(name)
        file = path / name
        if not item or not file.is_file() or file.stat().st_size != item["size"]:
            raise ValueError("Required model file is missing or incomplete: " + name)
        if hashes:
            digest = hashlib.sha256()
            with file.open("rb") as source:
                for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != item["sha256"]:
                raise ValueError("Model checksum mismatch: " + name)
    return manifest


def install_model(model_id, models_dir, progress):
    repo, folder, revision = model_spec(model_id)
    destination = Path(models_dir) / folder
    try:
        manifest = validate_model(destination, hashes=True)
        progress({"status": "complete", "cached": True, "bytes": sum(f["size"] for f in manifest["files"])})
        return destination
    except (ValueError, OSError, KeyError, json.JSONDecodeError):
        pass
    # This code path is called only by the explicit Download action/setup.
    os.environ["HF_HUB_OFFLINE"] = "0"
    from huggingface_hub import HfApi, snapshot_download
    api = HfApi(token=False)
    info = api.model_info(repo, revision=revision, files_metadata=True)
    progress({"status": "downloading", "cached": False})
    destination.mkdir(parents=True, exist_ok=True)
    snapshot_download(repo, revision=info.sha, local_dir=destination,
                      allow_patterns=list(REQUIRED_FILES) + ["README.md", "LICENSE*"], max_workers=4, token=False)
    items = []
    remote = {s.rfilename: s for s in info.siblings}
    for name in REQUIRED_FILES:
        file = destination / name
        entry = remote.get(name)
        if not entry or not file.is_file() or file.stat().st_size != entry.size:
            raise ValueError("Downloaded model file is incomplete: " + name)
        digest = hashlib.sha256()
        with file.open("rb") as source:
            for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
                digest.update(chunk)
        sha256 = digest.hexdigest()
        if entry.lfs and sha256 != entry.lfs.sha256:
            raise ValueError("Downloaded model checksum mismatch: " + name)
        items.append({"name": name, "size": file.stat().st_size, "sha256": sha256})
    manifest = {"repo": repo, "revision": info.sha, "complete": True, "files": items}
    temporary = destination / "MODEL-MANIFEST.json.tmp"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.replace(destination / "MODEL-MANIFEST.json")
    validate_model(destination)
    progress({"status": "complete", "cached": False, "bytes": sum(f["size"] for f in items)})
    return destination
