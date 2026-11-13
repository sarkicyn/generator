//! Buffered, local faster-whisper provider. Both audio parties share one hidden
//! Python worker/model through a private stdio protocol; inference never runs
//! on a webview/UI thread and never downloads files.
use async_trait::async_trait;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock, RwLock, atomic::{AtomicBool, AtomicU64, Ordering}};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use super::provider::{STTProvider, STTProviderType, TranscriptResult};
use crate::audio::AudioChunk;

pub const DEFAULT_MODEL: &str = "voxta/faster-whisper-large-v3-turbo-int8";
const SAMPLE_RATE: usize = 16000;
static CPU_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub device: String,
    pub compute_type: String,
    pub language: String,
    pub quality: String,
    pub vad_filter: bool,
    pub hotwords: String,
}
impl Default for Config {
    fn default() -> Self {
        Self { device: "auto".into(), compute_type: "auto".into(), language: "auto".into(),
            quality: "balanced".into(), vad_filter: true, hotwords: String::new() }
    }
}
impl Config {
    pub fn validate(&self) -> Result<(), String> {
        if !["auto", "cpu", "cuda"].contains(&self.device.as_str())
            || !["auto", "int8", "int8_float16", "float16", "float32"].contains(&self.compute_type.as_str())
            || !["auto", "ru", "en"].contains(&self.language.as_str())
            || !["fast", "balanced", "accurate"].contains(&self.quality.as_str())
            || self.hotwords.chars().count() > 2000 {
            return Err("Некорректные настройки Faster Whisper".into());
        }
        Ok(())
    }
}
fn settings() -> &'static RwLock<Config> {
    static SETTINGS: OnceLock<RwLock<Config>> = OnceLock::new();
    SETTINGS.get_or_init(|| RwLock::new(Config::default()))
}
pub fn configure(config: Config) -> Result<(), String> {
    config.validate()?;
    *settings().write().map_err(|_| "Faster Whisper settings lock")? = config;
    Ok(())
}
fn current_config() -> Config { settings().read().map(|c| c.clone()).unwrap_or_default() }

