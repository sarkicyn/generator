# Local transcription components

- faster-whisper 1.2.1: SYSTRAN, MIT; https://github.com/SYSTRAN/faster-whisper
- CTranslate2 4.6.0: OpenNMT, MIT; https://github.com/OpenNMT/CTranslate2
- Whisper model: OpenAI, MIT; https://github.com/openai/whisper
- INT8 conversion: voxta/faster-whisper-large-v3-turbo-int8 (copied from vokasug), MIT model card; https://huggingface.co/voxta/faster-whisper-large-v3-turbo-int8
- Silero VAD is supplied by faster-whisper; its upstream MIT notice is included with that package.
- Portable CPython includes its license in python/LICENSE.txt. Python dependency licenses remain inside packages/*dist-info; PyAV/FFmpeg notices are included in the PyAV distribution.
- Optional NVIDIA CUDA/cuBLAS/cuDNN runtime libraries retain their NVIDIA licenses in packages/nvidia*dist-info. They are used only on supported NVIDIA hardware. CPU inference does not require them.

Pinned package versions and hashes are recorded in requirements.lock and requirements-gpu.lock. Original MIT license texts are in licenses/.
