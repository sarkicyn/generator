//! Opt-in end-to-end inference check using synthetic Russian PCM, without devices or API keys.
//!
//! Set NEXQ_STT_MODEL_PATH to the extracted Russian Zipformer or Parakeet directory and
//! NEXQ_STT_WAV_PATH to the local-stt-tts.ps1 output. Run only this ignored test.

use nexq_lib::audio::{AudioChunk, AudioSource};
use nexq_lib::stt::ort_streaming::OrtStreamingSTT;
use nexq_lib::stt::provider::STTProvider;
use std::path::PathBuf;
use std::time::{Duration, Instant};

struct SmokeLogger;
static LOGGER: SmokeLogger = SmokeLogger;
impl log::Log for SmokeLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.target().starts_with("nexq_lib::stt")
            || metadata.target().starts_with("nexq_lib::ort_runtime")
    }
    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) { eprintln!("[{}] {}", record.level(), record.args()); }
    }
    fn flush(&self) {}
}

async fn recognize_synthetic_russian(model: PathBuf, wav: PathBuf) -> Result<String, String> {
    nexq_lib::ort_runtime::ensure_loaded()?;
    let mut reader = hound::WavReader::open(&wav)
        .map_err(|error| format!("Cannot open synthetic WAV {}: {error}", wav.display()))?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != 16_000 || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
    {
        return Err(format!("Expected mono PCM16 16 kHz; got {spec:?}"));
    }
    let samples: Vec<i16> = reader.samples::<i16>().collect::<Result<_, _>>()
        .map_err(|error| format!("Cannot decode synthetic PCM: {error}"))?;
    if !(32_000..=320_000).contains(&samples.len()) {
        return Err("The synthetic smoke-test WAV must last between 2 and 20 seconds".into());
    }

    let mut provider = OrtStreamingSTT::new(model);
    provider.set_language("ru-RU");
    let (results_tx, mut results_rx) = tokio::sync::mpsc::channel(16);
    provider.start_stream(results_tx).await.map_err(|error| error.to_string())?;
    let started = Instant::now();
    for (index, frame) in samples.chunks(5_120).enumerate() {
        provider.feed_audio(AudioChunk {
            pcm_data: frame.to_vec(),
            source: AudioSource::Mic,
            timestamp_ms: index as u64 * 320,
            is_speech: frame.iter().any(|sample| sample.unsigned_abs() > 40),
        }).await.map_err(|error| error.to_string())?;
    }
    // Explicit trailing silence exercises pause-based finalization rather than stop flushing.
    for index in 0..4 {
        provider.feed_audio(AudioChunk {
            pcm_data: vec![0; 5_120],
            source: AudioSource::Mic,
            timestamp_ms: samples.len() as u64 * 1_000 / 16_000 + index * 320,
            is_speech: false,
        }).await.map_err(|error| error.to_string())?;
    }

    let transcript = tokio::time::timeout(Duration::from_secs(50), async {
        let mut text = String::new();
        while let Some(result) = results_rx.recv().await {
            if result.is_final {
                if result.language.as_deref() != Some("ru") {
                    return Err(format!("Expected Russian language tag, got {:?}", result.language));
                }
                text.push_str(&result.text);
                text.push(' ');
                let normalized = text.to_lowercase();
                let matches = ["распознав", "русск", "реч", "компьютер"]
                    .iter().filter(|word| normalized.contains(**word)).count();
                if matches >= 3 { return Ok(text.trim().to_owned()); }
            }
        }
        Err(format!("Inference ended without the expected Russian words: {text}"))
    }).await.map_err(|_| "No final Russian transcription within 50 seconds".to_owned())?;
    provider.stop_stream().await.map_err(|error| error.to_string())?;
    let transcript = transcript?;
    println!("Synthetic Russian inference completed in {:.2}s: {transcript}", started.elapsed().as_secs_f64());
    Ok(transcript)
}

#[test]
#[ignore = "requires local Russian ONNX model, synthetic Russian WAV, and bundled ONNX Runtime"]
fn local_ort_recognizes_synthetic_russian() {
    if log::set_logger(&LOGGER).is_ok() { log::set_max_level(log::LevelFilter::Info); }
    let model = PathBuf::from(std::env::var_os("NEXQ_STT_MODEL_PATH")
        .expect("Set NEXQ_STT_MODEL_PATH to the extracted Russian ONNX model directory"));
    let wav = PathBuf::from(std::env::var_os("NEXQ_STT_WAV_PATH")
        .expect("Set NEXQ_STT_WAV_PATH to local-stt-tts.ps1's WAV"));
    // Keep a hard wall-clock limit even if a native inference call or thread join blocks.
    let (completed_tx, completed_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
            .expect("create smoke-test async runtime");
        let result = runtime.block_on(recognize_synthetic_russian(model, wav));
        let _ = completed_tx.send(result);
    });
    let transcript = completed_rx.recv_timeout(Duration::from_secs(60))
        .expect("Local Russian STT smoke test failed to finish within 60 seconds")
        .expect("Local Russian STT inference failed");
    assert!(transcript.chars().any(|character| ('а'..='я').contains(&character)),
        "Expected Cyrillic Russian transcript, got {transcript:?}");
}
