//! Offline Russian Zipformer transducers, kept separate from streaming/NeMo.
//!
//! Contract verified against alphacep/vosk-model-small-ru at
//! 4d68c4017bcfa44e2a79581f7933339e916a35da and sherpa-onnx's
//! offline-transducer-greedy-search-decoder.cc. Features follow the defaults in
//! sherpa-onnx/csrc/features.h and kaldi-native-fbank (Povey, reflect edges).
//! The larger alphacep/vosk-model-ru at df6a54a4d8e5d43e82675e4f5dba2d507731a0d1
//! has the same tensor/vocabulary contract and model_type=zipformer2.

use super::{AudioMessage, TranscriptResult, SAMPLE_RATE};
use ort::session::Session;
use ort::value::{TensorRef, ValueType};
use rustfft::{num_complex::Complex, FftPlanner};
use std::collections::HashMap;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const BINS: usize = 80;
const JOINER_DIM: usize = 512;
const VOCAB_SIZE: usize = 500;
const SILENCE_ENERGY: f64 = 1e-6;

/// Streaming Zipformer encoders have cache-state inputs; they must never enter
/// this offline path. NeMo is dispatched before this check by the caller.
pub(super) fn matches(encoder: &Session) -> bool {
    let Ok(metadata) = encoder.metadata() else { return false; };
    matches!(metadata.custom("model_type").as_deref(), Some("zipformer" | "zipformer2"))
        && metadata.custom("version").as_deref() == Some("1")
        && metadata.custom("model_author").as_deref() == Some("k2-fsa")
        && encoder.inputs().len() == 2
        && encoder.inputs()[0].name() == "x"
        && encoder.inputs()[1].name() == "x_lens"
        && encoder.outputs().len() == 2
        && encoder.outputs()[0].name() == "encoder_out"
        && encoder.outputs()[1].name() == "encoder_out_lens"
}

fn tensor_columns(value: &ValueType, rank: usize, columns: usize) -> bool {
    matches!(value, ValueType::Tensor { shape, .. }
        if shape.len() == rank && shape[0] != 0 && shape[rank - 1] == columns as i64)
}

fn validate(encoder: &Session, decoder: &Session, joiner: &Session, vocab: &HashMap<i64, String>) -> Result<(), String> {
    let metadata = decoder.metadata().map_err(|error| error.to_string())?;
    if !matches(encoder)
        || !tensor_columns(encoder.inputs()[0].dtype(), 3, BINS)
        || !tensor_columns(encoder.outputs()[0].dtype(), 3, JOINER_DIM)
        || metadata.custom("context_size").as_deref() != Some("2")
        || metadata.custom("vocab_size").as_deref() != Some("500")
        || decoder.inputs().len() != 1
        || decoder.inputs()[0].name() != "y"
        || !tensor_columns(decoder.inputs()[0].dtype(), 2, 2)
        || decoder.outputs().len() != 1
        || !tensor_columns(decoder.outputs()[0].dtype(), 2, JOINER_DIM)
        || joiner.inputs().len() != 2
        || joiner.inputs()[0].name() != "encoder_out"
        || joiner.inputs()[1].name() != "decoder_out"
        || !joiner.inputs().iter().all(|input| tensor_columns(input.dtype(), 2, JOINER_DIM))
        || joiner.outputs().len() != 1
        || !tensor_columns(joiner.outputs()[0].dtype(), 2, VOCAB_SIZE)
        // tokens.txt also contains #0/#1 disambiguation symbols at IDs 500/501;
        // only IDs 0..499 belong to the acoustic model's 500 logits.
        || !(0..VOCAB_SIZE as i64).all(|id| vocab.contains_key(&id))
        || vocab.get(&0).map(String::as_str) != Some("<blk>")
        || vocab.get(&2).map(String::as_str) != Some("<unk>")
    {
        return Err("Unsupported offline Russian Zipformer contract (expected v1, 80 features, 512 joiner, context 2, vocabulary 500)".into());
    }
    Ok(())
}

fn mel(hz: f32) -> f32 { 1127.0 * (1.0 + hz / 700.0).ln() }

struct Features {
    window: Vec<f32>,
    filters: Vec<Vec<f32>>,
    fft: Arc<dyn rustfft::Fft<f32>>,
}

