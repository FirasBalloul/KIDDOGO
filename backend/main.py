from fastapi import FastAPI, Depends, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
import models
from database import engine, get_db

# Create the database tables
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="PetraKids Alert Brain")

class DistressAlert(BaseModel):
    sound_type: str
    confidence: float
    latitude: float | None = None
    longitude: float | None = None

# --- WEBSOCKET MANAGER ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            await connection.send_json(message)

manager = ConnectionManager()

# --- API ENDPOINTS ---
@app.get("/")
def health_check():
    return {"status": "Alert Brain is online"}

@app.post("/api/alerts")
async def receive_alert(alert: DistressAlert, db: Session = Depends(get_db)):
    # 1. Save to PostgreSQL
    db_alert = models.Alert(
        sound_type=alert.sound_type,
        confidence=alert.confidence,
        latitude=alert.latitude,
        longitude=alert.longitude
    )
    db.add(db_alert)
    db.commit()
    db.refresh(db_alert)
    
    print(f"✅ Saved to DB: Alert ID {db_alert.id} - {db_alert.sound_type}")
    
    # 2. Broadcast live to the Map Dashboard
    await manager.broadcast({
        "sound_type": db_alert.sound_type,
        "confidence": db_alert.confidence,
        "latitude": db_alert.latitude,
        "longitude": db_alert.longitude,
        "timestamp": str(db_alert.timestamp)
    })
    
    return {"message": "Alert saved & broadcasted successfully", "alert_id": db_alert.id}

@app.get("/api/alerts")
def get_all_alerts(db: Session = Depends(get_db)):
    return db.query(models.Alert).order_by(models.Alert.timestamp.desc()).limit(50).all()

