//! Opt-in real-time replay of synthetic fixtures. No devices, meetings, or network.
use nexq_lib::audio::{AudioChunk, AudioSource};
use nexq_lib::stt::faster_whisper::{self, Config, FasterWhisperSTT};
use nexq_lib::stt::provider::STTProvider;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tokio::sync::mpsc;

static TIMINGS: Mutex<Vec<Value>> = Mutex::new(Vec::new());
struct TimingLogger;
impl log::Log for TimingLogger {
    fn enabled(&self, m: &log::Metadata<'_>) -> bool { m.target() == "nexq_stt_timing" }
    fn log(&self, r: &log::Record<'_>) {
        if self.enabled(r.metadata()) {
            if let Ok(value) = serde_json::from_str(&r.args().to_string()) { TIMINGS.lock().unwrap().push(value); }
        }
    }
    fn flush(&self) {}
}
static LOGGER: TimingLogger = TimingLogger;

fn wav(path: PathBuf) -> Vec<i16> {
    let mut reader = hound::WavReader::open(path).unwrap();
    assert_eq!((reader.spec().sample_rate, reader.spec().channels), (16000, 1));
    reader.samples::<i16>().collect::<Result<Vec<_>, _>>().unwrap()
}

async fn replay(name: &str, model: &PathBuf, sources: Vec<Vec<i16>>) -> Value {
    TIMINGS.lock().unwrap().clear();
    let (tx, mut rx) = mpsc::channel(256);
    let mut providers = Vec::new();
    for _ in &sources {
        let mut provider = FasterWhisperSTT::new(model.clone());
        provider.start_stream(tx.clone()).await.unwrap();
        providers.push(provider);
    }
    drop(tx);
    let started = Instant::now();
    let receiver = tokio::spawn(async move {
        let mut received = Vec::new();
        while let Some(result) = rx.recv().await {
            let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
            received.push(json!({"final":result.is_final, "received_ms":started.elapsed().as_millis(),
                "audio_start_ms":result.timestamp_ms, "duration_ms":result.duration_ms,
                "end_to_result_ms":now_ms.saturating_sub(result.timestamp_ms+result.duration_ms.unwrap_or(0)),
                "segment_id":result.segment_id, "text":result.text}));
        }
        received
    });
    let frames = sources.iter().map(|s| s.len().div_ceil(1600)).max().unwrap();
    let mut feed_ms = Vec::new();
    for frame in 0..frames {
        tokio::time::sleep_until((started + Duration::from_millis((frame*100) as u64)).into()).await;
        for (source, provider) in providers.iter_mut().enumerate() {
            let from = frame*1600;
            if from >= sources[source].len() { provider.on_idle().await.unwrap(); continue; }
            let samples = &sources[source][from..(from+1600).min(sources[source].len())];
            let before = Instant::now();
            provider.feed_audio(AudioChunk { pcm_data:samples.to_vec(), source:if source==0 {AudioSource::Mic} else {AudioSource::System},
                timestamp_ms:0, is_speech:true }).await.unwrap();
            feed_ms.push(before.elapsed().as_secs_f64()*1000.0);
        }
    }
    let input_done_ms = started.elapsed().as_millis();
    for provider in &mut providers { provider.stop_stream().await.unwrap(); }
    let received = receiver.await.unwrap();
    let first_provisional_ms = received.iter().find(|r| r["final"]==false).map(|r|r["received_ms"].clone());
    json!({"case":name,"input_done_ms":input_done_ms,"drained_ms":started.elapsed().as_millis(),
        "first_provisional_ms":first_provisional_ms,"max_feed_ms":feed_ms.into_iter().fold(0.0,f64::max),
        "received":received,"timings":TIMINGS.lock().unwrap().clone()})
}

#[tokio::test]
#[ignore = "requires bundled runtime, CUDA/CPU model and synthetic fixture paths; replays in real time"]
async fn synthetic_live_latency() {
    log::set_logger(&LOGGER).unwrap(); log::set_max_level(log::LevelFilter::Info);
    let model = PathBuf::from(std::env::var_os("NEXQ_FW_MODEL").unwrap());
    let fixtures = PathBuf::from(std::env::var_os("NEXQ_FW_FIXTURES").unwrap());
    let report = PathBuf::from(std::env::var_os("NEXQ_FW_REPORT").unwrap());
    faster_whisper::configure(Config { language:"ru".into(),quality:"accurate".into(),..Config::default() }).unwrap();
    let hardware = faster_whisper::initialize(model.clone()).await.unwrap()["hardware"].clone();
    let russian = wav(fixtures.join("asr-benchmark/phrase-1.wav"));
    let mixed = wav(fixtures.join("bilingual-heap-clear-trimmed.wav"));
    let mut cases = Vec::new();
    for (name, mut audio) in [("russian",russian.clone()),("mixed_technical",mixed.clone()),("silence",vec![0;48000])] {
        audio.extend(vec![0;16000]); cases.push(replay(name,&model,vec![audio]).await);
    }
    let mut continuous = russian.clone();
    continuous.extend(russian.clone()); continuous.extend(russian.clone()); continuous.extend(vec![0;16000]);
    cases.push(replay("continuous_speech",&model,vec![continuous]).await);
    let mut a = Vec::new(); let mut b = vec![0;16000*2];
    while a.len() < 16000*40 { a.extend(russian.clone()); a.extend(vec![0;16000]); }
    while b.len() < 16000*40 { b.extend(mixed.clone()); b.extend(vec![0;16000]); }
    a.truncate(16000*40); b.truncate(16000*40);
    a.extend(vec![0;16000]); b.extend(vec![0;16000]);
    cases.push(replay("simultaneous_sources",&model,vec![a,b]).await);
    let result=json!({"hardware":hardware,"quality":"accurate","language":"ru","synthetic_only":true,"cases":cases});
    std::fs::write(report,serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    assert!(result["cases"][0]["received"].as_array().unwrap().iter().any(|r|r["final"]==true));
    assert!(result["cases"][1]["received"].as_array().unwrap().iter().any(|r|r["final"]==true));
    assert!(result["cases"][2]["received"].as_array().unwrap().is_empty());
}