impl Features {
    fn new() -> Self {
        let window = (0..400).map(|i| {
            (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / 399.0).cos()).powf(0.85) as f32
        }).collect();
        let low = mel(20.0);
        let delta = (mel(7600.0) - low) / (BINS + 1) as f32;
        let filters = (0..BINS).map(|m| {
            let left = low + m as f32 * delta;
            let center = low + (m + 1) as f32 * delta;
            let right = low + (m + 2) as f32 * delta;
            (0..256).map(|bin| {
                let frequency = mel(bin as f32 * 16000.0 / 512.0);
                if frequency <= left || frequency >= right { 0.0 }
                else if frequency <= center { (frequency - left) / (center - left) }
                else { (right - frequency) / (right - center) }
            }).collect()
        }).collect();
        Self { window, filters, fft: FftPlanner::new().plan_fft_forward(512) }
    }

    fn extract(&self, samples: &[f32]) -> (usize, Vec<f32>) {
        if samples.is_empty() { return (0, Vec::new()); }
        // Kaldi snip_edges=false: round to the nearest 10 ms, reflecting both ends.
        let frames = (samples.len() + 80) / 160;
        let mut features = Vec::with_capacity(frames * BINS);
        let mut spectrum = vec![Complex::new(0.0, 0.0); 512];
        let mut scratch = vec![Complex::new(0.0, 0.0); self.fft.get_inplace_scratch_len()];
        let mut wave = [0.0f32; 400];
        let mut power = [0.0f32; 256];
        for frame in 0..frames {
            let start = frame as isize * 160 - 120;
            for (offset, value) in wave.iter_mut().enumerate() {
                let mut index = start + offset as isize;
                while index < 0 || index >= samples.len() as isize {
                    index = if index < 0 { -index - 1 } else { 2 * samples.len() as isize - 1 - index };
                }
                *value = samples[index as usize];
            }
            let mean = wave.iter().sum::<f32>() / 400.0;
            for sample in &mut wave { *sample -= mean; }
            for i in (1..400).rev() { wave[i] -= 0.97 * wave[i - 1]; }
            wave[0] *= 0.03;
            spectrum.fill(Complex::new(0.0, 0.0));
            for i in 0..400 { spectrum[i].re = wave[i] * self.window[i]; }
            self.fft.process_with_scratch(&mut spectrum, &mut scratch);
            for (value, bin) in power.iter_mut().zip(&spectrum) { *value = bin.norm_sqr(); }
            for filter in &self.filters {
                let energy: f32 = filter.iter().zip(&power).map(|(weight, value)| weight * value).sum();
                features.push(energy.max(f32::EPSILON).ln());
            }
        }
        (frames, features)
    }
}

fn predict(decoder: &mut Session, history: &[i64; 2]) -> Result<Vec<f32>, String> {
    let input = TensorRef::from_array_view(([1, 2], &history[..])).map_err(|error| error.to_string())?;
    let outputs = decoder.run(ort::inputs![input]).map_err(|error| format!("Offline Zipformer decoder: {error}"))?;
    let (shape, values) = outputs[0].try_extract_tensor::<f32>().map_err(|error| error.to_string())?;
    if shape.as_ref() != [1, JOINER_DIM as i64] { return Err(format!("Unexpected offline decoder shape {shape:?}")); }
    Ok(values.to_vec())
}

