"""
PetraRide SafeTrack - Voice Verification & Recognition Test Suite
Tests SpeechBrain ECAPA-TDNN Speaker Recognition and FastAPI Voice Endpoints.
"""

import sys
import io
import time
import base64
import argparse
import numpy as np
import soundfile as sf
import requests
from pathlib import Path

# Add backend directory to sys.path
BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

def log(msg: str):
    try:
        print(msg)
    except UnicodeEncodeError:
        print(msg.encode("ascii", errors="replace").decode("ascii"))

def generate_voice_sample(fundamental_freq: float = 260.0, duration: float = 3.5, sr: int = 16000) -> bytes:
    """Generates synthetic harmonic audio with formant-like modulation."""
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    # Harmonics simulation of vocal tract
    f0 = fundamental_freq
    signal = (
        0.45 * np.sin(2 * np.pi * f0 * t) +
        0.25 * np.sin(2 * np.pi * (2 * f0) * t) +
        0.18 * np.sin(2 * np.pi * (3 * f0) * t) +
        0.10 * np.sin(2 * np.pi * (4 * f0) * t)
    )
    # Add subtle amplitude modulation (natural speech envelope)
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 3.0 * t)
    signal = signal * envelope + 0.02 * np.random.randn(len(signal))
    signal = signal.astype(np.float32)

    buf = io.BytesIO()
    sf.write(buf, signal, sr, format="WAV")
    return buf.getvalue()

def record_microphone(duration: float = 4.0, sr: int = 16000) -> bytes:
    """Records audio from the default system microphone."""
    import sounddevice as sd
    log(f"[*] Recording for {duration} seconds... Speak into your microphone now!")
    audio = sd.rec(int(duration * sr), samplerate=sr, channels=1, dtype="float32")
    sd.wait()
    log("[*] Recording complete.")

    buf = io.BytesIO()
    sf.write(buf, audio.flatten(), sr, format="WAV")
    return buf.getvalue()

def test_direct_engine():
    """Tests the SpeechBrain model directly in Python."""
    log("\n" + "=" * 60)
    log("  TEST 1: Direct SpeechBrain ECAPA-TDNN Verification Engine")
    log("=" * 60)

    from voice_verifier import enroll_child_voice, verify_speaker, CHILD_VOICE_REGISTRY

    child_id = "test_child_direct"
    log(f"[*] Generating child voice signature (pitch = 260 Hz)...")
    child_voice = generate_voice_sample(fundamental_freq=260.0, duration=3.5)

    log(f"[*] Enrolling child voice '{child_id}'...")
    enroll_res = enroll_child_voice(child_id, child_voice)
    log(f"[+] Enrollment Response: {enroll_res}")

    # Test 1A: Matching voice with noise perturbation
    log(f"\n[*] Testing MATCHING voice verification (same child)...")
    child_voice_match = generate_voice_sample(fundamental_freq=260.0, duration=3.0)
    match_res = verify_speaker(child_id, child_voice_match)
    log(f"[+] Match Result: {match_res}")
    assert match_res["verified"] is True, "Matching speaker should be verified!"
    log("[PASSED] Matching speaker verified successfully.")

    # Test 1B: Impostor voice with different fundamental frequency
    log(f"\n[*] Testing IMPOSTOR voice verification (adult pitch = 110 Hz)...")
    impostor_voice = generate_voice_sample(fundamental_freq=110.0, duration=3.0)
    impostor_res = verify_speaker(child_id, impostor_voice)
    log(f"[+] Impostor Result: {impostor_res}")
    log(f"[*] Impostor similarity: {impostor_res['similarity']} (Threshold: {impostor_res['threshold']})")

def test_api_endpoints(base_url: str = "http://127.0.0.1:8000"):
    """Tests the FastAPI /api/voice/enroll and /api/voice/verify endpoints over HTTP."""
    log("\n" + "=" * 60)
    log(f"  TEST 2: FastAPI Voice Verification Endpoints ({base_url})")
    log("=" * 60)

    try:
        health = requests.get(f"{base_url}/", timeout=3)
        log(f"[*] Health check: {health.json()}")
    except Exception as e:
        log(f"[-] Backend not reachable at {base_url}: {e}")
        log("    Start the backend first: uvicorn main:app --host 0.0.0.0 --port 8000")
        return

    child_id = "test_child_http"
    child_wav = generate_voice_sample(fundamental_freq=280.0, duration=3.5)
    b64_child = base64.b64encode(child_wav).decode("utf-8")

    # 1. Enroll via HTTP
    log(f"\n[*] POST /api/voice/enroll for '{child_id}'...")
    enroll_resp = requests.post(
        f"{base_url}/api/voice/enroll",
        json={"child_id": child_id, "audio_base64": b64_child},
        timeout=10
    )
    log(f"[+] Enroll Status: {enroll_resp.status_code}, Body: {enroll_resp.json()}")

    # 2. Verify Matching Speaker via HTTP
    log(f"\n[*] POST /api/voice/verify (Matching voice)...")
    match_wav = generate_voice_sample(fundamental_freq=280.0, duration=3.0)
    b64_match = base64.b64encode(match_wav).decode("utf-8")
    verify_resp = requests.post(
        f"{base_url}/api/voice/verify",
        json={
            "child_id": child_id,
            "audio_base64": b64_match,
            "detected_sound": "Test Verification"
        },
        timeout=15
    )
    log(f"[+] Verify Status: {verify_resp.status_code}, Body: {verify_resp.json()}")

def interactive_mic_test(base_url: str = "http://127.0.0.1:8000"):
    """Interactive live microphone test for real voice testing."""
    log("\n" + "=" * 60)
    log("  TEST 3: Live Microphone Speaker Verification")
    log("=" * 60)

    from voice_verifier import enroll_child_voice, verify_speaker

    child_id = "live_child_user"
    input("\nPress ENTER to start ENROLLMENT (Speak for 4 seconds)...")
    enroll_wav = record_microphone(duration=4.0)

    log("[*] Enrolling live voice profile...")
    enroll_res = enroll_child_voice(child_id, enroll_wav)
    log(f"[+] Enrolled: {enroll_res}")

    while True:
        choice = input("\nTest Verification: (1) Test YOUR voice, (2) Test DIFFERENT speaker / impostor, (q) Quit: ").strip()
        if choice.lower() == "q":
            break

        input("Press ENTER and speak for 3.5 seconds...")
        verify_wav = record_microphone(duration=3.5)

        log("[*] Computing biometric similarity...")
        result = verify_speaker(child_id, verify_wav)
        log("-" * 40)
        log(f"Classification: {result['classification']}")
        log(f"Verified Match: {result['verified']}")
        log(f"Similarity:     {result['similarity']} (Threshold: {result['threshold']})")
        log("-" * 40)

def main():
    parser = argparse.ArgumentParser(description="PetraRide SafeTrack Voice Test Suite")
    parser.add_argument("--mode", choices=["all", "direct", "api", "mic"], default="direct",
                        help="Test mode: direct (engine), api (HTTP endpoints), mic (live microphone), all")
    parser.add_argument("--url", default="http://127.0.0.1:8000", help="FastAPI backend URL")
    args = parser.parse_args()

    if args.mode in ("direct", "all"):
        test_direct_engine()

    if args.mode in ("api", "all"):
        test_api_endpoints(args.url)

    if args.mode == "mic":
        interactive_mic_test(args.url)

if __name__ == "__main__":
    main()
