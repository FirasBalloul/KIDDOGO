# KIDDOGO

KIDDOGO is a child-safety layer built for PetraRide, a Jordan-based ride platform focused on safer travel for children. The project adds monitoring and escalation features for family rides, and other journeys where a child may be traveling without a guardian present.

The system combines on-device audio detection, voice-based identity checks, live GPS telemetry, and a rider companion flow to help detect real distress early while avoiding unnecessary alarms for normal rides.

---

## What this project does

- listens to microphone audio in the mobile app
- runs YAMNet locally on-device to classify suspicious audio events
- opens a safety confirmation flow when a distress pattern is detected
- verifies the rider’s voice before suppressing or escalating the alert
- blocks unauthorized voice attempts and triggers a higher-priority escalation
- sends live GPS updates to a FastAPI backend
- streams alert and location data to an operations map at `/map`
- includes a companion chat flow for the rider with SOS support

---

## Architecture

```text
Mobile app (React Native / Expo)
    │
    ├─ microphone audio stream
    ├─ YAMNet TFLite inference (on-device)
    ├─ voice enrollment / verification
    ├─ live GPS telemetry
    └─ PetraBuddy companion chat + SOS flow
            │
            ▼
FastAPI backend
    │
    ├─ /api/telemetry/location
    ├─ /api/alerts
    ├─ /api/voice/enroll
    ├─ /api/voice/verify
    ├─ WebSocket updates for the dashboard
    └─ Gemini triage response when available
            │
            ▼
Operations dashboard (/map)
    ├─ live map marker
    ├─ speed / coord telemetry
    ├─ incident feed
    └─ alert status updates
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

The flow in the app is roughly:

- enroll voice by recording a short sample
- store the voice embedding for `child_01`
- during a distress event, ask the user to confirm safety by speaking
- compare the recorded sample to the enrolled profile
- reject or escalate if the voice is not recognized

This is the main anti-coercion mechanism in the project.

### 3. Safety check-in loop

When an event is detected, the app opens a short countdown and asks the rider whether they are okay. The logic is designed to suppress false alarms, but force escalation if there is no confirmation.

Possible outcomes:

- safe confirmation: suppress the alert
- no response: escalate
- voice mismatch: `IMPOSTOR_BLOCKED`
- manual SOS: `MANUAL_SOS`

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
- SQLite
- Google Gemini SDK
- SpeechBrain
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
│   │   └── yamnet.tflite
│   ├── package.json
│   └── src/
│       ├── app/
│       │   └── index.tsx
│       └── components/
│           └── CompanionChatModal.tsx
│
├── README.md
├── docker-compose.yml
└── ai-models/
```

---

## Backend API

The FastAPI backend exposes the following main endpoints:

- `GET /` — health check
- `POST /api/telemetry/location` — receives live GPS updates
- `POST /api/alerts` — stores and broadcasts an incident alert
- `GET /api/alerts` — returns recent alerts
- `POST /api/voice/enroll` — enrolls a child voice profile
- `POST /api/voice/verify` — verifies the rider voice and returns triage info
- `GET /map` — renders the operations dashboard
- `WebSocket /ws` — streams live events to the frontend

---

## Running the project

### 1. Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt

# create a .env file with your key
# GEMINI_API_KEY=your_key_here

uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Then open:

- `http://localhost:8000/`
- `http://localhost:8000/map`

### 2. Mobile app

```bash
cd mobile
npm install
npx expo start --clear
```

The app uses a hardcoded backend URL in the mobile client, so this usually needs to be updated to the machine running the backend:

```ts
const BACKEND_URL = 'http://<YOUR_LOCAL_IP>:8000';
```

This is in `mobile/src/app/index.tsx`.

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
- The app expects Android hardware for testing and microphone access.
- The backend and mobile client are configured for a local network setup, not a public deployment.
- The mapping dashboard and alert feed are intended for demonstration and operational visibility during a trip.
- The YAMNet model is used as a first-stage signal, not a complete diagnostic system.

---

## Summary

PetraKids SafeTrack is a proof-of-concept child-rider safety stack built around anomaly detection, voice verification, and operational awareness. The core value is not just GPS tracking — it is filtering out noise, validating the actual rider, and escalating only when the evidence supports it.