pub fn runtime_dir() -> Result<PathBuf, String> {
    let sibling = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.join("runtime/faster-whisper")));
    let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime/faster-whisper");
    for root in sibling.into_iter().chain(std::iter::once(development)) {
        if root.join("python/python.exe").is_file() && root.join("worker.py").is_file() && root.join("packages/faster_whisper").is_dir() {
            return Ok(root);
        }
    }
    Err("Среда Faster Whisper не установлена. Запустите scripts/setup-faster-whisper.ps1 и повторите сборку.".into())
}
pub fn model_ready(path: &Path) -> bool {
    let manifest = std::fs::read(path.join("MODEL-MANIFEST.json")).ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    manifest.as_ref().and_then(|v| v["complete"].as_bool()) == Some(true)
        && ["model.bin", "config.json", "tokenizer.json", "preprocessor_config.json", "vocabulary.json"]
            .iter().all(|name| path.join(name).metadata().map(|m| m.is_file() && m.len() > 0).unwrap_or(false))
}
fn command(root: &Path) -> Command {
    let mut command = Command::new(root.join("python/python.exe"));
    command.args(["-I", "-u"]).arg(root.join("worker.py"));
    command.env("HF_HUB_OFFLINE", "1").env("TRANSFORMERS_OFFLINE", "1").env("PYTHONUTF8", "1");
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}
struct PythonWorker {
    child: Child,
    input: ChildStdin,
    replies: std::sync::mpsc::Receiver<Result<Value, String>>,
}
impl Drop for PythonWorker {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}
fn drain_diagnostics(stderr: impl std::io::Read + Send + 'static) {
    std::thread::spawn(move || {
        // Native libraries may emit diagnostics in a Windows code page. Keep
        // draining those bytes; closing stderr can kill an otherwise healthy worker.
        for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                let mut safe = serde_json::Map::new();
                for key in ["event", "device", "compute_type", "model_loads", "load_seconds", "seconds", "audio_seconds", "segment_count", "language", "warning", "error_type"] {
                    if let Some(item) = value.get(key) { safe.insert(key.into(), item.clone()); }
                }
                log::info!("[faster_whisper] {}", Value::Object(safe));
            }
        }
    });
}
impl PythonWorker {
    fn start() -> Result<Self, String> {
        let root = runtime_dir()?;
        let mut child = command(&root).args(["--parent-pid", &std::process::id().to_string()])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
            .map_err(|e| format!("Не удалось запустить Faster Whisper: {e}"))?;
        let input = child.stdin.take().ok_or("Worker stdin missing")?;
        let stdout = child.stdout.take().ok_or("Worker stdout missing")?;
        if let Some(stderr) = child.stderr.take() { drain_diagnostics(stderr); }
        let (tx, replies) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let value = line.map_err(|_| "process: worker output closed".to_string())
                    .and_then(|line| if line.len() > 8 * 1024 * 1024 { Err("process: oversized worker reply".into()) }
                        else { serde_json::from_str(&line).map_err(|_| "process: invalid worker reply".into()) });
                if tx.send(value).is_err() { break; }
            }
        });
        let worker = Self { child, input, replies };
        let hello = worker.replies.recv_timeout(Duration::from_secs(30)).map_err(|_| "process: worker startup timed out")??;
        if hello["protocol"].as_i64() != Some(1) { return Err("process: unsupported worker protocol".into()); }
        Ok(worker)
    }
    fn request(&mut self, mut request: Value) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        request["id"] = json!(id);
        serde_json::to_writer(&mut self.input, &request).map_err(|_| "process: worker input closed")?;
        self.input.write_all(b"\n").and_then(|_| self.input.flush()).map_err(|_| "process: worker input closed")?;
        let response = self.replies.recv_timeout(Duration::from_secs(180)).map_err(|_| "process: worker closed or timed out")??;
        if response["id"].as_str() != Some(&id) { return Err("process: mismatched worker response".into()); }
        if response["ok"].as_bool() != Some(true) {
            return Err(response["error"].as_str().unwrap_or("Ошибка Faster Whisper").to_owned());
        }
        Ok(response)
    }
}
fn broker(request: Value) -> Result<Value, String> {
    static WORKER: OnceLock<Mutex<Option<PythonWorker>>> = OnceLock::new();
    let waiting = Instant::now();
    let mut worker = WORKER.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Faster Whisper worker lock")?;
    let broker_wait_ms = waiting.elapsed().as_secs_f64() * 1000.0;
    if worker.is_none() { *worker = Some(PythonWorker::start()?); }
    let result = match worker.as_mut().unwrap().request(request.clone()) {
        Err(error) if error.starts_with("process:") => {
            *worker = None;
            log::warn!("[faster_whisper] Worker restarted with CPU fallback after process failure");
            let mut fallback = request;
            fallback["config"]["device"] = json!("cpu");
            fallback["config"]["computeType"] = json!("int8");
            *worker = Some(PythonWorker::start()?);
            let result = worker.as_mut().unwrap().request(fallback);
            if result.is_ok() { CPU_ACTIVE.store(true, Ordering::SeqCst); }
            result
        }
        Ok(value) => {
            CPU_ACTIVE.store(value["hardware"]["device"].as_str() == Some("cpu"), Ordering::SeqCst);
            Ok(value)
        }
        Err(error) => Err(error),
    };
    result.map(|mut value| { value["broker_wait_ms"] = json!(broker_wait_ms); value })
}
pub async fn initialize(model_path: PathBuf) -> Result<Value, String> {
    let permit = inference_gate().clone().acquire_owned().await.map_err(|_| "Faster Whisper gate closed")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        broker(json!({"op":"initialize", "model_path":model_path, "config":current_config()}))
    })
        .await.map_err(|_| "Faster Whisper initialization task failed")?
}