# --- WEBSOCKET ENDPOINT ---
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text() # Keep connection alive
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# --- LIVE MAP DASHBOARD ---
@app.get("/map", response_class=HTMLResponse)
def render_map():
    return """
    <!DOCTYPE html>
    <html>
    <head>
        <title>PetraKids Command Center</title>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <style>
            :root {
                --bg-main: #0f172a;
                --bg-sidebar: #1e293b;
                --border-color: #334155;
                --text-main: #f8fafc;
                --text-muted: #94a3b8;
                --accent-red: #ef4444;
                --accent-green: #22c55e;
            }
            body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg-main); color: var(--text-main); display: flex; height: 100vh; overflow: hidden; }
            
            /* Sidebar Styling */
            #sidebar { width: 380px; background: var(--bg-sidebar); border-right: 1px solid var(--border-color); display: flex; flex-direction: column; z-index: 1000; }
            .sidebar-header { padding: 20px; border-bottom: 1px solid var(--border-color); }
            .sidebar-header h1 { font-size: 18px; margin: 0 0 4px 0; color: #fff; display: flex; align-items: center; gap: 8px; }
            .status-indicator { font-size: 12px; color: var(--accent-green); font-weight: 500; }
            
            /* Stats Row */
            .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 15px 20px; background: rgba(15, 23, 42, 0.4); border-bottom: 1px solid var(--border-color); }
            .stat-box { background: var(--bg-main); padding: 10px; border-radius: 6px; border: 1px solid var(--border-color); text-align: center; }
            .stat-box .val { font-size: 18px; font-weight: bold; color: #fff; }
            .stat-box .lbl { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-top: 2px; }

            /* Feed Section */
            .feed-title { padding: 12px 20px 4px 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.5px; }
            #alert-feed { flex: 1; overflow-y: auto; padding: 10px 20px; display: flex; flex-direction: column; gap: 10px; }
            
            .alert-card { background: var(--bg-main); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; transition: all 0.2s; }
            .alert-card.breach { border-color: rgba(239, 68, 68, 0.6); background: rgba(239, 68, 68, 0.05); }
            .alert-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
            .alert-type { font-weight: 600; font-size: 14px; }
            .alert-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 700; text-transform: uppercase; }
            .badge-breach { background: rgba(239, 68, 68, 0.2); color: var(--accent-red); }
            .badge-safe { background: rgba(34, 197, 94, 0.2); color: var(--accent-green); }
            .alert-details { font-size: 12px; color: var(--text-muted); display: flex; flex-direction: column; gap: 2px; }

            /* Map Container */
            #map { flex: 1; height: 100vh; }
        </style>
    </head>
    <body>
        <div id="sidebar">
            <div class="sidebar-header">
                <h1>🛡️ PetraKids Command</h1>
                <div id="connection-status" class="status-indicator">Connecting to Neural Stream...</div>
            </div>
            
            <div class="stats-grid">
                <div class="stat-box">
                    <div id="total-alerts" class="val">0</div>
                    <div class="lbl">Total Alerts</div>
                </div>
                <div class="stat-box">
                    <div id="total-breaches" class="val" style="color: var(--accent-red);">0</div>
                    <div class="lbl">Safe Breaches</div>
                </div>
            </div>

            <div class="feed-title">Live Telemetry Feed</div>
            <div id="alert-feed">
                <div style="color: var(--text-muted); font-size: 13px; text-align: center; margin-top: 40px;">
                    Waiting for device telemetry...
                </div>
            </div>
        </div>

        <div id="map"></div>

        <script>
            var map = L.map('map', { zoomControl: false }).setView([31.9702, 35.8354], 14);
            L.control.zoom({ position: 'bottomright' }).addTo(map);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap'
            }).addTo(map);

            var safeZoneCircle = null;
            let alertCount = 0;
            let breachCount = 0;

            // 1. Render Safe Zone perimeter
            fetch('/api/safe-zone')
                .then(r => r.json())
                .then(zone => {
                    safeZoneCircle = L.circle([zone.center_lat, zone.center_lon], {
                        color: '#22c55e',
                        fillColor: '#22c55e',
                        fillOpacity: 0.1,
                        radius: zone.radius_meters
                    }).addTo(map);
                    safeZoneCircle.bindPopup(`<b>${zone.name}</b><br>Radius: ${zone.radius_meters}m`);
                });

            // 2. Load historical logs into sidebar and map
            fetch('/api/alerts')
                .then(r => r.json())
                .then(alerts => {
                    alerts.reverse().forEach(a => handleNewAlert(a, false));
                });

            function handleNewAlert(alert, fly = false) {
                const isDistress = alert.sound_type && (
                    alert.sound_type.includes("Scream") || 
                    alert.sound_type.includes("Crying") || 
                    alert.sound_type.includes("Glass") || 
                    alert.sound_type.includes("Crash") || 
                    alert.sound_type.includes("Siren") ||
                    alert.sound_type.includes("BREACH")
                );

                if (alert.sound_type && alert.sound_type.includes("BREACH")) {
                    breachCount++;
                }

                alertCount++;
                document.getElementById('total-alerts').innerText = alertCount;
                document.getElementById('total-breaches').innerText = breachCount;

                const feed = document.getElementById('alert-feed');
                if (feed.innerHTML.includes("Waiting for device telemetry")) {
                    feed.innerHTML = "";
                }

                const card = document.createElement('div');
                card.className = `alert-card ${isDistress ? 'breach' : ''}`;
                card.innerHTML = `
                    <div class="alert-card-header">
                        <span class="alert-type">${alert.sound_type}</span>
                        <span class="alert-badge ${isDistress ? 'badge-breach' : 'badge-safe'}">
                            ${isDistress ? 'Alert' : 'Normal'}
                        </span>
                    </div>
                    <div class="alert-details">
                        <span>Confidence: ${(alert.confidence * 100).toFixed(0)}% | Distance: ${alert.distance_meters || 0}m</span>
                        <span style="font-size: 11px; opacity: 0.7;">${alert.timestamp}</span>
                    </div>
                `;
                feed.prepend(card);

                // RESTORED: Add map marker and animate map view
                if (alert.latitude && alert.longitude) {
                    var marker = L.marker([alert.latitude, alert.longitude]).addTo(map);
                    marker.bindPopup(`<b>${alert.sound_type}</b><br>Confidence: ${(alert.confidence * 100).toFixed(0)}%`);
                    
                    if (fly) {
                        map.flyTo([alert.latitude, alert.longitude], 15, { animate: true, duration: 1.2 });
                        marker.openPopup();
                    }
                }
            }

            // 3. Connect to WebSocket
            var wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            var ws = new WebSocket(wsProtocol + "//" + window.location.host + "/ws");

            ws.onopen = function() {
                var el = document.getElementById('connection-status');
                el.innerHTML = "🟢 Live Link Active";
            };

            ws.onmessage = function(event) {
                var alert = JSON.parse(event.data);
                handleNewAlert(alert, true);
            };

            ws.onclose = function() {
                var el = document.getElementById('connection-status');
                el.innerHTML = "🔴 Feed Disconnected";
                el.style.color = "var(--accent-red)";
            };
        </script>
    </body>
    </html>
    """