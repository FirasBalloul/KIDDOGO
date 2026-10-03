import os
import base64
import time
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, Depends, WebSocket, WebSocketDisconnect, APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel

import models
from database import engine, get_db
from voice_verifier import enroll_child_voice, verify_speaker
from fusion_engine import fusion_engine

from google import genai
from google.genai import types

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Petra Ride SafeTrack Core Engine")

GEMINI_KEY = os.getenv("GEMINI_API_KEY")
gemini_client = None

if GEMINI_KEY:
    try:
        gemini_client = genai.Client(api_key=GEMINI_KEY)
    except Exception as e:
        print(f"Gemini client notice: {e}")

# --- GLOBAL DYNAMIC TELEMETRY CACHE ---
# Default starting point: Amman (King Hussein Business Park area)
latest_vehicle_telemetry = {
    "child_id": "child_01",
    "latitude": 31.9715,
    "longitude": 35.8354,
    "speed": 0.0,
    "last_updated": time.time()
}

# --- SCHEMAS ---
router = APIRouter(prefix="/api/incident", tags=["Incidents"])

class SpatialBreachPayload(BaseModel):
    event_type: str
    target_limb: Optional[str] = "UNKNOWN"
    timestamp: float
    zone: str = "REAR_CABIN"
    
class LocationTelemetry(BaseModel):
    child_id: str = "child_01"
    latitude: float
    longitude: float
    speed: float | None = 0.0

class DistressAlert(BaseModel):
    sound_type: str
    confidence: float
    latitude: float | None = None
    longitude: float | None = None
    status: str | None = "DISTRESS_DETECTED"

class VoicePayload(BaseModel):
    child_id: str = "child_01"
    audio_base64: str
    detected_sound: str = "In-Cabin Acoustic Event"

class TriageAnalysis(BaseModel):
    is_emergency: bool
    confidence: float
    detected_situation: str
    reassurance_speech_ar: str
    reassurance_speech_en: str
    log_summary: str

class CompanionChatPayload(BaseModel):
    child_id: str = "child_01"
    message: str
    latitude: float | None = None
    longitude: float | None = None

class CompanionChatEvaluation(BaseModel):
    reply: str
    language: str
    is_distress: bool
    distress_category: str | None = None
    recommended_action: str | None = None


# --- WEBSOCKET MANAGER ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                self.disconnect(connection)

manager = ConnectionManager()


# --- INCIDENT ROUTER (SPATIAL SENTINEL) ---
@router.post("/boundary-breach")
async def handle_spatial_breach(payload: SpatialBreachPayload, db: Session = Depends(get_db)):
    global latest_vehicle_telemetry
    limb_name = payload.target_limb or "UNKNOWN_LIMB"
    print(f"\n[SPATIAL SENSOR] Zone: {payload.zone} | Limb: {limb_name}")

    # Evaluate event across temporal sliding window
    fusion_result = fusion_engine.record_vision_breach(zone=payload.zone, limb=limb_name)

    # Attach to active dynamic vehicle GPS position
    current_lat = latest_vehicle_telemetry["latitude"]
    current_lon = latest_vehicle_telemetry["longitude"]

    # Persist incident in database
    db_alert = models.Alert(
        sound_type=fusion_result["classification"],
        confidence=fusion_result["fused_score"],
        latitude=current_lat,
        longitude=current_lon
    )
    db.add(db_alert)
    db.commit()
    db.refresh(db_alert)

    # Broadcast fused assessment to operations dashboard with real location
    await manager.broadcast({
        "type": "INCIDENT_ALERT",
        "sound_type": f"FUSION: {fusion_result['classification']}",
        "confidence": fusion_result["fused_score"],
        "latitude": current_lat,
        "longitude": current_lon,
        "status": fusion_result["status"],
        "timestamp": "Just now",
        "details": f"{fusion_result['summary']} ({limb_name})"
    })

    return {
        "status": "ACKNOWLEDGED",
        "location": {"lat": current_lat, "lon": current_lon},
        "fusion": fusion_result
    }

# Mount the incident router
app.include_router(router)


# --- GENERAL ROUTES ---
@app.get("/")
def health_check():
    return {"status": "Petra Ride SafeTrack Online"}

@app.get("/api/telemetry/current")
def get_current_telemetry():
    """Returns the latest active GPS coordinates so the frontend can initialize precisely."""
    global latest_vehicle_telemetry
    return latest_vehicle_telemetry

