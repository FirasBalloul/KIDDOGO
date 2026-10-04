# KIDDOGO

KIDDOGO is a child-safety layer built for PetraRide, a Jordan-based ride platform focused on safer travel for children. The project adds monitoring and escalation features for family rides, and other journeys where a child may be traveling without a guardian present.

The system combines on-device audio detection, voice-based identity checks, live GPS telemetry, a rider companion flow, and an optional cabin pose sentinel. It is a prototype and should not be relied on as the sole means of protecting a passenger.

---

## What this project does

- listens to microphone audio in the mobile app
- runs YAMNet locally on-device to classify suspicious audio events
- opens a safety confirmation flow when a distress pattern is detected
- verifies the rider’s voice before suppressing or escalating the alert
- blocks unauthorized voice attempts and triggers a higher-priority escalation
- sends live GPS, vehicle speed, G-force kinematics, and battery health to a FastAPI backend
- detects route corridor deviations and prolonged unplanned stops
- supports **Push-to-Talk voice notes** in the PetraBuddy companion chat
- streams alert and location data to an operations map at `/map`
- provides a dedicated **Parent Live Guardian Portal** at `/parent/{trip_id}`
- optionally checks cabin wrist position against a virtual boundary using MediaPipe Pose
- correlates audio, vision, and G-force kinematic events in a multi-modal fusion window

---

## Architecture

```text
Mobile app (React Native / Expo)
    │
    ├─ microphone audio stream
    ├─ YAMNet TFLite inference (on-device)
    ├─ voice enrollment / verification
    ├─ live GPS & G-Force kinematics stream
    ├─ offline store-and-forward queue
    └─ PetraBuddy companion chat (Push-to-Talk + SOS)
            │
            ▼
FastAPI backend
    │
    ├─ /api/telemetry/location (Corridor + Kinematics)
    ├─ /api/alerts
    ├─ /api/voice/enroll (Persistent on-disk storage)
    ├─ /api/voice/verify
    ├─ /api/voice/status/{child_id}
    ├─ /api/companion/chat & /api/companion/chat-voice
    ├─ /api/incident/boundary-breach
    ├─ multi-modal fusion engine (Vision + Audio + Kinematics)
    ├─ WebSocket updates for live dashboards
    └─ Gemini multimodal triage and chat responses
            │
            ├───────────────┬───────────────┐
            ▼               ▼               ▼
      Operations Map   Parent Portal   SQLite / Postgres
         (/map)       (/parent/{id})       (Resilient)
```

---

## Core features

### 1. On-device acoustic detection

The mobile app uses `react-native-fast-tflite` with a YAMNet model to scan short PCM chunks from the microphone. It looks for distress-like classes such as crying, screaming, sirens, impact sounds, glass breakage, and crash-like patterns.

The project includes a threshold-based escalation flow:

- if the score is below the threshold, the event is ignored
- if the score crosses the threshold, the app opens a confirmation flow
- if the rider does not respond or the voice does not verify, the alert escalates

### 2. Voice enrollment and verification

The backend uses SpeechBrain ECAPA-TDNN embeddings to enroll and validate a child’s voice profile.

The flow in the app is:

- enroll voice by recording a short 4-second sample
- persist voice embeddings on disk (`backend/voice_profiles/{child_id}.pt`) for automatic reload across server restarts
- during a distress event, ask the user to confirm safety by speaking ("I am safe")
- compare the recorded sample against the enrolled biometric embedding (cosine similarity threshold >= 0.32)
- reject or escalate if the voice is not recognized (Anti-Impostor Shield)

This ensures that third-party driver attempts to silence a child's distress alert are blocked. Voice check audio is verified via SpeechBrain; after a speaker match, the backend also sends the audio to Gemini for situation triage if configured.

### 3. Safety check-in loop

When an event is detected, the app opens a short countdown and asks the rider whether they are okay. The logic is designed to suppress false alarms, but force escalation if there is no confirmation.

Possible outcomes:

- verified safe confirmation: suppress the alert
- no response: escalate
- voice mismatch: `IMPOSTOR_BLOCKED`
- manual SOS: `MANUAL_SOS`

Voice verification is optional in the current UI: if no voice profile is enrolled, tapping the safe-confirmation button resolves the check-in without verifying identity. A voice verification request error also currently resolves as safe; this is a prototype limitation.

### 4. Companion chat and SOS

The companion widget in the app provides a chat-like rider interface with:

- Arabic and English support
- a quick response flow
- text input from the child
- TTS playback for the assistant prompts
- a visible SOS action with a countdown before escalating

### 5. Live location and dashboard

The app streams coordinates using `expo-location` and sends them to the backend through `/api/telemetry/location`.

The backend then broadcasts the position to connected clients via WebSocket and renders a dashboard at `/map` with:

- live passenger marker
- map position updates
- speed data
- incident log
- alert states

---

### 6. Optional cabin spatial sentinel

Run `backend/cabin_sentinel.py` separately from the API to use a connected camera. It uses OpenCV and MediaPipe Pose to estimate body landmarks locally, then checks whether a sufficiently visible wrist landmark crosses the configured image midpoint. When it detects a breach, it posts an incident to `/api/incident/boundary-breach`. The display uses a synthetic pose visualization rather than showing the camera frame.

This is a simple image-space boundary check; it does not identify people or understand intent. Camera orientation, placement, and calibration affect which side of the frame represents each cabin zone.