fn inference_gate() -> &'static Arc<Semaphore> {
    static GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(Semaphore::new(1)))
}

#[tauri::command]
pub fn update_faster_whisper_config(config: Config) -> Result<(), String> { configure(config) }

#[tauri::command]
pub async fn get_faster_whisper_status(app: AppHandle, model_id: Option<String>) -> Result<Value, String> {
    let id = model_id.as_deref().unwrap_or(DEFAULT_MODEL);
    let def = super::local_engines::model_registry::get_model("faster_whisper", id).ok_or("Неизвестная модель Faster Whisper")?;
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models/faster_whisper").join(def.filename);
    if !model_ready(&path) { return Err("Модель Faster Whisper не скачана или установка не завершена".into()); }
    let result = initialize(path).await?;
    Ok(result["hardware"].clone())
}

pub fn download_model(models_root: PathBuf, model_id: String, cancel: Arc<AtomicBool>, app: AppHandle) -> Result<(), String> {
    let root = runtime_dir()?;
    std::thread::spawn(move || {
        let emit = |status: &str, percent: f64| {
            let _ = app.emit("model_download_progress", json!({"engine":"faster_whisper", "model_id":model_id,
                "downloaded_bytes":0, "total_bytes":0, "percent":percent, "status":status}));
        };
        let result = (|| -> Result<(), String> {
            let mut child = command(&root).args(["--parent-pid", &std::process::id().to_string()]).arg("--download-model").arg(&model_id).arg("--models-dir").arg(models_root)
                .env("HF_HUB_OFFLINE", "0").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped())
                .spawn().map_err(|e| e.to_string())?;
            if let Some(stderr) = child.stderr.take() { drain_diagnostics(stderr); }
            emit("downloading", 0.0);
            loop {
                if cancel.load(Ordering::SeqCst) { let _ = child.kill(); let _ = child.wait(); emit("cancelled", 0.0); return Ok(()); }
                if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                    if !status.success() { return Err("Не удалось скачать модель Faster Whisper. Проверьте подключение и повторите.".into()); }
                    emit("complete", 100.0); return Ok(());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        })();
        if let Err(error) = result { log::error!("[faster_whisper] download: {error}"); emit("error", 0.0); }
        cancel.store(true, Ordering::SeqCst);
    });
    Ok(())
}

#[derive(Default)]
struct Buffer {
    samples: Vec<i16>,
    start_ms: u64,
    silence: usize,
    heard: bool,
    last_partial: usize,
}
impl Buffer {
    fn partial_due(&self) -> bool {
        self.heard && self.samples.len().saturating_sub(self.last_partial) >=
            SAMPLE_RATE * if self.last_partial == 0 { 2 } else { 4 }
    }
    #[cfg(test)]
    fn push(&mut self, audio: &[i16]) -> bool {
        self.push_at(audio, SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64)
    }
    fn push_at(&mut self, audio: &[i16], captured_ms: u64) -> bool {
        if self.samples.is_empty() {
            self.start_ms = captured_ms.saturating_sub(audio.len() as u64 * 1000 / SAMPLE_RATE as u64);
        }
        for frame in audio.chunks(160) {
            let speech = frame.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum::<f64>() / frame.len() as f64 >= 1e-6;
            self.heard |= speech;
            self.silence = if speech { 0 } else { self.silence + frame.len() };
            self.samples.extend(frame);
        }
        if !self.heard && self.samples.len() > 4000 {
            let removed = self.samples.len() - 4000;
            self.samples.drain(..removed);
            self.start_ms += removed as u64 * 1000 / SAMPLE_RATE as u64;
        }
        self.heard && ((self.silence >= 11200 && self.samples.len() >= 8000) || self.samples.len() >= SAMPLE_RATE * 20)
    }
}
struct Job { samples: Vec<i16>, start_ms: u64, utterance: u64, final_result: bool, queued_at: Instant }
impl Job {
    fn obsolete(&self, stopping: bool, final_queued: u64) -> bool {
        !self.final_result && (stopping || final_queued >= self.utterance)
    }
}

