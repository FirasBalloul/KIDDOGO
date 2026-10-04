import io
import os
import torch
import torchaudio
import soundfile as sf
import numpy as np
from pathlib import Path
from speechbrain.inference.speaker import SpeakerRecognition
from speechbrain.utils.fetching import LocalStrategy

# Safe printing for Windows CP1252/CP1256 environments
def _log(msg: str):
    try:
        print(msg)
    except UnicodeEncodeError:
        print(msg.encode("ascii", errors="replace").decode("ascii"))

_log("Initializing SpeechBrain ECAPA-TDNN Speaker Verification Model...")
speaker_model = SpeakerRecognition.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir="pretrained_models/spkrec-ecapa-voxceleb",
    run_opts={"device": "cpu"},
    local_strategy=LocalStrategy.COPY
)
_log("Speaker Verification Model Ready.")

# Directory for persistent voice signatures
PROFILES_DIR = Path(__file__).resolve().parent / "voice_profiles"
PROFILES_DIR.mkdir(exist_ok=True)

CHILD_VOICE_REGISTRY: dict[str, torch.Tensor] = {}

# Load existing enrolled profiles from disk on startup
def _load_saved_profiles():
    for pt_file in PROFILES_DIR.glob("*.pt"):
        child_id = pt_file.stem
        try:
            tensor = torch.load(pt_file, weights_only=True)
            CHILD_VOICE_REGISTRY[child_id] = tensor
            _log(f"Loaded persistent voice profile for '{child_id}' from {pt_file.name}")
        except Exception as e:
            _log(f"Warning: Failed to load profile {pt_file}: {e}")

_load_saved_profiles()

MIN_AUDIO_SAMPLES = 32000  # 2.0s at 16kHz minimum required for convolution frames

def process_audio_tensor(file_bytes: bytes) -> torch.Tensor:
    """Decodes raw audio bytes, applies peak normalization, and pads safely."""
    with io.BytesIO(file_bytes) as buffer:
        data, sample_rate = sf.read(buffer, dtype="float32")

    # Mono mixdown
    if data.ndim == 1:
        waveform = torch.from_numpy(data).unsqueeze(0)
    else:
        waveform = torch.from_numpy(data.mean(axis=1)).unsqueeze(0)

    # Resample to 16kHz
    if sample_rate != 16000:
        resampler = torchaudio.transforms.Resample(orig_freq=sample_rate, new_freq=16000)
        waveform = resampler(waveform)

    # 1. Peak Normalization (Crucial for mobile mic consistency)
    max_val = torch.max(torch.abs(waveform))
    if max_val > 1e-4:
        waveform = waveform / max_val * 0.95

    # 2. Defensive repetition/padding for short signals
    num_samples = waveform.shape[-1]
    if num_samples < MIN_AUDIO_SAMPLES:
        if num_samples == 0:
            waveform = torch.zeros((1, MIN_AUDIO_SAMPLES), dtype=torch.float32)
        else:
            repeats = int(np.ceil(MIN_AUDIO_SAMPLES / num_samples))
            waveform = waveform.repeat(1, repeats)[:, :MIN_AUDIO_SAMPLES]

    return waveform

def enroll_child_voice(child_id: str, file_bytes: bytes) -> dict:
    waveform = process_audio_tensor(file_bytes)
    embedding = speaker_model.encode_batch(waveform)
    
    # L2 normalize the embedding vector
    embedding = torch.nn.functional.normalize(embedding, p=2, dim=-1)
    CHILD_VOICE_REGISTRY[child_id] = embedding
    
    # Persist profile to disk
    try:
        profile_path = PROFILES_DIR / f"{child_id}.pt"
        torch.save(embedding, profile_path)
        _log(f"Persisted voice profile for '{child_id}' to {profile_path.name}")
    except Exception as e:
        _log(f"Warning: Could not write voice profile to disk: {e}")

    return {
        "status": "ENROLLED",
        "child_id": child_id,
        "embedding_dims": embedding.shape[-1],
        "persisted": True
    }

def verify_speaker(child_id: str, file_bytes: bytes, threshold: float = 0.32) -> dict:
    """
    Compares candidate voice against enrolled profile.
    Threshold set to 0.32 for real-world acoustic phone mic environments.
    """
    # Lazy reload from disk if missing in memory
    if child_id not in CHILD_VOICE_REGISTRY:
        profile_path = PROFILES_DIR / f"{child_id}.pt"
        if profile_path.exists():
            try:
                CHILD_VOICE_REGISTRY[child_id] = torch.load(profile_path, weights_only=True)
            except Exception:
                pass

    if child_id not in CHILD_VOICE_REGISTRY:
        return {
            "verified": False,
            "similarity": 0.0,
            "threshold": threshold,
            "classification": "UNREGISTERED_CHILD",
            "reason": f"No voice profile enrolled for {child_id}"
        }

    waveform = process_audio_tensor(file_bytes)
    candidate_embedding = speaker_model.encode_batch(waveform)
    candidate_embedding = torch.nn.functional.normalize(candidate_embedding, p=2, dim=-1)

    target_embedding = CHILD_VOICE_REGISTRY[child_id]

    similarity = torch.nn.functional.cosine_similarity(
        candidate_embedding.squeeze(1), 
        target_embedding.squeeze(1)
    ).item()

    is_child = similarity >= threshold

    return {
        "verified": is_child,
        "similarity": round(similarity, 3),
        "threshold": threshold,
        "classification": "CHILD_VERIFIED" if is_child else "REJECTED_IMPOSTOR_OR_ADULT"
    }