The backend fusion engine correlates audio and vision observations in a short sliding time window. Location updates also record vehicle speed, but the current telemetry path does not provide acceleration or braking measurements to score a kinematic event. This logic is experimental and is not a validated emergency detector.

---

## Tech stack

### Mobile app

- React Native + Expo
- TypeScript
- `react-native-fast-tflite`
- `@siteed/audio-studio`
- `expo-location`
- `expo-speech`
- `react-native-webview`

### Backend

- FastAPI
- Python
- SQLAlchemy
- PostgreSQL
- Google Gemini SDK
- SpeechBrain
- MediaPipe Pose and OpenCV (optional camera sentinel)
- WebSockets

### Operations UI

- Leaflet.js
- OpenStreetMap tiles
- plain HTML/CSS/JavaScript in the FastAPI route

---

## Repository structure

```text
.
├── backend/
│   ├── database.py
│   ├── cabin_sentinel.py
│   ├── fusion_engine.py
│   ├── main.py
│   ├── models.py
│   ├── requirements.txt
│   ├── voice_verifier.py
│   └── pretrained_models/
│       └── spkrec-ecapa-voxceleb/
│
├── mobile/
│   ├── android/
│   ├── app.json
│   ├── assets/
│   │   ├── yamnet.tflite
│   │   └── yamnet_class_map.csv
│   ├── package.json
│   └── src/
│       ├── app/
│       │   └── index.tsx
│       └── components/
│           └── CompanionChatModal.tsx
│
├── ai-models/
│   ├── test_yamnet.py
│   ├── yamnet.tflite
│   └── yamnet_class_map.csv
│
├── README.md
└── docker-compose.yml
```

---

## Backend API

The FastAPI backend exposes the following main endpoints:

- `GET /` — health check
- `GET /api/telemetry/current` — gets the latest cached location and speed
- `POST /api/telemetry/location` — receives live GPS updates
- `POST /api/alerts` — stores and broadcasts an incident alert
- `GET /api/alerts` — returns the latest stored alerts
- `POST /api/voice/enroll` — enrolls a child voice profile
- `POST /api/voice/verify` — checks the speaker and returns triage information
- `POST /api/companion/chat` — returns a companion response and escalates detected concerns
- `POST /api/incident/boundary-breach` — records a spatial boundary incident
- `GET /map` — renders the operations dashboard
- `WebSocket /ws` — streams live events to the frontend

---

## Running the project

### 1. Backend

From the repository root, create and activate a virtual environment, then install the backend requirements:

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

The backend uses PostgreSQL. Start or configure a PostgreSQL server before launching it. To use the included Compose database:

```powershell
docker compose up -d db
```

The connection URL in `backend/database.py` and the database name/credentials in `docker-compose.yml` must match. Reconcile those settings before starting the API.

Create `backend/.env` to enable Gemini-backed triage and companion responses:

```env
GEMINI_API_KEY=your_key_here
```

Start the API from the `backend` directory:

```powershell
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

To run the optional camera sentinel, open another terminal, activate the same environment, and run:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python cabin_sentinel.py
```

The sentinel needs camera access. Its alert URL defaults to `http://127.0.0.1:8000`; change `BACKEND_ALERT_URL` in `cabin_sentinel.py` if the API runs on another host.

Then open:

- `http://localhost:8000/`
- `http://localhost:8000/map`

### 2. Mobile app

```powershell
cd mobile
npm install
npx expo start --clear
```

The mobile client currently has a hardcoded backend URL in `mobile/src/app/index.tsx`. Update `BACKEND_URL` to a host reachable from the device. For a physical phone, use the computer's LAN IP; `localhost` on the phone refers to the phone itself:

```ts
const BACKEND_URL = 'http://<YOUR_LOCAL_IP>:8000';
```

---

## Demo flow

1. Open the app and enroll the child voice by recording a short sample.
2. Start listening and let the microphone run in the vehicle.
3. Trigger a loud or distress-like sound, such as a scream or impact.
4. The app should detect the sound, open the confirmation flow, and speak a prompt.
5. If the rider responds with a matching voice, the alert is suppressed.
6. If the voice does not match, the event is rejected as `IMPOSTOR_BLOCKED`.
7. If the rider does not respond, the app escalates and dispatches the alert to the operations map.

---

## Notes and limitations

- This project is a prototype, not a production-grade safety system.
- The mobile client needs microphone and location permissions. Physical-device testing requires a backend reachable over the local network.
- Public deployment, production security, and other platform support are not covered by this prototype setup.
- The mapping dashboard and alert feed are intended for demonstration and operational visibility during a trip.
- The YAMNet model is used as a first-stage signal, not a complete diagnostic system.
- Enrolled voice embeddings are persisted to disk as `.pt` PyTorch tensors in `backend/voice_profiles/` for seamless persistence across server restarts.
- Gemini features require `GEMINI_API_KEY`. If Gemini is unavailable, the backend uses built-in fallback responses for voice triage and companion chat.
- The PostgreSQL database runs via Docker Compose or local PostgreSQL with automatic SQLite fallback.
- Kinematic telemetry calculates real-time G-force deltas and vehicle velocity to correlate sudden braking/swerves with acoustic events in the multi-modal fusion window.

---

## Summary

PetraKids SafeTrack is a proof-of-concept child-rider safety stack built around anomaly detection, voice verification, and operational awareness. The core value is not just GPS tracking — it is filtering out noise, validating the actual rider, and escalating only when the evidence supports it.