fn recognize(encoder: &mut Session, decoder: &mut Session, joiner: &mut Session, features: &Features, samples: &[f32], vocab: &HashMap<i64, String>) -> Result<String, String> {
    let (frames, features) = features.extract(samples);
    if frames < 8 { return Ok(String::new()); }
    let lengths = [frames as i64];
    let input = TensorRef::from_array_view(([1, frames, BINS], &features[..])).map_err(|error| error.to_string())?;
    let input_lengths = TensorRef::from_array_view(([1], &lengths[..])).map_err(|error| error.to_string())?;
    let outputs = encoder.run(ort::inputs![input, input_lengths]).map_err(|error| format!("Offline Zipformer encoder: {error}"))?;
    let (shape, encoded) = outputs[0].try_extract_tensor::<f32>().map_err(|error| error.to_string())?;
    if shape.len() != 3 || shape[0] != 1 || shape[1] <= 0 || shape[2] != JOINER_DIM as i64 {
        return Err(format!("Unexpected offline encoder shape {shape:?}"));
    }
    let (_, lengths) = outputs[1].try_extract_tensor::<i64>().map_err(|error| error.to_string())?;
    let valid = *lengths.first().ok_or("Offline encoder did not return a valid length")?;
    if valid < 0 || valid > shape[1] { return Err(format!("Invalid offline encoder length {valid}")); }
    // sherpa-onnx's offline greedy search initializes missing context to -1, then blank=0.
    let mut history = [-1i64, 0];
    let mut prediction = predict(decoder, &history)?;
    let mut text = String::new();
    for frame in 0..valid as usize {
        let encoded = &encoded[frame * JOINER_DIM..(frame + 1) * JOINER_DIM];
        let encoder_input = TensorRef::from_array_view(([1, JOINER_DIM], encoded)).map_err(|error| error.to_string())?;
        let decoder_input = TensorRef::from_array_view(([1, JOINER_DIM], &prediction[..])).map_err(|error| error.to_string())?;
        let logits = joiner.run(ort::inputs![encoder_input, decoder_input]).map_err(|error| format!("Offline Zipformer joiner: {error}"))?;
        let (shape, values) = logits[0].try_extract_tensor::<f32>().map_err(|error| error.to_string())?;
        if shape.as_ref() != [1, VOCAB_SIZE as i64] || values.iter().any(|value| !value.is_finite()) {
            return Err(format!("Invalid offline joiner output {shape:?}"));
        }
        let token = values.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(id, _)| id).unwrap_or(0) as i64;
        // The reference greedy decoder emits at most one symbol per encoder frame.
        if token != 0 && token != 2 {
            let piece = vocab.get(&token).ok_or("Offline decoder returned an unknown token ID")?;
            if !piece.starts_with('<') { text.extend(piece.chars().map(|c| if c == '▁' { ' ' } else { c })); }
            history = [history[1], token];
            prediction = predict(decoder, &history)?;
        }
    }
    Ok(text.trim().to_owned())
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// Decide a pause boundary from the packet's trailing silence. A pause reached
/// early in a packet must not split a word that starts later in the same packet.
fn append_packet(samples: &mut Vec<f32>, silence: &mut usize, heard: &mut bool, audio: &[i16]) -> bool {
    for chunk in audio.chunks(160) {
        let energy = chunk.iter().map(|&sample| (sample as f64 / 32768.0).powi(2)).sum::<f64>() / chunk.len() as f64;
        let speech = energy >= SILENCE_ENERGY;
        *heard |= speech;
        *silence = if speech { 0 } else { *silence + chunk.len() };
        samples.extend(chunk.iter().map(|&sample| sample as f32 / 32768.0));
    }
    (*silence >= 12800 && samples.len() >= SAMPLE_RATE as usize)
        || samples.len() >= SAMPLE_RATE as usize * 20
}