/// Final audio is FIFO/backpressured. Only the newest speculative snapshot is
/// retained; receiving a final or a newer snapshot cancels its admission wait.
struct JobQueue {
    finals: mpsc::Receiver<Arc<Job>>,
    partials: watch::Receiver<Option<Arc<Job>>>,
    pending_partial: Option<Arc<Job>>,
    partials_open: bool,
}
impl JobQueue {
    async fn next(&mut self, gate: &Arc<Semaphore>) -> Option<(Arc<Job>, OwnedSemaphorePermit)> {
        loop {
            tokio::select! {
                biased;
                next = self.finals.recv() => {
                    let job = next?;
                    if self.pending_partial.as_ref().is_some_and(|p| p.utterance <= job.utterance) {
                        self.pending_partial = None;
                    }
                    return Some((job, gate.clone().acquire_owned().await.ok()?));
                }
                changed = self.partials.changed(), if self.partials_open => {
                    self.partials_open = changed.is_ok();
                    self.pending_partial = if self.partials_open { self.partials.borrow_and_update().clone() } else { None };
                }
                permit = gate.clone().acquire_owned(), if self.pending_partial.is_some() => {
                    return Some((self.pending_partial.take()?, permit.ok()?));
                }
            }
        }
    }
}
pub struct FasterWhisperSTT {
    model_path: PathBuf,
    app: Option<AppHandle>,
    buffer: Buffer,
    utterance: u64,
    stream_id: String,
    jobs: Option<mpsc::Sender<Arc<Job>>>,
    partials: Option<watch::Sender<Option<Arc<Job>>>>,
    task: Option<tokio::task::JoinHandle<()>>,
    stopping: Arc<AtomicBool>,
    discard: Arc<AtomicBool>,
    final_queued: Arc<AtomicU64>,
    last_audio: Option<Instant>,
}
impl FasterWhisperSTT {
    pub fn new(model_path: PathBuf) -> Self {
        Self { model_path, app: None, buffer: Buffer::default(), utterance: 1, stream_id: uuid::Uuid::new_v4().to_string(),
            jobs: None, partials: None, task: None, stopping: Arc::new(AtomicBool::new(false)), discard: Arc::new(AtomicBool::new(false)),
            final_queued: Arc::new(AtomicU64::new(0)), last_audio:None }
    }
    pub fn set_app_handle(&mut self, app: AppHandle) { self.app = Some(app); }
    async fn finish_buffer(&mut self) -> Result<(), String> {
        let buffer = std::mem::take(&mut self.buffer);
        if buffer.heard && !buffer.samples.is_empty() {
            self.final_queued.store(self.utterance, Ordering::SeqCst);
            if let Some(partials) = &self.partials { partials.send_replace(None); }
            let job = Arc::new(Job { samples: buffer.samples, start_ms: buffer.start_ms, utterance: self.utterance, final_result: true, queued_at: Instant::now() });
            self.utterance += 1;
            if let Some(tx) = &self.jobs { tx.send(job).await.map_err(|_| "Faster Whisper worker stopped")?; }
        }
        Ok(())
    }
}
#[async_trait]
impl STTProvider for FasterWhisperSTT {
    fn provider_name(&self) -> &str { "Faster Whisper" }
    fn provider_type(&self) -> STTProviderType { STTProviderType::FasterWhisper }
    async fn start_stream(&mut self, result_tx: mpsc::Sender<TranscriptResult>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        runtime_dir()?;
        if !model_ready(&self.model_path) { return Err("Модель Faster Whisper не установлена или повреждена".into()); }
        if self.jobs.is_some() { return Err("Faster Whisper is already running".into()); }
        // Warm once off the UI thread and resolve CPU/GPU before scheduling
        // speculative passes. CPU mode avoids expensive duplicate inference.
        let status = initialize(self.model_path.clone()).await?;
        CPU_ACTIVE.store(status["hardware"]["device"].as_str() == Some("cpu"), Ordering::SeqCst);
        self.stopping.store(false, Ordering::SeqCst); self.discard.store(false, Ordering::SeqCst);
        let (tx, finals) = mpsc::channel::<Arc<Job>>(3);
        let (partial_tx, partials) = watch::channel(None);
        self.jobs = Some(tx);
        self.partials = Some(partial_tx);
        let mut queue = JobQueue { finals, partials, pending_partial: None, partials_open: true };
        let (model, app, stream_id) = (self.model_path.clone(), self.app.clone(), self.stream_id.clone());
        let (stopping, discard, final_queued) = (self.stopping.clone(), self.discard.clone(), self.final_queued.clone());
        self.task = Some(tokio::spawn(async move {
            while let Some((job, permit)) = queue.next(inference_gate()).await {
                if discard.load(Ordering::SeqCst) { break; }
                if job.obsolete(stopping.load(Ordering::SeqCst), final_queued.load(Ordering::SeqCst))
                    || (!job.final_result && CPU_ACTIVE.load(Ordering::SeqCst)) { continue; }
                let mut bytes = Vec::with_capacity(job.samples.len() * 2);
                for sample in &job.samples { bytes.extend_from_slice(&sample.to_le_bytes()); }
                let request = json!({"op":"transcribe", "model_path":model, "config":current_config(), "provisional":!job.final_result,
                    "pcm16":base64::engine::general_purpose::STANDARD.encode(bytes)});
                let (decode_job, decode_stopping, decode_discard, decode_final) =
                    (job.clone(), stopping.clone(), discard.clone(), final_queued.clone());
                let result = tokio::task::spawn_blocking(move || {
                    // Keep admission owned by the actual blocking call even if
                    // its async consumer is cancelled during shutdown.
                    let _permit = permit;
                    if decode_discard.load(Ordering::SeqCst)
                        || decode_job.obsolete(decode_stopping.load(Ordering::SeqCst), decode_final.load(Ordering::SeqCst)) {
                        return Ok(None);
                    }
                    broker(request).map(Some)
                }).await;
                match result {
                    Ok(Ok(Some(value))) if !discard.load(Ordering::SeqCst) => {
                        let inference_ms = value["seconds"].as_f64().unwrap_or(0.0) * 1000.0;
                        log::info!(target: "nexq_stt_timing", "{}", json!({
                            "event":"decode_timing", "final":job.final_result,
                            "audio_ms":job.samples.len() * 1000 / SAMPLE_RATE,
                            "queue_ms":(job.queued_at.elapsed().as_secs_f64()*1000.0-inference_ms).max(0.0),
                            "broker_wait_ms":value["broker_wait_ms"], "inference_ms":inference_ms,
                            "device":value["hardware"]["device"]
                        }));
                        if !job.final_result && final_queued.load(Ordering::SeqCst) >= job.utterance { continue; }
                        let pieces = value["segments"].as_array().cloned().unwrap_or_default();
                        let text = pieces.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(" ");
                        if text.trim().is_empty() { continue; }
                        let confidence = pieces.iter().filter_map(|p| p["confidence"].as_f64()).sum::<f64>() / pieces.len().max(1) as f64;
                        let result = TranscriptResult { text, is_final: job.final_result, confidence: confidence as f32,
                            timestamp_ms:job.start_ms, speaker:None, language:value["language"].as_str().map(str::to_owned),
                            segment_id:Some(format!("fw_{stream_id}_{}", job.utterance)), duration_ms:Some(job.samples.len() as u64 * 1000 / SAMPLE_RATE as u64), speaker_tag:None };
                        let delivery = Instant::now();
                        if result_tx.send(result).await.is_err() { break; }
                        log::info!(target: "nexq_stt_timing", "{}", json!({"event":"delivery_timing",
                            "final":job.final_result,"delivery_ms":delivery.elapsed().as_secs_f64()*1000.0}));
                    }
                    Ok(Err(error)) => {
                        log::error!("[faster_whisper] {error}");
                        if let Some(app) = &app { super::emit_stt_debug(app, "error", "faster_whisper", &error); }
                    }
                    Err(_) => { log::error!("[faster_whisper] inference task failed"); }
                    _ => {}
                }
            }
        }));
        Ok(())
    }
    async fn feed_audio(&mut self, chunk: AudioChunk) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.jobs.is_none() || chunk.pcm_data.is_empty() { return Ok(()); }
        self.on_idle().await?;
        self.last_audio = Some(Instant::now());
        let captured_ms = if chunk.timestamp_ms > 0 { chunk.timestamp_ms } else {
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
        };
        if self.buffer.push_at(&chunk.pcm_data, captured_ms) { self.finish_buffer().await?; }
        else if !CPU_ACTIVE.load(Ordering::SeqCst) && current_config().device != "cpu"
            && self.buffer.partial_due() {
            if let Some(tx) = &self.partials {
                tx.send_replace(Some(Arc::new(Job { samples:self.buffer.samples.clone(), start_ms:self.buffer.start_ms,
                    utterance:self.utterance, final_result:false, queued_at:Instant::now() })));
                self.buffer.last_partial = self.buffer.samples.len();
            }
        }
        Ok(())
    }
    async fn on_idle(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // WASAPI loopback can stop callbacks entirely at the end of playback.
        // Packet absence is a pause too; do not wait for the next utterance.
        if self.buffer.heard && self.last_audio.is_some_and(|at| at.elapsed() >= Duration::from_millis(700)) {
            self.finish_buffer().await?;
        }
        Ok(())
    }
    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.stopping.store(true, Ordering::SeqCst);
        match tokio::time::timeout(Duration::from_secs(5), self.finish_buffer()).await {
            Ok(result) => result?,
            Err(_) => {
                self.discard.store(true, Ordering::SeqCst);
                self.jobs = None;
                self.partials = None;
                if let Some(task) = self.task.take() { task.abort(); }
                return Err("Очередь Faster Whisper переполнена. Попробуйте режим «Быстро» или GPU.".into());
            }
        }
        self.jobs = None;
        self.partials = None;
        if let Some(mut task) = self.task.take() {
            if tokio::time::timeout(Duration::from_secs(30), &mut task).await.is_err() {
                self.discard.store(true, Ordering::SeqCst); task.abort();
                return Err("Faster Whisper не успел завершить обработку за 30 секунд. Попробуйте режим «Быстро» или GPU.".into());
            }
        }
        Ok(())
    }
    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        initialize(self.model_path.clone()).await?; Ok(true)
    }
    fn set_language(&mut self, _language: &str) { /* Dedicated auto/ru/en setting is read for each inference. */ }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job(utterance: u64, final_result: bool, samples: usize) -> Arc<Job> {
        Arc::new(Job { samples:vec![1000;samples],start_ms:utterance*1000,utterance,final_result,queued_at:Instant::now() })
    }
    fn queue_fixture() -> (mpsc::Sender<Arc<Job>>, watch::Sender<Option<Arc<Job>>>, JobQueue) {
        let (tx, finals)=mpsc::channel(3); let (partial_tx, partials)=watch::channel(None);
        (tx,partial_tx,JobQueue { finals,partials,pending_partial:None,partials_open:true })
    }
    #[tokio::test]
    async fn waiting_partial_is_replaced_by_final_before_admission() {
        let gate=Arc::new(Semaphore::new(1)); let busy=gate.clone().acquire_owned().await.unwrap();
        let (tx,partial_tx,mut queue)=queue_fixture();
        partial_tx.send_replace(Some(job(1,false,2)));
        {
            let mut next=Box::pin(queue.next(&gate));
            assert!(futures::poll!(next.as_mut()).is_pending());
            // The final arrives while a speculative pass is waiting for the
            // other audio source. That obsolete pass must never be decoded.
            tx.send(job(1,true,8)).await.unwrap(); partial_tx.send_replace(None);
            assert!(futures::poll!(next.as_mut()).is_pending());
            drop(busy);
            let (final_job,permit)=next.await.unwrap();
            assert!(final_job.final_result); assert_eq!(final_job.samples.len(),8); drop(permit);
        }
        partial_tx.send_replace(Some(job(2,false,2)));
        let (next,permit)=queue.next(&gate).await.unwrap(); assert_eq!(next.utterance,2); drop(permit);
    }
    #[tokio::test]
    async fn continuous_speech_retains_only_the_latest_pending_snapshot() {
        let gate=Arc::new(Semaphore::new(1)); let busy=gate.clone().acquire_owned().await.unwrap();
        let (_tx,partial_tx,mut queue)=queue_fixture();
        partial_tx.send_replace(Some(job(1,false,2)));
        let mut next=Box::pin(queue.next(&gate));
        assert!(futures::poll!(next.as_mut()).is_pending());
        for size in [6,10,14,18] { partial_tx.send_replace(Some(job(1,false,size))); }
        assert!(futures::poll!(next.as_mut()).is_pending());
        drop(busy);
        let (latest,_permit)=next.await.unwrap(); assert_eq!(latest.samples.len(),18);
    }
    #[tokio::test]
    async fn final_audio_drains_fifo_before_speculation_on_close() {
        let gate=Arc::new(Semaphore::new(1)); let (tx,partial_tx,mut queue)=queue_fixture();
        partial_tx.send_replace(Some(job(3,false,2)));
        for id in 1..=3 { tx.send(job(id,true,id as usize*10)).await.unwrap(); }
        drop(tx); drop(partial_tx);
        for id in 1..=3 {
            let (final_job,_permit)=queue.next(&gate).await.unwrap();
            assert!(final_job.final_result); assert_eq!(final_job.utterance,id);
            assert_eq!(final_job.samples.len(),id as usize*10); assert_eq!(final_job.start_ms,id*1000);
        }
        assert!(queue.next(&gate).await.is_none());
    }
    #[tokio::test]
    async fn two_sources_share_admission_without_final_request_barging() {
        let gate=Arc::new(Semaphore::new(1)); let busy=gate.clone().acquire_owned().await.unwrap();
        let (a_tx,_a_partial,mut a)=queue_fixture(); let (b_tx,_b_partial,mut b)=queue_fixture();
        a_tx.send(job(1,true,10)).await.unwrap(); b_tx.send(job(1,true,20)).await.unwrap();
        let mut a_next=Box::pin(a.next(&gate)); let mut b_next=Box::pin(b.next(&gate));
        assert!(futures::poll!(a_next.as_mut()).is_pending()); assert!(futures::poll!(b_next.as_mut()).is_pending());
        drop(busy);
        let (a_job,a_permit)=a_next.await.unwrap(); assert_eq!(a_job.samples.len(),10);
        assert!(futures::poll!(b_next.as_mut()).is_pending()); assert!(gate.try_acquire().is_err());
        drop(a_permit); let (b_job,_permit)=b_next.await.unwrap(); assert_eq!(b_job.samples.len(),20);
    }
    #[test]
    fn admitted_speculation_is_rechecked_after_finalization_and_shutdown() {
        assert!(job(1,false,2).obsolete(false,1)); assert!(job(2,false,2).obsolete(true,1));
        assert!(!job(2,false,2).obsolete(false,1)); assert!(!job(1,true,8).obsolete(true,2));
    }
    #[test]
    fn capture_timestamp_is_preserved_even_when_ingestion_is_delayed() {
        let mut buffer=Buffer::default(); buffer.push_at(&vec![1000;SAMPLE_RATE],1_000_000);
        assert_eq!(buffer.start_ms,999_000);
        buffer.push_at(&vec![1000;1600],1_010_000); assert_eq!(buffer.start_ms,999_000);
    }
    #[test]
    fn first_partial_arrives_at_two_seconds_then_keeps_the_previous_work_budget() {
        let mut buffer=Buffer::default();
        buffer.push(&vec![1000; SAMPLE_RATE*2-160]); assert!(!buffer.partial_due());
        buffer.push(&vec![1000;160]); assert!(buffer.partial_due());
        buffer.last_partial=buffer.samples.len();
        buffer.push(&vec![1000; SAMPLE_RATE*4-160]); assert!(!buffer.partial_due());
        buffer.push(&vec![1000;160]); assert!(buffer.partial_due());
    }
    #[test]
    fn silence_is_bounded_and_a_pause_inside_a_packet_does_not_cut_resumed_speech() {
        let mut buffer = Buffer::default();
        assert!(!buffer.push(&vec![0; 160000]));
        assert_eq!(buffer.samples.len(), 4000);
        assert!(!buffer.push(&vec![1000; 8000]));
        assert!(!buffer.push(&vec![0; 11040]));
        let mut resumed = vec![0; 320]; resumed.extend(vec![1000; 4800]);
        assert!(!buffer.push(&resumed));
        assert!(buffer.push(&vec![0; 11200]));
    }
    #[test]
    fn settings_reject_invalid_hardware_and_keep_offline_defaults() {
        let defaults = Config::default(); assert!(defaults.validate().is_ok());
        assert_eq!(defaults.device, "auto"); assert_eq!(defaults.language, "auto");
        assert!(Config { device:"invalid".into(), ..defaults }.validate().is_err());
    }
    #[tokio::test]
    async fn missing_loopback_packets_finalize_once_and_keep_utterances_separate() {
        let mut provider = FasterWhisperSTT::new(PathBuf::new());
        let (tx, mut rx) = mpsc::channel(3); provider.jobs = Some(tx);
        provider.buffer.push(&vec![1000; 8000]);
        provider.last_audio = Some(Instant::now());
        provider.on_idle().await.unwrap();
        assert!(rx.try_recv().is_err());
        provider.last_audio = Some(Instant::now() - Duration::from_millis(701));
        provider.on_idle().await.unwrap();
        let first = rx.recv().await.unwrap();
        assert!(first.final_result); assert_eq!(first.utterance, 1);
        provider.on_idle().await.unwrap();
        assert!(rx.try_recv().is_err());
        provider.buffer.push(&vec![1000; 8000]);
        provider.last_audio = Some(Instant::now() - Duration::from_millis(701));
        provider.on_idle().await.unwrap();
        assert_eq!(rx.recv().await.unwrap().utterance, 2);
    }
    #[tokio::test]
    #[ignore = "requires the downloaded model and bundled Python runtime; uses real local audio"]
    async fn local_audio_runs_through_provider() {
        let model = std::env::var("NEXQ_FW_MODEL").expect("NEXQ_FW_MODEL");
        let wav = std::env::var("NEXQ_FW_WAV").expect("NEXQ_FW_WAV");
        let device = std::env::var("NEXQ_FW_DEVICE").unwrap_or_else(|_| "cpu".into());
        configure(Config { device, ..Config::default() }).unwrap();
        let samples = hound::WavReader::open(wav).unwrap().into_samples::<i16>().collect::<Result<Vec<_>,_>>().unwrap();
        let mut provider = FasterWhisperSTT::new(model.into());
        let (tx, mut rx) = mpsc::channel(256);
        provider.start_stream(tx).await.unwrap();
        for chunk in samples.chunks(1600) {
            provider.feed_audio(AudioChunk { pcm_data:chunk.to_vec(), source:crate::audio::AudioSource::System, timestamp_ms:0, is_speech:true }).await.unwrap();
        }
        provider.stop_stream().await.unwrap();
        let mut finals = Vec::new();
        while let Some(result) = rx.recv().await { if result.is_final { finals.push(result.text); } }
        assert!(!finals.is_empty());
        println!("{}", serde_json::to_string(&finals).unwrap());
    }
}