@app.post("/api/telemetry/location")
async def update_live_location(telemetry: LocationTelemetry):
    global latest_vehicle_telemetry
    
    # Cache active position
    latest_vehicle_telemetry["latitude"] = telemetry.latitude
    latest_vehicle_telemetry["longitude"] = telemetry.longitude
    latest_vehicle_telemetry["speed"] = telemetry.speed or 0.0
    latest_vehicle_telemetry["last_updated"] = time.time()

    # Inform fusion engine of vehicle kinematics (speed in km/h)
    fusion_engine.record_kinematics(speed_kmh=(telemetry.speed or 0.0) * 3.6)

    await manager.broadcast({
        "type": "LOCATION_TELEMETRY",
        "child_id": telemetry.child_id,
        "latitude": telemetry.latitude,
        "longitude": telemetry.longitude,
        "speed": telemetry.speed or 0.0
    })
    return {"status": "OK", "cached_position": [telemetry.latitude, telemetry.longitude]}

@app.post("/api/alerts")
async def receive_alert(alert: DistressAlert, db: Session = Depends(get_db)):
    global latest_vehicle_telemetry

    # Use telemetry position if not explicitly supplied
    alert_lat = alert.latitude if alert.latitude is not None else latest_vehicle_telemetry["latitude"]
    alert_lon = alert.longitude if alert.longitude is not None else latest_vehicle_telemetry["longitude"]

    # Feed acoustic event into fusion engine
    fusion_result = fusion_engine.record_audio_event(
        sound_type=alert.sound_type,
        confidence=alert.confidence
    )

    db_alert = models.Alert(
        sound_type=alert.sound_type,
        confidence=alert.confidence,
        latitude=alert_lat,
        longitude=alert_lon
    )
    db.add(db_alert)
    db.commit()
    db.refresh(db_alert)

    # Broadcast correlated alert
    await manager.broadcast({
        "type": "INCIDENT_ALERT",
        "sound_type": f"{alert.sound_type} ({fusion_result['classification']})",
        "confidence": fusion_result["fused_score"],
        "latitude": alert_lat,
        "longitude": alert_lon,
        "status": fusion_result["status"],
        "timestamp": str(db_alert.timestamp),
        "details": fusion_result["summary"]
    })
    return {"status": "DISPATCHED", "fusion": fusion_result, "pinned_at": [alert_lat, alert_lon]}

@app.get("/api/alerts")
def get_all_alerts(db: Session = Depends(get_db)):
    return db.query(models.Alert).order_by(models.Alert.timestamp.desc()).limit(30).all()

@app.post("/api/voice/enroll")
async def enroll_voice_endpoint(payload: VoicePayload):
    audio_bytes = base64.b64decode(payload.audio_base64)
    return enroll_child_voice(payload.child_id, audio_bytes)

