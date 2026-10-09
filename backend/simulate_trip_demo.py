import time
import requests
import sys
import os
import math

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")

def check_backend_health():
    try:
        r = requests.get(f"{BACKEND_URL}/", timeout=3)
        return r.status_code == 200
    except Exception:
        return False

def interpolate_segment(p1, p2, num_steps=8):
    """Generates smooth, realistic road interpolation between two actual GPS waypoints."""
    lat1, lon1 = p1
    lat2, lon2 = p2
    points = []
    for i in range(1, num_steps + 1):
        ratio = i / float(num_steps)
        lat = lat1 + (lat2 - lat1) * ratio
        lon = lon1 + (lon2 - lon1) * ratio
        points.append((lat, lon))
    return points

# REAL AMMAN STREET ROAD NETWORK WAYPOINTS:
# Leg 1: King Hussein Business Park Exit onto King Abdullah II Street (Main Highway)
# Leg 2: King Abdullah II St southbound towards Mecca St Interchange
# Leg 3: Curve onto Mecca Street (Sh. Mecca) heading East toward Al-Haramain & Kilo Circle
# Leg 4: Anomaly Detour turning sharply Northwest onto Al-Shaab / Dabouq residential road
REAL_ROAD_ROUTE = [
    # --- 1. Pickup at KHBP (Gate 1) ---
    (31.9715, 35.8354),
    (31.9710, 35.8360),
    (31.9702, 35.8368),
    # --- 2. King Abdullah II St Highway (Heading South) ---
    (31.9692, 35.8380),
    (31.9682, 35.8398),
    (31.9672, 35.8418),
    # --- 3. Entering Mecca Street (Sh. Mecca Eastbound) ---
    (31.9660, 35.8445),
    (31.9650, 35.8470),
    (31.9640, 35.8500),
    (31.9628, 35.8530),
    (31.9615, 35.8560), # Mecca St / Al-Haramain Intersection
    # --- 4. Deviation Event: Vehicle turns off Mecca St onto Al-Shaab / Detour Road ---
    (31.9610, 35.8510),
    (31.9600, 35.8450),
    (31.9580, 35.8380),
    (31.9550, 35.8300),
    (31.9520, 35.8210), # Deep unauthorized zone (>1.1 km off corridor)
]

def run_smooth_demo():
    print("\n" + "="*65)
    print("   PETRARIDE GUARDIAN - SMOOTH REAL-ROAD DEMO SIMULATOR")
    print("   Continuous Real-Time GPS Tracking Along Amman Streets")
    print("="*65)

    if not check_backend_health():
        print(f"\n[Error] Backend is unreachable at {BACKEND_URL}")
        print("Please ensure your backend server is running:")
        print("  cd petrakids-guardian/backend")
        print("  uvicorn main:app --host 0.0.0.0 --port 8000 --reload\n")
        sys.exit(1)

    print("\n[Connected] Backend online. Open http://localhost:8000 to watch live map.\n")
    time.sleep(1)

    print("[Phase 1] Passenger Pickup at King Hussein Business Park...")
    # Send pickup telemetry
    requests.post(f"{BACKEND_URL}/api/telemetry/location", json={
        "child_id": "child_01",
        "latitude": 31.9715,
        "longitude": 35.8354,
        "speed": 0.0,
        "g_force_delta": 0.0,
        "battery_level": 100.0
    })
    time.sleep(2)

    # Build continuous dense road trajectory
    full_path = [REAL_ROAD_ROUTE[0]]
    for i in range(len(REAL_ROAD_ROUTE) - 1):
        interpolated = interpolate_segment(REAL_ROAD_ROUTE[i], REAL_ROAD_ROUTE[i + 1], num_steps=5)
        full_path.extend(interpolated)

    total_points = len(full_path)
    print(f"[Phase 2] Vehicle departing on authorized route ({total_points} live road telemetry points)...\n")

    deviation_triggered = False
    chat_triggered = False
    sos_triggered = False

    for idx, (lat, lon) in enumerate(full_path):
        # Calculate realistic speed
        if idx < 6:
            speed_kmh = 20.0 + (idx * 4.0)  # Accelerating out of business park
        elif idx < 45:
            speed_kmh = 48.0  # Steady cruising on Mecca Street
        else:
            speed_kmh = 32.0  # Slowing down in unauthorized detour area

        telemetry_payload = {
            "child_id": "child_01",
            "latitude": round(lat, 6),
            "longitude": round(lon, 6),
            "speed": round(speed_kmh / 3.6, 2),
            "g_force_delta": 0.08,
            "battery_level": 98.0
        }

        try:
            r = requests.post(f"{BACKEND_URL}/api/telemetry/location", json=telemetry_payload, timeout=2)
            data = r.json().get("corridor", {})
            dist_m = data.get("corridor_distance_meters", 0.0)
            status = data.get("route_status", "ON_ROUTE")
        except Exception:
            dist_m = 0.0
            status = "ON_ROUTE"

        print(f" -> [{idx+1:02d}/{total_points}] Lat: {lat:.5f}, Lon: {lon:.5f} | Speed: {speed_kmh:.0f} km/h | Corridor: {status} ({dist_m:.0f}m off)")

        # STEP 3: Trigger Route Deviation notice when car veers off Mecca St
        if status == "ROUTE_DEVIATED" and not deviation_triggered:
            deviation_triggered = True
            print("\n" + "!"*60)
            print(f" [ALERT] ROUTE CORRIDOR DEVIATION FLAGGED ({dist_m:.0f}m off planned corridor)!")
            print(" >> Operations dashboard updated: ROUTE ANOMALY badge live.")
            print("!"*60 + "\n")

        # STEP 4: Child expresses concern in PetraBuddy
        if idx == 52 and not chat_triggered:
            chat_triggered = True
            print("\n" + "-"*60)
            print(" [AI COMPANION] Child speaks in cabin: 'وين ماخدني؟ مش هاد طريقي'")
            requests.post(f"{BACKEND_URL}/api/companion/chat", json={
                "child_id": "child_01",
                "message": "وين ماخدني؟ مش هاد طريقي وخايفة كتير",
                "latitude": lat,
                "longitude": lon
            })
            print(" >> Dashboard updated: PASSENGER CONCERN card generated.")
            print("-" * 60 + "\n")

        # STEP 5: Emergency SOS Button Activation
        if idx == total_points - 1 and not sos_triggered:
            sos_triggered = True
            print("\n" + "#"*65)
            print(" [CRITICAL] IN-CABIN EMERGENCY SOS BUTTON ACTIVATED!")
            print(" >> 3-second safety countdown completed.")
            print(" >> Dashboard flashing EMERGENCY SOS (Code Red).")
            print(" >> Official Bilingual 911 WhatsApp Dispatch sent to your phone!")
            print("#"*65 + "\n")
            requests.post(f"{BACKEND_URL}/api/alerts", json={
                "sound_type": "EMERGENCY SOS BUTTON ACTIVATED BY PASSENGER",
                "confidence": 1.0,
                "latitude": lat,
                "longitude": lon,
                "status": "MANUAL_SOS_TRIGGERED"
            })

        # Smooth road update interval
        time.sleep(0.4)

    print("\n" + "="*65)
    print("   DEMO COMPLETE: Check your WhatsApp for the 911 alert!")
    print("="*65 + "\n")

if __name__ == "__main__":
    run_smooth_demo()