pub(super) fn run(encoder: &mut Session, decoder: &mut Session, joiner: &mut Session, vocab: &HashMap<i64, String>, language: &str, stop: &AtomicBool, audio_rx: &std::sync::mpsc::Receiver<AudioMessage>, result_tx: &mpsc::Sender<TranscriptResult>, mut segment: u64, debug: &impl Fn(&str, &str)) -> Result<(), String> {
    validate(encoder, decoder, joiner, vocab)?;
    debug("info", "Offline Russian Zipformer: 80-bin Kaldi/Povey features, context [-1,0], 500 tokens, pause-based utterances");
    let features = Features::new();
    let mut samples = Vec::new();
    let mut silence = 0;
    let mut heard = false;
    let mut segment_start_ms = 0;
    let mut received = Instant::now();
    loop {
        let mut finished = false;
        let flush;
        let message = if stop.load(Ordering::SeqCst) { Ok(AudioMessage::Stop) }
            else { audio_rx.recv_timeout(Duration::from_millis(100)) };
        match message {
            Ok(AudioMessage::Samples(audio)) => {
                received = Instant::now();
                let chunk_start_ms = epoch_ms().saturating_sub(audio.len() as u64 * 1000 / SAMPLE_RATE as u64);
                if samples.is_empty() { segment_start_ms = chunk_start_ms; }
                flush = append_packet(&mut samples, &mut silence, &mut heard, &audio);
            }
            Ok(AudioMessage::Stop) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => { finished = true; flush = true; }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                finished = stop.load(Ordering::SeqCst);
                flush = finished || received.elapsed() >= Duration::from_millis(800);
            }
        }
        if flush && !samples.is_empty() {
            let text = if heard { recognize(encoder, decoder, joiner, &features, &samples, vocab)? } else { String::new() };
            let duration_ms = samples.len() as u64 * 1000 / SAMPLE_RATE as u64;
            samples.clear(); silence = 0; heard = false;
            if !text.is_empty() {
                result_tx.blocking_send(TranscriptResult {
                    text, is_final: true, confidence: 0.9, timestamp_ms: segment_start_ms,
                    speaker: None, language: Some(language.to_owned()), segment_id: Some(format!("ort_{segment}")),
                    duration_ms: Some(duration_ms), speaker_tag: None,
                }).map_err(|error| error.to_string())?;
                segment += 1;
            }
        }
        if finished { return Ok(()); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &str) -> Vec<String> {
        let normalized: String = text.to_lowercase().chars().map(|character| {
            if character == 'ё' { 'е' }
            else if character.is_alphanumeric() { character }
            else { ' ' }
        }).collect();
        normalized.split_whitespace().map(str::to_owned).collect()
    }

    fn word_errors(reference: &[String], transcript: &[String]) -> usize {
        let mut previous: Vec<usize> = (0..=transcript.len()).collect();
        let mut current = vec![0; transcript.len() + 1];
        for (row, expected) in reference.iter().enumerate() {
            current[0] = row + 1;
            for (column, actual) in transcript.iter().enumerate() {
                current[column + 1] = (previous[column + 1] + 1)
                    .min(current[column] + 1)
                    .min(previous[column] + usize::from(expected != actual));
            }
            std::mem::swap(&mut previous, &mut current);
        }
        previous[transcript.len()]
    }

    #[test]
    fn word_error_metric_normalizes_case_punctuation_and_counts_insertions() {
        assert_eq!(word_errors(&words("Ёж, пришёл."), &words("еж пришел")), 0);
        assert_eq!(word_errors(&words("рост продаж сегодня"), &words("рост больших продаж завтра")), 2);
    }

    #[test]
    fn kaldi_reflection_rounds_to_nearest_frame_and_silence_has_finite_floor() {
        let features = Features::new();
        let (frames, values) = features.extract(&vec![0.0; 16_079]);
        assert_eq!(frames, 100);
        assert_eq!(values.len(), 100 * BINS);
        assert!(values.iter().all(|&value| value == f32::EPSILON.ln()));
        assert_eq!(features.extract(&vec![0.0; 16_080]).0, 101);
    }

    #[test]
    fn dc_removal_eliminates_a_constant_signal_including_reflected_edges() {
        let features = Features::new();
        let (_, values) = features.extract(&vec![0.25; 16_000]);
        assert!(values.iter().all(|&value| value == f32::EPSILON.ln()));
    }

    #[test]
    fn speech_resuming_inside_a_packet_does_not_cut_the_new_word() {
        let mut samples = vec![0.0; 16_000];
        let mut silence = 12_700;
        let mut heard = true;
        // The first 10 ms crosses the pause threshold, then a new word begins.
        let packet: Vec<i16> = [vec![0; 160], vec![1000; 160]].concat();
        assert!(!append_packet(&mut samples, &mut silence, &mut heard, &packet));
        assert_eq!(silence, 0);
        assert_eq!(samples.len(), 16_320);
        // A later packet containing a complete trailing pause does finalize it.
        assert!(append_packet(&mut samples, &mut silence, &mut heard, &vec![0; 12_800]));
    }

    /// Compare complete, locally synthesized WAVs without real meetings or capture devices.
    /// Required env: NEXQ_STT_BENCHMARK_CASES (JSON array with path/reference),
    /// NEXQ_STT_BASELINE_PATH (small model), NEXQ_STT_MODEL_PATH (larger model).
    /// Optional: NEXQ_STT_BENCHMARK_OUTPUT, a local JSON report path.
    #[test]
    #[ignore = "requires two downloaded Russian models and a synthetic WAV benchmark manifest"]
    fn compare_russian_models_on_synthetic_cases() {
        #[derive(serde::Deserialize)]
        struct Case {
            #[serde(default)]
            name: String,
            path: std::path::PathBuf,
            reference: String,
        }

        crate::ort_runtime::ensure_loaded().expect("load bundled ONNX Runtime");
        let manifest_path = std::env::var_os("NEXQ_STT_BENCHMARK_CASES")
            .expect("Set NEXQ_STT_BENCHMARK_CASES to a synthetic path/reference JSON array");
        let cases: Vec<Case> = serde_json::from_slice(&std::fs::read(manifest_path).expect("read benchmark manifest"))
            .expect("parse benchmark cases");
        assert!(!cases.is_empty(), "benchmark needs synthetic cases");
        let cases: Vec<_> = cases.into_iter().map(|case| {
            let mut reader = hound::WavReader::open(&case.path).expect("open synthetic WAV");
            let spec = reader.spec();
            assert!(spec.sample_rate == 16_000 && spec.channels == 1 && spec.bits_per_sample == 16
                && spec.sample_format == hound::SampleFormat::Int, "benchmark WAV must be mono PCM16 16 kHz");
            let samples: Vec<f32> = reader.samples::<i16>()
                .map(|sample| sample.map(|sample| sample as f32 / 32768.0))
                .collect::<Result<_, _>>().expect("decode synthetic PCM");
            assert!(!samples.is_empty() && !words(&case.reference).is_empty(), "case/reference must be nonempty");
            (case, samples)
        }).collect();

        let mut rows = Vec::new();
        let mut totals = serde_json::Map::new();
        for (label, path_variable) in [("small", "NEXQ_STT_BASELINE_PATH"), ("big", "NEXQ_STT_MODEL_PATH")] {
            let model_dir = std::path::PathBuf::from(std::env::var_os(path_variable)
                .unwrap_or_else(|| panic!("Set {path_variable} to the model directory")));
            let started = Instant::now();
            let files = crate::stt::local_engines::model_discovery::discover_model_files(&model_dir)
                .expect("discover benchmark model");
            let mut encoder = super::super::load_ort_session(&files.encoder).expect("load benchmark encoder");
            let mut decoder = super::super::load_ort_session(&files.decoder).expect("load benchmark decoder");
            let mut joiner = super::super::load_ort_session(&files.joiner).expect("load benchmark joiner");
            let vocab = super::super::load_tokens(&files.tokens).expect("read benchmark token table");
            validate(&encoder, &decoder, &joiner, &vocab).expect("benchmark model contract");
            let load_seconds = started.elapsed().as_secs_f64();
            let features = Features::new();
            let mut total_errors = 0;
            let mut total_words = 0;
            let mut total_audio = 0.0;
            let mut total_inference = 0.0;
            for (index, (case, samples)) in cases.iter().enumerate() {
                let started = Instant::now();
                let transcript = recognize(&mut encoder, &mut decoder, &mut joiner, &features, samples, &vocab)
                    .expect("recognize synthetic benchmark case");
                let seconds = started.elapsed().as_secs_f64();
                assert!(!transcript.trim().is_empty(), "{label} produced empty text for case {index}");
                let reference = words(&case.reference);
                let errors = word_errors(&reference, &words(&transcript));
                let audio_seconds = samples.len() as f64 / SAMPLE_RATE as f64;
                let row = serde_json::json!({
                    "kind": "case", "model": label,
                    "case": if case.name.is_empty() { format!("case_{}", index + 1) } else { case.name.clone() },
                    "reference": case.reference, "transcript": transcript,
                    "reference_words": reference.len(), "word_errors": errors,
                    "wer": errors as f64 / reference.len() as f64,
                    "audio_seconds": audio_seconds, "inference_seconds": seconds,
                    "rtf": seconds / audio_seconds,
                });
                println!("{row}");
                rows.push(row);
                total_errors += errors;
                total_words += reference.len();
                total_audio += audio_seconds;
                total_inference += seconds;
            }
            totals.insert(label.to_owned(), serde_json::json!({
                "load_seconds": load_seconds, "cases": cases.len(),
                "reference_words": total_words, "word_errors": total_errors,
                "wer": total_errors as f64 / total_words as f64,
                "audio_seconds": total_audio, "inference_seconds": total_inference,
                "rtf": total_inference / total_audio,
            }));
        }
        let summary = serde_json::json!({"kind": "aggregate", "models": totals});
        println!("{summary}");
        if let Some(path) = std::env::var_os("NEXQ_STT_BENCHMARK_OUTPUT") {
            let report = serde_json::json!({"cases": rows, "summary": summary});
            std::fs::write(path, serde_json::to_vec_pretty(&report).expect("serialize benchmark report"))
                .expect("write local benchmark report");
        }
        // WER is reported rather than thresholded: a few synthetic cases cannot
        // establish production accuracy or guarantee that the larger model wins.
    }
}
