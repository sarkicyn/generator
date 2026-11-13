param(
    [switch]$SkipModel,
    [switch]$SkipGpuLibraries,
    [string]$ModelsDirectory = (Join-Path $env:APPDATA 'com.nexq.app\models\faster_whisper')
)
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
$workspace = Split-Path $repository -Parent
$runtimeRoot = Join-Path $repository 'runtime\faster-whisper'
$source = Join-Path $repository 'python\faster_whisper'
$pythonCache = Join-Path $workspace '.build-tools\python'
$env:UV_CACHE_DIR = Join-Path $workspace '.build-tools\uv-cache'
$python = Join-Path $runtimeRoot 'python\python.exe'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    uv python install 3.12.14 --install-dir $pythonCache --no-bin --no-registry
    if ($LASTEXITCODE -ne 0) { throw 'Portable Python installation failed' }
    $distribution = Get-ChildItem -LiteralPath $pythonCache -Directory -Filter 'cpython-3.12.14*' | Select-Object -First 1
    if (-not $distribution) { throw 'Portable Python distribution not found' }
    Copy-Item -LiteralPath $distribution.FullName -Destination (Join-Path $runtimeRoot 'python') -Recurse -Force
}
$withGpu = -not $SkipGpuLibraries -and [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
$lock = if ($withGpu) { 'requirements-gpu.lock' } else { 'requirements.lock' }
uv pip install --python $python --target (Join-Path $runtimeRoot 'packages') --require-hashes -r (Join-Path $source $lock)
if ($LASTEXITCODE -ne 0) { throw 'Faster Whisper dependencies could not be installed' }
foreach ($name in @('worker.py','models.py','requirements.lock','requirements-gpu.lock')) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $runtimeRoot $name) -Force
}
Copy-Item -LiteralPath (Join-Path $source 'licenses') -Destination $runtimeRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $source 'THIRD-PARTY-NOTICES.md') -Destination $runtimeRoot -Force
if (-not $SkipModel) {
    & $python -I -u (Join-Path $runtimeRoot 'worker.py') --download-model 'voxta/faster-whisper-large-v3-turbo-int8' --models-dir $ModelsDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Default Faster Whisper model installation failed' }
}
[pscustomobject]@{ Runtime=$runtimeRoot; DefaultModel='voxta/faster-whisper-large-v3-turbo-int8'; ModelsDirectory=$ModelsDirectory; GpuLibraries=$withGpu }