@app.post("/api/voice/verify")
async def verify_voice_endpoint(payload: VoicePayload, db: Session = Depends(get_db)):
    global latest_vehicle_telemetry
    audio_bytes = base64.b64decode(payload.audio_base64)
    current_lat = latest_vehicle_telemetry["latitude"]
    current_lon = latest_vehicle_telemetry["longitude"]

    verification_result = verify_speaker(payload.child_id, audio_bytes)

    if not verification_result["verified"]:
        await manager.broadcast({
            "type": "INCIDENT_ALERT",
            "sound_type": "Unauthorized Voice Intervention",
            "confidence": verification_result.get("similarity", 0.0),
            "latitude": current_lat,
            "longitude": current_lon,
            "status": "IMPOSTOR_BLOCKED",
            "timestamp": "Just now",
            "details": "Captain or third-party voice detected during child check-in confirmation."
        })
        return {
            **verification_result,
            "triage": {
                "is_emergency": True,
                "confidence": 1.0,
                "detected_situation": "Third-party speaker attempted to override passenger check-in.",
                "reassurance_speech_ar": "تم رفض التحقق، جاري التواصل مع العائلة فوراً.",
                "reassurance_speech_en": "Verification mismatch. Contacting operations and parents.",
                "log_summary": "Security alert: unauthorized vocal dismissal."
            }
        }

    triage_data = None
    if gemini_client:
        try:
            audio_part = types.Part.from_bytes(data=audio_bytes, mime_type="audio/wav")
            triage_prompt = f"""
            You are Petra Ride SafeTrack, evaluating passenger cabin audio in Amman, Jordan.
            Trip event: "{payload.detected_sound}".
            Evaluate child's spoken audio:
            - Classify if this is a benign event (dropped bottle, door bump, confirmed safe) or genuine safety distress.
            - Provide reassurance in conversational Jordanian Arabic.
            """
            response = gemini_client.models.generate_content(
                model='gemini-2.5-flash',
                contents=[audio_part, triage_prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=TriageAnalysis,
                    temperature=0.2
                ),
            )
            triage_data = response.parsed.model_dump()
        except Exception:
            pass

    if not triage_data:
        triage_data = {
            "is_emergency": False,
            "confidence": 0.92,
            "detected_situation": "Passenger confirmed safety; voice profile validated.",
            "reassurance_speech_ar": "الحمدلله على سلامتك يا بطل، رحلتك مستمرة بأمان.",
            "reassurance_speech_en": "You are safe, hero. Continuing ride.",
            "log_summary": "Biometric match passed, passenger safe."
        }

    await manager.broadcast({
        "type": "INCIDENT_ALERT",
        "sound_type": triage_data['detected_situation'],
        "confidence": verification_result["similarity"],
        "latitude": current_lat,
        "longitude": current_lon,
        "status": "CRITICAL_ESCALATION" if triage_data["is_emergency"] else "VERIFIED_SAFE",
        "timestamp": "Just now",
        "details": triage_data["log_summary"]
    })

    return {**verification_result, "triage": triage_data}

