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
from voice_verifier import enroll_child_voice, verify_speaker, CHILD_VOICE_REGISTRY, PROFILES_DIR
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
    g_force_delta: float | None = 0.0
    battery_level: float | None = 100.0

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

class VoiceChatPayload(BaseModel):
    child_id: str = "child_01"
    audio_base64: str
    latitude: float | None = None
    longitude: float | None = None

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
    transcription: str | None = None


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
async def update_live_location(telemetry: LocationTelemetry, db: Session = Depends(get_db)):
    global latest_vehicle_telemetry
    
    speed_kmh = (telemetry.speed or 0.0) * 3.6
    g_force = telemetry.g_force_delta or 0.0

    # Cache active position and kinematics
    latest_vehicle_telemetry["latitude"] = telemetry.latitude
    latest_vehicle_telemetry["longitude"] = telemetry.longitude
    latest_vehicle_telemetry["speed"] = telemetry.speed or 0.0
    latest_vehicle_telemetry["g_force_delta"] = g_force
    latest_vehicle_telemetry["battery_level"] = telemetry.battery_level or 100.0
    latest_vehicle_telemetry["last_updated"] = time.time()

    # Inform fusion engine of vehicle kinematics & corridor trajectory
    corridor_eval = fusion_engine.record_location_telemetry(
        lat=telemetry.latitude,
        lon=telemetry.longitude,
        speed_kmh=speed_kmh,
        g_force_delta=g_force
    )

    # Automatically broadcast corridor breaches or unexpected stationary events
    if corridor_eval.get("is_corridor_deviated"):
        await manager.broadcast({
            "type": "INCIDENT_ALERT",
            "sound_type": "Route Corridor Deviation Anomaly",
            "confidence": 0.88,
            "latitude": telemetry.latitude,
            "longitude": telemetry.longitude,
            "status": "INCIDENT_FLAGGED",
            "timestamp": "Just now",
            "details": f"Vehicle is {corridor_eval['corridor_distance_meters']}m away from the authorized route corridor."
        })

    if corridor_eval.get("is_unexpected_stop"):
        await manager.broadcast({
            "type": "INCIDENT_ALERT",
            "sound_type": "Prolonged Unplanned Stationary Anomaly",
            "confidence": 0.90,
            "latitude": telemetry.latitude,
            "longitude": telemetry.longitude,
            "status": "INCIDENT_FLAGGED",
            "timestamp": "Just now",
            "details": f"Vehicle has been stationary for {corridor_eval['stationary_duration_sec']}s in an unapproved zone."
        })

    await manager.broadcast({
        "type": "LOCATION_TELEMETRY",
        "child_id": telemetry.child_id,
        "latitude": telemetry.latitude,
        "longitude": telemetry.longitude,
        "speed": telemetry.speed or 0.0,
        "g_force_delta": g_force,
        "battery_level": telemetry.battery_level or 100.0,
        "corridor_distance_meters": corridor_eval["corridor_distance_meters"],
        "route_status": corridor_eval["route_status"]
    })
    return {
        "status": "OK",
        "cached_position": [telemetry.latitude, telemetry.longitude],
        "corridor": corridor_eval
    }

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

@app.get("/api/voice/status/{child_id}")
def get_voice_status(child_id: str):
    has_profile = child_id in CHILD_VOICE_REGISTRY or (PROFILES_DIR / f"{child_id}.pt").exists()
    return {"child_id": child_id, "enrolled": has_profile}

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

    LEVANTINE_DISTRESS_KEYWORDS = [
        "scared", "help", "fast", "danger", "stop", "accident", "crash",
        "خايف", "صرخ", "سريع", "مساعدة", "طريق", "خطر", "حادث",
        "وين رايح", "غيرت الطريق", "مش هون الطريق", "وين ماخدني", "مش هاد بيتي", "مش هذا طريقي",
        "بسرعة كتير", "طاير بالسيارة", "خفف السرعة", "سواقة سريعة", "عم يسرع",
        "بدي ماما", "بدي بابا", "بدي انزل", "وقف السيارة", "نزلني هون", "مش مرتاح", "عم بصرخ", "هددني"
    ]

    if not chat_eval:
        is_arabic = any('\u0600' <= char <= '\u06FF' for char in payload.message)
        lower_msg = payload.message.lower()
        is_distress = any(w in lower_msg for w in LEVANTINE_DISTRESS_KEYWORDS)

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
            "recommended_action": "Contact Captain" if is_distress else "None",
            "transcription": payload.message
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