@app.post("/api/companion/chat")
async def companion_chat_endpoint(payload: CompanionChatPayload, db: Session = Depends(get_db)):
    global latest_vehicle_telemetry
    chat_eval = None

    current_lat = payload.latitude if payload.latitude is not None else latest_vehicle_telemetry["latitude"]
    current_lon = payload.longitude if payload.longitude is not None else latest_vehicle_telemetry["longitude"]

    if gemini_client:
        try:
            eval_prompt = f"""
            You are "PetraBuddy", a friendly in-cabin safety companion for an unaccompanied child in a Petra Ride vehicle in Amman, Jordan.
            The child said: "{payload.message}"

            LANGUAGE RULE:
            - If the child writes in Arabic, respond in warm, comforting Jordanian Arabic (Levantine dialect), addressing them warmly ("يا بطل" or "يا شاطرة"). Set language="ar".
            - If the child writes in English or any other language, respond in friendly, encouraging English. Set language="en".

            SAFETY ASSESSMENT:
            - Evaluate if the child expresses distress, fear, reckless driving, route deviation, harassment, or discomfort (is_distress: true/false).
            - Output structured JSON matching the schema.
            """

            response = gemini_client.models.generate_content(
                model='gemini-2.5-flash',
                contents=[eval_prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=CompanionChatEvaluation,
                    temperature=0.3
                ),
            )
            chat_eval = response.parsed.model_dump()
        except Exception as e:
            print(f"Gemini companion chat error: {e}")

    if not chat_eval:
        is_arabic = any('\u0600' <= char <= '\u06FF' for char in payload.message)
        lower_msg = payload.message.lower()
        is_distress = any(w in lower_msg for w in ["scared", "help", "fast", "danger", "خايف", "صرخ", "سريع", "مساعدة", "طريق"])

        if is_arabic:
            reply = "أنا معك يا بطل وما تقلق، إذا حاسس بأي خطر اضغط زر المساعدة." if is_distress else "أهلاً يا بطل! رحلتك مع الكابتن مستمرة بأمان، اسألني أي إشي بدك إياه."
            lang = "ar"
        else:
            reply = "I'm right here with you, don't worry. Tap the SOS button if you need help." if is_distress else "Hi champ! Your ride is going smoothly. Let me know if you need anything!"
            lang = "en"

        chat_eval = {
            "reply": reply,
            "language": lang,
            "is_distress": is_distress,
            "distress_category": "CABIN_CONCERN" if is_distress else None,
            "recommended_action": "Contact Captain" if is_distress else "None"
        }

    if chat_eval["is_distress"]:
        db_alert = models.Alert(
            sound_type=f"PASSENGER CHAT: {chat_eval.get('distress_category', 'Distress')}",
            confidence=0.95,
            latitude=current_lat,
            longitude=current_lon
        )
        db.add(db_alert)
        db.commit()

        await manager.broadcast({
            "type": "INCIDENT_ALERT",
            "sound_type": "💬 Passenger Flagged Concern",
            "confidence": 0.95,
            "latitude": current_lat,
            "longitude": current_lon,
            "status": "CRITICAL_ESCALATION",
            "timestamp": "Just now",
            "details": f'Child: "{payload.message}" | Category: {chat_eval.get("distress_category", "Distress")}'
        })

    return chat_eval

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# --- MODERN RESPONSIVE COMMAND INTERFACE ---
@app.get("/map", response_class=HTMLResponse)
def render_map():
    return """
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <title>Petra Ride SafeTrack Operations</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
        
        <style>
            :root {
                --bg-base: #090D14;
                --bg-surface: #111726;
                --bg-card: #182238;
                --border-subtle: #232F48;
                --text-primary: #F8FAFC;
                --text-secondary: #94A3B8;
                --brand-cyan: #0EA5E9;
                --brand-cyan-glow: rgba(14, 165, 233, 0.25);
                --status-green: #10B981;
                --status-red: #EF4444;
                --status-amber: #F59E0B;
            }

            * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
            body { 
                font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
                background: var(--bg-base);
                color: var(--text-primary);
                height: 100vh;
                display: flex;
                overflow: hidden;
            }

            #map { flex: 1; height: 100vh; background: #06090E; }

            #ops-panel {
                width: 420px;
                background: var(--bg-surface);
                border-right: 1px solid var(--border-subtle);
                display: flex;
                flex-direction: column;
                z-index: 1000;
                box-shadow: 10px 0 30px rgba(0,0,0,0.5);
                transition: height 0.32s cubic-bezier(0.4, 0, 0.2, 1);
            }

            .drawer-handle-bar {
                display: none;
                width: 100%;
                justify-content: center;
                padding: 10px 0 6px 0;
                cursor: pointer;
            }

            .drawer-pill {
                width: 42px;
                height: 5px;
                background: #334155;
                border-radius: 3px;
            }

            .panel-header {
                padding: 18px 24px;
                border-bottom: 1px solid var(--border-subtle);
                background: rgba(17, 23, 38, 0.9);
                backdrop-filter: blur(12px);
            }

            .brand-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 8px;
            }

            .brand-badge {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 16px;
                font-weight: 800;
                letter-spacing: -0.3px;
                color: #FFFFFF;
            }

            .brand-icon {
                width: 26px;
                height: 26px;
                background: var(--brand-cyan);
                border-radius: 7px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #FFF;
                font-size: 13px;
                font-weight: 900;
            }

            .live-pill {
                font-size: 11px;
                font-weight: 700;
                color: var(--status-green);
                display: flex;
                align-items: center;
                gap: 6px;
                background: rgba(16, 185, 129, 0.1);
                border: 1px solid rgba(16, 185, 129, 0.25);
                padding: 4px 10px;
                border-radius: 20px;
            }

            .live-dot {
                width: 6px;
                height: 6px;
                background: var(--status-green);
                border-radius: 50%;
                box-shadow: 0 0 8px var(--status-green);
            }

            .captain-badge-card {
                background: var(--bg-card);
                border: 1px solid var(--border-subtle);
                border-radius: 12px;
                padding: 10px 12px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-top: 8px;
            }

            .captain-left { display: flex; align-items: center; gap: 10px; }
            .captain-avatar {
                width: 32px;
                height: 32px;
                border-radius: 50%;
                background: #25334E;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 700;
                font-size: 12px;
                color: var(--brand-cyan);
                border: 1.5px solid var(--brand-cyan);
            }

            .captain-meta h4 { font-size: 12px; font-weight: 700; color: #FFF; }
            .captain-meta p { font-size: 10px; color: var(--text-secondary); margin-top: 1px; }

            .gps-sync-btn {
                background: rgba(14, 165, 233, 0.15);
                color: var(--brand-cyan);
                font-size: 10px;
                font-weight: 700;
                padding: 5px 9px;
                border-radius: 6px;
                border: 1px solid rgba(14, 165, 233, 0.35);
                cursor: pointer;
                transition: background 0.2s;
            }
            .gps-sync-btn:hover { background: rgba(14, 165, 233, 0.3); }

            .telemetry-strip {
                display: grid;
                grid-template-columns: 1fr 1fr 1fr;
                gap: 8px;
                padding: 10px 24px;
                background: rgba(15, 22, 38, 0.5);
                border-bottom: 1px solid var(--border-subtle);
            }

            .telemetry-tile {
                background: var(--bg-base);
                border: 1px solid var(--border-subtle);
                padding: 6px 8px;
                border-radius: 8px;
                text-align: center;
            }

            .telemetry-tile .val {
                font-family: 'JetBrains Mono', monospace;
                font-size: 14px;
                font-weight: 700;
                color: #FFF;
            }

            .telemetry-tile .label {
                font-size: 8px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                color: var(--text-secondary);
                margin-top: 2px;
            }

            .feed-header {
                padding: 12px 24px 6px 24px;
                font-size: 10px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.8px;
                color: var(--text-secondary);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            #feed-container {
                flex: 1;
                min-height: 0;
                overflow-y: auto;
                padding: 8px 24px 20px 24px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                -webkit-overflow-scrolling: touch;
            }

            .event-card {
                background: var(--bg-card);
                border: 1px solid var(--border-subtle);
                border-radius: 12px;
                padding: 12px;
                transition: transform 0.2s, border-color 0.2s;
                cursor: pointer;
            }

            .event-card:hover { transform: translateY(-1px); border-color: #384A6E; }

            .event-card.escalated {
                border-color: rgba(239, 68, 68, 0.5);
                background: linear-gradient(180deg, rgba(239, 68, 68, 0.08) 0%, rgba(24, 34, 56, 0.8) 100%);
            }

            .event-card.safe {
                border-color: rgba(16, 185, 129, 0.35);
                background: linear-gradient(180deg, rgba(16, 185, 129, 0.05) 0%, rgba(24, 34, 56, 0.8) 100%);
            }

            .card-top {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                margin-bottom: 5px;
            }

            .card-title { font-size: 12px; font-weight: 700; color: #FFF; line-height: 1.4; flex: 1; padding-right: 8px; }

            .badge {
                font-size: 8px;
                font-weight: 800;
                text-transform: uppercase;
                padding: 2px 6px;
                border-radius: 5px;
                white-space: nowrap;
            }

            .badge-safe { background: rgba(16, 185, 129, 0.15); color: var(--status-green); border: 1px solid rgba(16, 185, 129, 0.3); }
            .badge-breach { background: rgba(239, 68, 68, 0.15); color: var(--status-red); border: 1px solid rgba(239, 68, 68, 0.4); }

            .card-body { font-size: 11px; color: var(--text-secondary); line-height: 1.4; }
            .card-footer {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-top: 8px;
                font-family: 'JetBrains Mono', monospace;
                font-size: 9px;
                color: #64748B;
            }

            @media (max-width: 768px) {
                body { flex-direction: column-reverse; height: 100vh; overflow: hidden; }
                .drawer-handle-bar { display: flex; }
                #ops-panel { width: 100%; height: 60vh; border-right: none; border-top: 1px solid var(--border-subtle); border-radius: 22px 22px 0 0; }
                #ops-panel.collapsed { height: 26vh; }
                #map { flex: 1; height: auto; }
                .panel-header { padding: 10px 18px 12px 18px; }
                .captain-badge-card { padding: 8px 10px; margin-top: 6px; }
                .telemetry-strip { padding: 6px 18px; }
                .feed-header { padding: 8px 18px 4px 18px; }
                #feed-container { padding: 6px 18px 24px 18px; }
            }

            .pulse-ring {
                position: absolute;
                width: 38px;
                height: 38px;
                border-radius: 50%;
                background: rgba(14, 165, 233, 0.3);
                animation: car-radiate 2.2s infinite ease-out;
            }
            .pulse-core {
                width: 20px;
                height: 20px;
                background: #0EA5E9;
                border: 2.5px solid #FFFFFF;
                border-radius: 50%;
                box-shadow: 0 0 16px rgba(14, 165, 233, 0.9);
                position: relative;
                z-index: 2;
            }
            @keyframes car-radiate {
                0% { transform: scale(0.6); opacity: 1; }
                100% { transform: scale(1.7); opacity: 0; }
            }
        </style>
    </head>
    <body>
        <aside id="ops-panel">
            <div class="drawer-handle-bar" onclick="toggleMobileDrawer()">
                <div class="drawer-pill"></div>
            </div>

            <div class="panel-header">
                <div class="brand-row">
                    <div class="brand-badge">
                        <div class="brand-icon">P</div>
                        <span>SafeTrack Operations</span>
                    </div>
                    <div id="conn-pill" class="live-pill">
                        <span class="live-dot"></span>
                        <span id="conn-status">Link Active</span>
                    </div>
                </div>

                <div class="captain-badge-card">
                    <div class="captain-left">
                        <div class="captain-avatar">AZ</div>
                        <div class="captain-meta">
                            <h4>Ahmad Al-Zoubi • Kia Niro</h4>
                            <p>Trip PR-9942 • Plate 24-81923</p>
                        </div>
                    </div>
                    <button class="gps-sync-btn" onclick="syncBrowserGPS()">📍 SYNC DEVICE GPS</button>
                </div>
            </div>

            <div class="telemetry-strip">
                <div class="telemetry-tile">
                    <div id="stat-speed" class="val">0 km/h</div>
                    <div class="label">Speed</div>
                </div>
                <div class="telemetry-tile">
                    <div id="stat-alerts" class="val">0</div>
                    <div class="label">Events</div>
                </div>
                <div class="telemetry-tile">
                    <div id="stat-breaches" class="val" style="color: var(--status-red);">0</div>
                    <div class="label">Priority</div>
                </div>
            </div>

            <div class="feed-header">
                <span>In-Cabin Telemetry & Vision</span>
                <span id="location-label" style="font-family: 'JetBrains Mono', monospace; font-size: 9px;">AMMAN - JORDAN</span>
            </div>

            <div id="feed-container">
                <div style="text-align: center; color: #475569; font-size: 12px; margin-top: 24px;">
                    Monitoring active vehicle corridor...
                </div>
            </div>
        </aside>

        <main id="map"></main>

        <script>
            let currentLat = 31.9715;
            let currentLon = 35.8354;

            const map = L.map('map', { zoomControl: false }).setView([currentLat, currentLon], 15);
            L.control.zoom({ position: 'bottomright' }).addTo(map);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

            let alertCount = 0;
            let breachCount = 0;
            let centered = false;

            const trail = L.polyline([], {
                color: '#0EA5E9',
                weight: 4,
                opacity: 0.75,
                dashArray: '6, 8'
            });

            const vehicleIcon = L.divIcon({
                className: '',
                html: '<div style="position:relative;display:flex;align-items:center;justify-content:center;width:40px;height:40px;"><div class="pulse-ring"></div><div class="pulse-core"></div></div>',
                iconSize: [40, 40],
                iconAnchor: [20, 20]
            });

            const vehicleMarker = L.marker([currentLat, currentLon], { icon: vehicleIcon, zIndexOffset: 1000 }).addTo(map);

            // Fetch server's current cached GPS on initial load
            fetch('/api/telemetry/current')
                .then(r => r.json())
                .then(data => {
                    if (data && data.latitude && data.longitude) {
                        onLocation(data);
                    }
                })
                .catch(() => {});

            function toggleMobileDrawer() {
                const panel = document.getElementById('ops-panel');
                panel.classList.toggle('collapsed');
                setTimeout(() => { map.invalidateSize(); }, 340);
            }

            function syncBrowserGPS() {
                const btn = document.querySelector('.gps-sync-btn');
                btn.innerText = "📍 LOCATING...";

                const pushLocation = (lat, lon, label) => {
                    btn.innerText = "✅ " + label;
                    fetch('/api/telemetry/location', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            child_id: "child_01",
                            latitude: lat,
                            longitude: lon,
                            speed: 0.0
                        })
                    });
                };

                if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                        (pos) => {
                            pushLocation(pos.coords.latitude, pos.coords.longitude, "GPS LOCKED");
                        },
                        (err) => {
                            console.warn("Browser GPS blocked, falling back to IP Geolocation:", err.message);
                            // Fallback: IP-based lookup for Amman
                            fetch('https://ipapi.co/json/')
                                .then(res => res.json())
                                .then(data => {
                                    if (data && data.latitude && data.longitude) {
                                        pushLocation(data.latitude, data.longitude, "IP LOC LOCKED");
                                    } else {
                                        btn.innerText = "❌ GPS BLOCKED";
                                    }
                                })
                                .catch(() => {
                                    btn.innerText = "❌ GPS BLOCKED";
                                });
                        },
                        { enableHighAccuracy: true, timeout: 5000 }
                    );
                } else {
                    btn.innerText = "❌ NOT SUPPORTED";
                }
            }

            function onLocation(data) {
                const lat = data.latitude;
                const lon = data.longitude;
                const speed = Math.round((data.speed || 0) * 3.6);

                document.getElementById('stat-speed').innerText = speed + " km/h";
                document.getElementById('location-label').innerText = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

                vehicleMarker.setLatLng([lat, lon]);
                trail.addLatLng([lat, lon]);

                if (!centered) {
                    map.setView([lat, lon], 16);
                    centered = true;
                } else {
                    map.panTo([lat, lon], { animate: true, duration: 0.8 });
                }
            }

            function onIncident(alert, fly = false) {
                const isBreach = alert.status === "IMPOSTOR_BLOCKED" || 
                                 alert.status === "CRITICAL_ESCALATION" || 
                                 alert.status === "MANUAL_SOS_TRIGGERED" ||
                                 alert.status === "DISTRESS_DETECTED" ||
                                 alert.status === "ESCALATED" ||
                                 alert.status === "INCIDENT_FLAGGED" ||
                                 (alert.sound_type && (
                                     alert.sound_type.toLowerCase().includes("scream") || 
                                     alert.sound_type.toLowerCase().includes("distress") || 
                                     alert.sound_type.toLowerCase().includes("crash") ||
                                     alert.sound_type.toLowerCase().includes("unauthorized") ||
                                     alert.sound_type.toLowerCase().includes("spatial") ||
                                     alert.sound_type.toLowerCase().includes("replay")
                                 ));

                if (isBreach) breachCount++;
                alertCount++;

                document.getElementById('stat-alerts').innerText = alertCount;
                document.getElementById('stat-breaches').innerText = breachCount;

                const feed = document.getElementById('feed-container');
                if (feed.innerHTML.includes("Monitoring active vehicle")) {
                    feed.innerHTML = "";
                }

                const card = document.createElement('div');
                card.className = `event-card ${isBreach ? 'escalated' : 'safe'}`;
                card.innerHTML = `
                    <div class="card-top">
                        <div class="card-title">${alert.sound_type}</div>
                        <span class="badge ${isBreach ? 'badge-breach' : 'badge-safe'}">
                            ${isBreach ? 'PRIORITY DISPATCH' : 'PASSENGER SAFE'}
                        </span>
                    </div>
                    <div class="card-body">
                        ${alert.details || 'Cabin status logged.'}
                    </div>
                    <div class="card-footer">
                        <span>CONFIDENCE: ${(alert.confidence * 100).toFixed(0)}%</span>
                        <span>${alert.timestamp || 'Just now'}</span>
                    </div>
                `;

                if (alert.latitude && alert.longitude) {
                    card.onclick = () => {
                        map.flyTo([alert.latitude, alert.longitude], 17, { animate: true, duration: 1.0 });
                    };

                    const marker = L.circleMarker([alert.latitude, alert.longitude], {
                        radius: 8,
                        fillColor: isBreach ? '#EF4444' : '#10B981',
                        color: '#FFFFFF',
                        weight: 2,
                        fillOpacity: 0.95
                    }).addTo(map);

                    marker.bindPopup(`<b>${alert.sound_type}</b><br>${isBreach ? 'PRIORITY DISPATCH' : 'PASSENGER SAFE'}`);
                    if (fly) marker.openPopup();
                }

                feed.prepend(card);
            }

            fetch('/api/alerts')
                .then(r => r.json())
                .then(data => data.reverse().forEach(a => onIncident(a, false)))
                .catch(() => {});

            const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            const ws = new WebSocket(wsProtocol + "//" + window.location.host + "/ws");

            ws.onopen = () => {
                document.getElementById('conn-status').innerText = "Live Telemetry";
            };

            ws.onmessage = (e) => {
                const packet = JSON.parse(e.data);
                if (packet.type === "LOCATION_TELEMETRY") {
                    onLocation(packet);
                } else {
                    onIncident(packet, true);
                }
            };

            ws.onclose = () => {
                const el = document.getElementById('conn-pill');
                el.style.color = "#EF4444";
                document.getElementById('conn-status').innerText = "Offline";
            };
        </script>
    </body>
    </html>
    """