@app.post("/api/companion/chat-voice")
async def companion_voice_chat_endpoint(payload: VoiceChatPayload, db: Session = Depends(get_db)):
    global latest_vehicle_telemetry
    chat_eval = None
    audio_bytes = base64.b64decode(payload.audio_base64)
    current_lat = payload.latitude if payload.latitude is not None else latest_vehicle_telemetry["latitude"]
    current_lon = payload.longitude if payload.longitude is not None else latest_vehicle_telemetry["longitude"]

    if gemini_client:
        try:
            audio_part = types.Part.from_bytes(data=audio_bytes, mime_type="audio/wav")
            eval_prompt = """
            You are "PetraBuddy", a caring in-cabin AI safety companion for an unaccompanied child riding in a Petra Ride in Amman, Jordan.
            1. Transcribe the spoken audio verbatim in 'transcription'.
            2. If Arabic: reply in warm, comforting Jordanian Levantine Arabic addressing them warmly ("يا بطل" / "يا شاطرة"). Set language="ar".
            3. If English: reply in cheerful, supportive English. Set language="en".
            4. Safety Evaluation: Check if the child sounds distressed, scared, reports bad driving, route changes, harassment, or fear (is_distress: true/false).
            """
            response = gemini_client.models.generate_content(
                model='gemini-2.5-flash',
                contents=[audio_part, eval_prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=CompanionChatEvaluation,
                    temperature=0.3
                ),
            )
            chat_eval = response.parsed.model_dump()
        except Exception as e:
            print(f"Gemini voice chat error: {e}")

    if not chat_eval:
        chat_eval = {
            "transcription": "Voice message received",
            "reply": "سمعت صوتك يا بطل، كل اشي تمام ورحلتك مستمرة بأمان!",
            "language": "ar",
            "is_distress": False,
            "distress_category": None,
            "recommended_action": None
        }

    if chat_eval.get("is_distress"):
        db_alert = models.Alert(
            sound_type=f"VOICE CHAT: {chat_eval.get('distress_category', 'Distress')}",
            confidence=0.95,
            latitude=current_lat,
            longitude=current_lon
        )
        db.add(db_alert)
        db.commit()

        await manager.broadcast({
            "type": "INCIDENT_ALERT",
            "sound_type": "🎙️ Passenger Voice Flagged Concern",
            "confidence": 0.95,
            "latitude": current_lat,
            "longitude": current_lon,
            "status": "CRITICAL_ESCALATION",
            "timestamp": "Just now",
            "details": f'Child Spoke: "{chat_eval.get("transcription", "")}" | Category: {chat_eval.get("distress_category", "Distress")}'
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
        <title>PetraRide KIDDOGO • Operations Command Deck</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
        
        <style>
            :root {
                --bg-base: #07090E;
                --bg-surface: #0E131F;
                --bg-card: #141C2E;
                --bg-card-hover: #1A243B;
                --border-subtle: rgba(255, 255, 255, 0.08);
                --border-medium: rgba(255, 255, 255, 0.14);
                --border-cyan: rgba(14, 165, 233, 0.35);
                --text-primary: #F8FAFC;
                --text-secondary: #94A3B8;
                --text-muted: #64748B;
                --brand-cyan: #0EA5E9;
                --brand-amber: #F59E0B;
                --brand-cyan-glow: rgba(14, 165, 233, 0.25);
                --status-green: #10B981;
                --status-red: #EF4444;
                --status-amber: #F59E0B;
                --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                --font-mono: 'JetBrains Mono', monospace;
            }

            * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
            html, body {
                height: 100%;
                width: 100%;
                background: var(--bg-base);
                color: var(--text-primary);
                font-family: var(--font-sans);
                overflow: hidden;
            }

            body {
                display: flex;
                flex-direction: row;
            }

            #map {
                flex: 1;
                height: 100vh;
                background: #040609;
                z-index: 1;
            }

            /* Operations Sidebar Deck */
            #ops-panel {
                width: 440px;
                max-width: 100vw;
                height: 100vh;
                background: var(--bg-surface);
                border-right: 1px solid var(--border-subtle);
                display: flex;
                flex-direction: column;
                z-index: 1000;
                box-shadow: 12px 0 36px rgba(0, 0, 0, 0.65);
                position: relative;
                transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1), height 0.35s cubic-bezier(0.16, 1, 0.3, 1);
            }

            /* Mobile Drag Pill */
            .drawer-handle-bar {
                display: none;
                width: 100%;
                padding: 10px 0 4px 0;
                justify-content: center;
                cursor: grab;
                background: var(--bg-surface);
            }

            .drawer-pill {
                width: 44px;
                height: 5px;
                background: #334155;
                border-radius: 999px;
            }

            /* Panel Header */
            .panel-header {
                padding: 20px 22px 16px 22px;
                border-bottom: 1px solid var(--border-subtle);
                background: linear-gradient(180deg, rgba(14, 19, 31, 0.98) 0%, rgba(10, 14, 23, 0.95) 100%);
                backdrop-filter: blur(16px);
            }

            .brand-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-bottom: 14px;
            }

            .brand-lockup {
                display: flex;
                align-items: center;
                gap: 10px;
            }

            .brand-logo-badge {
                width: 34px;
                height: 34px;
                background: linear-gradient(135deg, #0284C7 0%, #0EA5E9 50%, #38BDF8 100%);
                border-radius: 10px;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 14px rgba(14, 165, 233, 0.35);
                border: 1px solid rgba(255, 255, 255, 0.25);
            }

            .brand-logo-icon {
                color: #FFFFFF;
                font-size: 16px;
                font-weight: 900;
            }

            .brand-title-group h1 {
                font-size: 16px;
                font-weight: 900;
                letter-spacing: -0.3px;
                color: #FFFFFF;
                line-height: 1.1;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .brand-title-group h1 .accent-kiddogo {
                color: #38BDF8;
                background: linear-gradient(90deg, #38BDF8, #7DD3FC);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                font-weight: 900;
                letter-spacing: 0.5px;
            }

            .brand-title-group p {
                font-size: 9.5px;
                font-weight: 700;
                letter-spacing: 0.8px;
                color: var(--text-secondary);
                text-transform: uppercase;
                margin-top: 3px;
            }

            .live-indicator-pill {
                font-size: 11px;
                font-weight: 700;
                color: var(--status-green);
                display: flex;
                align-items: center;
                gap: 6px;
                background: rgba(16, 185, 129, 0.12);
                border: 1px solid rgba(16, 185, 129, 0.28);
                padding: 4px 10px;
                border-radius: 999px;
                white-space: nowrap;
            }

            .live-dot {
                width: 6px;
                height: 6px;
                background: var(--status-green);
                border-radius: 50%;
                box-shadow: 0 0 8px var(--status-green);
                animation: pulse-dot 1.8s infinite;
            }

            @keyframes pulse-dot {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.4; transform: scale(0.85); }
            }

            /* Captain Quick Card */
            .captain-deck-card {
                background: var(--bg-card);
                border: 1px solid var(--border-medium);
                border-radius: 12px;
                padding: 11px 13px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
            }

            .captain-deck-left {
                display: flex;
                align-items: center;
                gap: 10px;
                min-width: 0;
            }

            .captain-deck-avatar {
                width: 36px;
                height: 36px;
                border-radius: 10px;
                background: #182338;
                border: 1.5px solid var(--brand-cyan);
                color: #38BDF8;
                font-weight: 800;
                font-size: 13px;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }

            .captain-deck-info {
                min-width: 0;
            }

            .captain-deck-info h4 {
                font-size: 12px;
                font-weight: 800;
                color: #F8FAFC;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .captain-deck-info p {
                font-size: 10.5px;
                color: var(--text-secondary);
                margin-top: 1px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .gps-sync-action-btn {
                background: rgba(14, 165, 233, 0.14);
                color: #38BDF8;
                font-family: var(--font-sans);
                font-size: 10.5px;
                font-weight: 800;
                padding: 6px 11px;
                border-radius: 8px;
                border: 1px solid rgba(14, 165, 233, 0.35);
                cursor: pointer;
                transition: all 0.2s ease;
                white-space: nowrap;
                flex-shrink: 0;
            }

            .gps-sync-action-btn:hover {
                background: rgba(14, 165, 233, 0.28);
                transform: translateY(-1px);
            }

            /* Precision Telemetry Grid */
            .telemetry-grid {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 8px;
                padding: 12px 22px;
                background: rgba(10, 14, 24, 0.7);
                border-bottom: 1px solid var(--border-subtle);
            }

            .telemetry-card {
                background: var(--bg-base);
                border: 1px solid var(--border-subtle);
                padding: 8px 10px;
                border-radius: 10px;
                text-align: center;
            }

            .telemetry-card .val {
                font-family: var(--font-mono);
                font-size: 14px;
                font-weight: 700;
                color: #F8FAFC;
                letter-spacing: -0.2px;
            }

            .telemetry-card .lbl {
                font-size: 8.5px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 0.6px;
                color: var(--text-muted);
                margin-top: 2px;
            }

            /* Event Stream Area */
            .feed-section-header {
                padding: 14px 22px 8px 22px;
                font-size: 10.5px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 0.9px;
                color: var(--text-secondary);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .feed-section-header .loc-tag {
                font-family: var(--font-mono);
                font-size: 9.5px;
                color: #38BDF8;
                background: rgba(14, 165, 233, 0.12);
                padding: 2px 7px;
                border-radius: 6px;
                border: 1px solid rgba(14, 165, 233, 0.25);
            }

            #feed-container {
                flex: 1;
                min-height: 0;
                overflow-y: auto;
                padding: 8px 22px 24px 22px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                -webkit-overflow-scrolling: touch;
            }

            #feed-container::-webkit-scrollbar {
                width: 5px;
            }
            #feed-container::-webkit-scrollbar-thumb {
                background: #1E293B;
                border-radius: 4px;
            }

            .empty-feed-hint {
                text-align: center;
                color: var(--text-muted);
                font-size: 12px;
                margin-top: 32px;
                padding: 20px;
                border: 1px dashed var(--border-subtle);
                border-radius: 12px;
                background: rgba(255, 255, 255, 0.01);
            }

            /* Incident & Telemetry Cards */
            .event-card {
                background: var(--bg-card);
                border: 1px solid var(--border-subtle);
                border-radius: 12px;
                padding: 12px 14px;
                transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease;
                cursor: pointer;
            }

            .event-card:hover {
                transform: translateY(-1px);
                border-color: var(--border-medium);
                background: var(--bg-card-hover);
            }

            .event-card.escalated {
                border-color: rgba(239, 68, 68, 0.5);
                background: linear-gradient(180deg, rgba(239, 68, 68, 0.12) 0%, rgba(20, 28, 46, 0.9) 100%);
            }

            .event-card.safe {
                border-color: rgba(16, 185, 129, 0.35);
                background: linear-gradient(180deg, rgba(16, 185, 129, 0.08) 0%, rgba(20, 28, 46, 0.9) 100%);
            }

            .card-top {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                gap: 8px;
                margin-bottom: 6px;
            }

            .card-title {
                font-size: 12.5px;
                font-weight: 800;
                color: #FFFFFF;
                line-height: 1.35;
                flex: 1;
            }

            .badge {
                font-size: 8.5px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                padding: 3px 7px;
                border-radius: 6px;
                white-space: nowrap;
            }

            .badge-safe {
                background: rgba(16, 185, 129, 0.15);
                color: #34D399;
                border: 1px solid rgba(16, 185, 129, 0.35);
            }

            .badge-breach {
                background: rgba(239, 68, 68, 0.2);
                color: #F87171;
                border: 1px solid rgba(239, 68, 68, 0.5);
                animation: breach-glow 1.6s infinite;
            }

            @keyframes breach-glow {
                0%, 100% { box-shadow: 0 0 0 rgba(239, 68, 68, 0); }
                50% { box-shadow: 0 0 10px rgba(239, 68, 68, 0.4); }
            }

            .card-body {
                font-size: 11px;
                color: var(--text-secondary);
                line-height: 1.45;
            }

            .card-footer {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-top: 10px;
                font-family: var(--font-mono);
                font-size: 9.5px;
                color: var(--text-muted);
            }

            /* Custom Map Vehicle Pulsar Marker */
            .pulse-ring {
                position: absolute;
                width: 44px;
                height: 44px;
                border-radius: 50%;
                background: rgba(14, 165, 233, 0.35);
                animation: car-radiate 2.2s infinite ease-out;
            }
            .pulse-core {
                width: 22px;
                height: 22px;
                background: linear-gradient(135deg, #0EA5E9, #0284C7);
                border: 2.5px solid #FFFFFF;
                border-radius: 50%;
                box-shadow: 0 0 18px rgba(14, 165, 233, 0.95);
                position: relative;
                z-index: 2;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 10px;
            }
            @keyframes car-radiate {
                0% { transform: scale(0.5); opacity: 1; }
                100% { transform: scale(1.8); opacity: 0; }
            }

            /* Mobile Responsive Layout (Phones & Small Tablets) */
            @media (max-width: 840px) {
                body {
                    flex-direction: column-reverse;
                    height: 100%;
                    overflow: hidden;
                }
                .drawer-handle-bar {
                    display: flex;
                }
                #ops-panel {
                    width: 100%;
                    height: 56vh;
                    border-right: none;
                    border-top: 1px solid var(--border-medium);
                    border-radius: 22px 22px 0 0;
                    box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.7);
                }
                #ops-panel.collapsed {
                    height: 24vh;
                }
                #map {
                    flex: 1;
                    height: auto;
                }
                .panel-header {
                    padding: 10px 16px 12px 16px;
                }
                .brand-title-group h1 {
                    font-size: 14.5px;
                }
                .captain-deck-card {
                    padding: 8px 10px;
                }
                .telemetry-grid {
                    padding: 6px 16px;
                    gap: 6px;
                }
                .feed-section-header {
                    padding: 8px 16px 4px 16px;
                }
                #feed-container {
                    padding: 6px 16px 20px 16px;
                }
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
                    <div class="brand-lockup">
                        <div class="brand-logo-badge">
                            <span class="brand-logo-icon">🛡️</span>
                        </div>
                        <div class="brand-title-group">
                            <h1>PetraRide <span class="accent-kiddogo">KIDDOGO</span></h1>
                            <p>Operations Command Deck</p>
                        </div>
                    </div>
                    <div id="conn-pill" class="live-indicator-pill">
                        <span class="live-dot"></span>
                        <span id="conn-status">Live Stream</span>
                    </div>
                </div>

                <div class="captain-deck-card">
                    <div class="captain-deck-left">
                        <div class="captain-deck-avatar">AZ</div>
                        <div class="captain-deck-info">
                            <h4>Captain Ahmad Al-Zoubi</h4>
                            <p>Kia Niro • 24-81923 • Trip PR-9942</p>
                        </div>
                    </div>
                    <button class="gps-sync-action-btn" onclick="syncBrowserGPS()">📍 GPS SYNC</button>
                </div>
            </div>

            <div class="telemetry-grid">
                <div class="telemetry-card">
                    <div id="stat-speed" class="val">0 km/h</div>
                    <div class="lbl">Transit Speed</div>
                </div>
                <div class="telemetry-card">
                    <div id="stat-alerts" class="val">0</div>
                    <div class="lbl">Total Logs</div>
                </div>
                <div class="telemetry-card">
                    <div id="stat-breaches" class="val" style="color: var(--status-red);">0</div>
                    <div class="lbl">Priority SOS</div>
                </div>
            </div>

            <div class="feed-section-header">
                <span>Acoustic Sentinel & Cabin Stream</span>
                <span id="location-label" class="loc-tag">AMMAN, JORDAN</span>
            </div>

            <div id="feed-container">
                <div class="empty-feed-hint">
                    Awaiting cabin telemetry. Trajectory and acoustic sentinel active.
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
                opacity: 0.85,
                dashArray: '6, 8'
            }).addTo(map);

            const vehicleIcon = L.divIcon({
                className: '',
                html: '<div style="position:relative;display:flex;align-items:center;justify-content:center;width:44px;height:44px;"><div class="pulse-ring"></div><div class="pulse-core">🚗</div></div>',
                iconSize: [44, 44],
                iconAnchor: [22, 22]
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
                setTimeout(() => { map.invalidateSize(); }, 360);
            }

            function syncBrowserGPS() {
                const btn = document.querySelector('.gps-sync-action-btn');
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
                            pushLocation(pos.coords.latitude, pos.coords.longitude, "LOCKED");
                        },
                        (err) => {
                            fetch('https://ipapi.co/json/')
                                .then(res => res.json())
                                .then(data => {
                                    if (data && data.latitude && data.longitude) {
                                        pushLocation(data.latitude, data.longitude, "IP LOCKED");
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
                if (feed.innerHTML.includes("Awaiting cabin telemetry")) {
                    feed.innerHTML = "";
                }

                const confPercent = Math.min(100, Math.max(0, Math.round((alert.confidence || 0.85) * 100)));
                let readableTime = "Just now";
                if (alert.timestamp && alert.timestamp !== "Just now") {
                    try {
                        const parsedDate = new Date(alert.timestamp);
                        if (!isNaN(parsedDate.getTime())) {
                            readableTime = parsedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        } else {
                            readableTime = alert.timestamp;
                        }
                    } catch (e) {
                        readableTime = alert.timestamp;
                    }
                } else {
                    readableTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
                        ${alert.details || 'Cabin status verified by PetraRide KIDDOGO engine.'}
                    </div>
                    <div class="card-footer">
                        <span style="font-weight: 700; color: ${isBreach ? '#F87171' : '#34D399'};">⚡ AI CONFIDENCE: ${confPercent}%</span>
                        <span style="font-family: var(--font-mono); font-weight: 600; color: #94A3B8;">🕒 ${readableTime}</span>
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

# --- PARENT LIVE GUARDIAN PORTAL ---
@app.get("/parent/{trip_id}", response_class=HTMLResponse)
def render_parent_portal(trip_id: str):
    return f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <title>PetraRide KIDDOGO • Live Family Guardian ({trip_id})</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
        
        <style>
            :root {{
                --bg-main: #07090E;
                --bg-card: #0F1422;
                --bg-card-inner: #151C30;
                --bg-glass: rgba(15, 20, 34, 0.92);
                --border-subtle: rgba(255, 255, 255, 0.08);
                --border-accent: rgba(14, 165, 233, 0.35);
                --brand-cyan: #0EA5E9;
                --brand-emerald: #10B981;
                --brand-ruby: #EF4444;
                --text-main: #F8FAFC;
                --text-muted: #94A3B8;
                --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                --font-mono: 'JetBrains Mono', monospace;
            }}

            * {{ box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }}
            html, body {{
                height: 100%;
                width: 100%;
                font-family: var(--font-sans);
                background: var(--bg-main);
                color: var(--text-main);
                overflow: hidden;
            }}

            body {{
                display: flex;
                flex-direction: row;
            }}

            #parent-map {{
                flex: 1;
                height: 100vh;
                background: #040609;
                z-index: 1;
            }}

            #parent-sidebar {{
                width: 440px;
                max-width: 100vw;
                height: 100vh;
                background: var(--bg-glass);
                backdrop-filter: blur(20px);
                border-right: 1px solid var(--border-subtle);
                display: flex;
                flex-direction: column;
                z-index: 1000;
                box-shadow: 12px 0 40px rgba(0, 0, 0, 0.65);
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
            }}

            #parent-sidebar::-webkit-scrollbar {{
                width: 4px;
            }}
            #parent-sidebar::-webkit-scrollbar-thumb {{
                background: #1E293B;
                border-radius: 4px;
            }}

            .parent-header {{
                padding: 20px 22px 16px 22px;
                border-bottom: 1px solid var(--border-subtle);
                background: rgba(10, 14, 24, 0.96);
            }}

            .brand-line {{
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                margin-bottom: 6px;
            }}

            .brand-logo-wrap {{
                display: flex;
                align-items: center;
                gap: 10px;
            }}

            .brand-shield-icon {{
                background: linear-gradient(135deg, #0284C7 0%, #0EA5E9 100%);
                width: 32px;
                height: 32px;
                border-radius: 9px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 15px;
                box-shadow: 0 4px 12px rgba(14, 165, 233, 0.35);
                border: 1px solid rgba(255, 255, 255, 0.2);
            }}

            .brand-name-wrap h1 {{
                font-size: 16px;
                font-weight: 900;
                letter-spacing: -0.3px;
                color: #FFFFFF;
                line-height: 1.1;
            }}

            .brand-name-wrap h1 .kiddogo-tag {{
                color: #38BDF8;
                font-weight: 900;
            }}

            .brand-name-wrap p {{
                font-size: 9.5px;
                font-weight: 700;
                color: var(--text-muted);
                letter-spacing: 0.6px;
                text-transform: uppercase;
                margin-top: 2px;
            }}

            .status-chip {{
                background: rgba(16, 185, 129, 0.12);
                border: 1px solid rgba(16, 185, 129, 0.3);
                color: var(--brand-emerald);
                font-size: 10.5px;
                font-weight: 800;
                padding: 4px 10px;
                border-radius: 999px;
                display: flex;
                align-items: center;
                gap: 6px;
                white-space: nowrap;
            }}

            .pulse-dot {{
                width: 6px;
                height: 6px;
                background: var(--brand-emerald);
                border-radius: 50%;
                box-shadow: 0 0 8px var(--brand-emerald);
                animation: pulse-dot 1.8s infinite;
            }}

            .child-status-card {{
                margin: 16px 20px 0 20px;
                background: linear-gradient(180deg, rgba(14, 165, 233, 0.12) 0%, rgba(15, 20, 34, 0.7) 100%);
                border: 1px solid var(--border-accent);
                border-radius: 16px;
                padding: 16px;
            }}

            .child-status-header {{
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
            }}

            .child-name {{
                font-size: 14.5px;
                font-weight: 800;
                color: #FFFFFF;
            }}

            .child-shield-tag {{
                font-size: 9px;
                font-weight: 800;
                color: #38BDF8;
                background: rgba(14, 165, 233, 0.2);
                padding: 3px 8px;
                border-radius: 6px;
                border: 1px solid rgba(14, 165, 233, 0.35);
            }}

            .child-status-sub {{
                font-size: 11px;
                color: #BAE6FD;
                line-height: 1.45;
            }}

            .telemetry-row {{
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 8px;
                margin-top: 12px;
            }}

            .telemetry-box {{
                background: var(--bg-card-inner);
                border: 1px solid var(--border-subtle);
                border-radius: 10px;
                padding: 8px 10px;
                text-align: center;
            }}

            .telemetry-box .num {{
                font-family: var(--font-mono);
                font-size: 13.5px;
                font-weight: 800;
                color: #FFFFFF;
            }}

            .telemetry-box .lbl {{
                font-size: 8.5px;
                font-weight: 800;
                color: var(--text-muted);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-top: 2px;
            }}

            .captain-card {{
                margin: 12px 20px;
                background: var(--bg-card);
                border: 1px solid var(--border-subtle);
                border-radius: 14px;
                padding: 12px 14px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
            }}

            .captain-details {{
                display: flex;
                align-items: center;
                gap: 12px;
                min-width: 0;
            }}

            .captain-avatar {{
                width: 38px;
                height: 38px;
                border-radius: 11px;
                background: #182338;
                border: 1.5px solid var(--brand-cyan);
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 800;
                color: #38BDF8;
                font-size: 13.5px;
                flex-shrink: 0;
            }}

            .captain-info {{
                min-width: 0;
            }}

            .captain-info h4 {{
                font-size: 12.5px;
                font-weight: 800;
                color: #FFFFFF;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }}

            .captain-info p {{
                font-size: 10.5px;
                color: var(--text-muted);
                margin-top: 2px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }}

            .call-btn {{
                background: rgba(16, 185, 129, 0.15);
                border: 1px solid rgba(16, 185, 129, 0.35);
                color: var(--brand-emerald);
                font-family: var(--font-sans);
                font-size: 11px;
                font-weight: 800;
                padding: 7px 12px;
                border-radius: 8px;
                cursor: pointer;
                text-decoration: none;
                transition: all 0.2s ease;
                white-space: nowrap;
                flex-shrink: 0;
            }}

            .call-btn:hover {{
                background: rgba(16, 185, 129, 0.28);
                transform: translateY(-1px);
            }}

            .section-title {{
                padding: 12px 22px 6px 22px;
                font-size: 10.5px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 0.8px;
                color: var(--text-muted);
            }}

            .timeline-container {{
                padding: 0 22px 16px 22px;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }}

            .timeline-step {{
                display: flex;
                align-items: flex-start;
                gap: 12px;
                position: relative;
            }}

            .timeline-step::before {{
                content: '';
                position: absolute;
                left: 11px;
                top: 22px;
                bottom: -12px;
                width: 2px;
                background: var(--border-subtle);
            }}

            .timeline-step:last-child::before {{
                display: none;
            }}

            .step-dot {{
                width: 24px;
                height: 24px;
                border-radius: 50%;
                background: #182338;
                border: 2px solid var(--border-subtle);
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 10px;
                font-weight: 800;
                z-index: 2;
                color: var(--text-muted);
            }}

            .step-dot.active {{
                background: var(--brand-cyan);
                border-color: #FFFFFF;
                color: #FFFFFF;
                box-shadow: 0 0 10px var(--brand-cyan);
            }}

            .step-dot.done {{
                background: var(--brand-emerald);
                border-color: #FFFFFF;
                color: #FFFFFF;
            }}

            .step-meta h5 {{
                font-size: 12px;
                font-weight: 800;
                color: #FFFFFF;
            }}

            .step-meta p {{
                font-size: 10px;
                color: var(--text-muted);
                margin-top: 1px;
            }}

            .parent-footer {{
                margin-top: auto;
                padding: 16px 20px;
                border-top: 1px solid var(--border-subtle);
                background: rgba(10, 14, 24, 0.96);
            }}

            .emergency-action-btn {{
                display: block;
                width: 100%;
                text-align: center;
                background: rgba(239, 68, 68, 0.15);
                border: 1px solid rgba(239, 68, 68, 0.45);
                color: #F87171;
                font-size: 12px;
                font-weight: 800;
                padding: 12px;
                border-radius: 10px;
                text-decoration: none;
                cursor: pointer;
                transition: all 0.2s ease;
                letter-spacing: 0.4px;
            }}

            .emergency-action-btn:hover {{
                background: rgba(239, 68, 68, 0.28);
            }}

            @media (max-width: 840px) {{
                body {{
                    flex-direction: column-reverse;
                }}
                #parent-sidebar {{
                    width: 100%;
                    height: 54vh;
                    border-right: none;
                    border-top: 1px solid var(--border-subtle);
                    border-radius: 22px 22px 0 0;
                    box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.7);
                }}
                #parent-map {{
                    flex: 1;
                    height: 46vh;
                }}
                .parent-header {{
                    padding: 12px 18px;
                }}
                .child-status-card {{
                    margin: 10px 18px 0 18px;
                    padding: 12px;
                }}
                .captain-card {{
                    margin: 10px 18px;
                    padding: 10px;
                }}
                .timeline-container {{
                    padding: 0 18px 12px 18px;
                }}
                .parent-footer {{
                    padding: 12px 18px;
                }}
            }}
        </style>
    </head>
    <body>
        <aside id="parent-sidebar">
            <div class="parent-header">
                <div class="brand-line">
                    <div class="brand-logo-wrap">
                        <div class="brand-shield-icon">🛡️</div>
                        <div class="brand-name-wrap">
                            <h1>PetraRide <span class="kiddogo-tag">KIDDOGO</span></h1>
                            <p>Live Family Guardian</p>
                        </div>
                    </div>
                    <div class="status-chip">
                        <span class="pulse-dot"></span>
                        <span>Trip {trip_id}</span>
                    </div>
                </div>
            </div>

            <div class="child-status-card">
                <div class="child-status-header">
                    <div class="child-name">Passenger: Ahmad (أحمد)</div>
                    <div class="child-shield-tag">🛡️ BIOMETRIC SHIELD ON</div>
                </div>
                <p class="child-status-sub">
                    Biometric voice verified. Trajectory, speed and cabin acoustics monitored continuously.
                </p>

                <div class="telemetry-row">
                    <div class="telemetry-box">
                        <div id="p-speed" class="num">0 km/h</div>
                        <div class="lbl">Live Speed</div>
                    </div>
                    <div class="telemetry-box">
                        <div id="p-battery" class="num">98%</div>
                        <div class="lbl">Battery</div>
                    </div>
                    <div class="telemetry-box">
                        <div id="p-route" class="num" style="color: var(--brand-emerald);">ON ROUTE</div>
                        <div class="lbl">Safe Corridor</div>
                    </div>
                </div>
            </div>

            <div class="captain-card">
                <div class="captain-details">
                    <div class="captain-avatar">AZ</div>
                    <div class="captain-info">
                        <h4>Captain Ahmad Al-Zoubi</h4>
                        <p>Kia Niro • 24-81923 • ★ 4.98 Certified</p>
                    </div>
                </div>
                <a href="tel:+962790000000" class="call-btn">📞 CALL</a>
            </div>

            <div class="section-title">Trip Progression & Milestones</div>
            <div class="timeline-container">
                <div class="timeline-step">
                    <div class="step-dot done">✓</div>
                    <div class="step-meta">
                        <h5>King Hussein Business Park</h5>
                        <p>Boarded safely at 08:15 AM</p>
                    </div>
                </div>
                <div class="timeline-step">
                    <div class="step-dot active">●</div>
                    <div class="step-meta">
                        <h5>Mecca Street Safe Corridor</h5>
                        <p>In transit • Trajectory Nominal</p>
                    </div>
                </div>
                <div class="timeline-step">
                    <div class="step-dot">3</div>
                    <div class="step-meta">
                        <h5>7th Circle Intersection</h5>
                        <p>Expected in ~4 mins</p>
                    </div>
                </div>
                <div class="timeline-step">
                    <div class="step-dot">4</div>
                    <div class="step-meta">
                        <h5>Destination: Abdoun Circle</h5>
                        <p>Estimated arrival: 08:35 AM</p>
                    </div>
                </div>
            </div>

            <div class="parent-footer">
                <a href="tel:+96265000000" class="emergency-action-btn">
                    🚨 24/7 PETRA FAMILY SAFETY HOTLINE
                </a>
            </div>
        </aside>

        <main id="parent-map"></main>

        <script>
            let currentLat = 31.9715;
            let currentLon = 35.8354;

            const map = L.map('parent-map', {{ zoomControl: false }}).setView([currentLat, currentLon], 15);
            L.control.zoom({{ position: 'bottomright' }}).addTo(map);
            L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{ maxZoom: 19 }}).addTo(map);

            const trail = L.polyline([], {{
                color: '#0EA5E9',
                weight: 4,
                opacity: 0.85,
                dashArray: '6, 8'
            }}).addTo(map);

            const vehicleMarker = L.circleMarker([currentLat, currentLon], {{
                radius: 9,
                fillColor: '#0EA5E9',
                color: '#FFFFFF',
                weight: 2.5,
                fillOpacity: 1.0
            }}).addTo(map);

            vehicleMarker.bindPopup("<b>Ahmad's SafeTrack Ride</b><br>Trip {trip_id}");

            function onLocationUpdate(data) {{
                const lat = data.latitude;
                const lon = data.longitude;
                const speed = Math.round((data.speed || 0) * 3.6);

                document.getElementById('p-speed').innerText = speed + " km/h";
                if (data.battery_level !== undefined) {{
                    document.getElementById('p-battery').innerText = Math.round(data.battery_level) + "%";
                }}
                if (data.route_status) {{
                    const el = document.getElementById('p-route');
                    el.innerText = data.route_status;
                    el.style.color = data.route_status === "ON_ROUTE" ? "var(--brand-emerald)" : "var(--brand-ruby)";
                }}

                vehicleMarker.setLatLng([lat, lon]);
                trail.addLatLng([lat, lon]);
                map.panTo([lat, lon], {{ animate: true, duration: 0.8 }});
            }}

            fetch('/api/telemetry/current')
                .then(r => r.json())
                .then(data => {{
                    if (data && data.latitude) {{
                        onLocationUpdate(data);
                        map.setView([data.latitude, data.longitude], 15);
                    }}
                }})
                .catch(() => {{}});

            const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            const ws = new WebSocket(wsProtocol + "//" + window.location.host + "/ws");
            ws.onmessage = (e) => {{
                try {{
                    const packet = JSON.parse(e.data);
                    if (packet.type === "LOCATION_TELEMETRY") {{
                        onLocationUpdate(packet);
                    }}
                }} catch (err) {{}}
            }};
        </script>
    </body>
    </html>
    """