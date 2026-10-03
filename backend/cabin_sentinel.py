import cv2
import mediapipe as mp
import numpy as np
import time
import requests
import threading

# --- CONFIGURATION ---
VIRTUAL_BOUNDARY_X = 0.50  # Split cabin: Left = Captain, Right = Child
BACKEND_ALERT_URL = "http://127.0.0.1:8000/api/incident/boundary-breach"
ALERT_COOLDOWN_SEC = 3.0   # Prevent flooding the backend

mp_drawing = mp.solutions.drawing_utils
mp_pose = mp.solutions.pose

last_alert_time = 0

def notify_backend_async(payload):
    """Fire and forget alert in background thread so video never stutters."""
    def send():
        try:
            requests.post(BACKEND_ALERT_URL, json=payload, timeout=1.0)
        except Exception:
            pass  # Backend not running or unreachable during test
    threading.Thread(target=send, daemon=True).start()

def run_cabin_sentinel(camera_index=0):
    global last_alert_time
    cap = cv2.VideoCapture(camera_index)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    if not cap.isOpened():
        print(f"Error: Unable to access camera device index {camera_index}")
        return

    print("==================================================")
    print("PetraKids Zero-Knowledge Spatial Sentinel Active")
    print("• Tracking: MediaPipe 33-point Vector Topology")
    print("• Privacy Mode: Raw pixels discarded immediately")
    print("• Press 'q' to quit")
    print("==================================================")

    prev_frame_time = time.time()

    with mp_pose.Pose(
        min_detection_confidence=0.6,
        min_tracking_confidence=0.6,
        model_complexity=1
    ) as pose:

        while cap.isOpened():
            success, raw_frame = cap.read()
            if not success:
                continue

            # Calculate FPS
            now = time.time()
            fps = 1.0 / (now - prev_frame_time) if (now - prev_frame_time) > 0 else 30.0
            prev_frame_time = now

            raw_frame = cv2.flip(raw_frame, 1)
            h, w, _ = raw_frame.shape

            rgb_frame = cv2.cvtColor(raw_frame, cv2.COLOR_BGR2RGB)
            results = pose.process(rgb_frame)

            # Synthesize blank canvas (Zero-Knowledge Privacy Vault)
            synthetic_canvas = np.zeros((h, w, 3), dtype=np.uint8)
            boundary_px = int(VIRTUAL_BOUNDARY_X * w)

            # Zone overlays
            cv2.line(synthetic_canvas, (boundary_px, 0), (boundary_px, h), (80, 80, 80), 2)
            cv2.putText(synthetic_canvas, "FRONT CABIN (CAPTAIN)", (20, 30), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (148, 163, 184), 1)
            cv2.putText(synthetic_canvas, "REAR CABIN (CHILD SAFE ZONE)", (boundary_px + 20, 30), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (14, 165, 233), 1)

            # Telemetry banner
            cv2.putText(synthetic_canvas, f"EDGE FPS: {fps:.1f} | SENSORS: ACTIVE", (w - 230, 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (100, 116, 139), 1)

            boundary_breach = False
            breach_wrist = None

            if results.pose_landmarks:
                landmarks = results.pose_landmarks.landmark

                keypoints_to_check = {
                    "LEFT_WRIST": landmarks[mp_pose.PoseLandmark.LEFT_WRIST],
                    "RIGHT_WRIST": landmarks[mp_pose.PoseLandmark.RIGHT_WRIST]
                }

                for name, pt in keypoints_to_check.items():
                    if pt.visibility > 0.5 and pt.x > VIRTUAL_BOUNDARY_X:
                        boundary_breach = True
                        breach_wrist = name
                        pt_x_px = int(pt.x * w)
                        pt_y_px = int(pt.y * h)
                        # Red targeting ring
                        cv2.circle(synthetic_canvas, (pt_x_px, pt_y_px), 12, (0, 0, 255), 2)
                        cv2.circle(synthetic_canvas, (pt_x_px, pt_y_px), 5, (0, 0, 255), -1)

                # Draw skeleton
                mp_drawing.draw_landmarks(
                    synthetic_canvas,
                    results.pose_landmarks,
                    mp_pose.POSE_CONNECTIONS,
                    mp_drawing.DrawingSpec(color=(16, 185, 129), thickness=2, circle_radius=3),
                    mp_drawing.DrawingSpec(color=(14, 165, 233), thickness=2, circle_radius=2)
                )

            # Visual alert banner & dispatch
            if boundary_breach:
                cv2.rectangle(synthetic_canvas, (0, h - 50), (w, h), (0, 0, 220), -1)
                cv2.putText(synthetic_canvas, f"[ALERT] SPATIAL INTRUSION DETECTED ({breach_wrist})", 
                            (20, h - 18), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

                # Dispatch alert with cooldown
                if (now - last_alert_time) > ALERT_COOLDOWN_SEC:
                    last_alert_time = now
                    notify_backend_async({
                        "event_type": "CABIN_SPATIAL_BREACH",
                        "target_limb": breach_wrist,
                        "timestamp": now,
                        "zone": "REAR_CABIN"
                    })
            else:
                cv2.rectangle(synthetic_canvas, (0, h - 35), (w, h), (20, 20, 20), -1)
                cv2.putText(synthetic_canvas, "SPATIAL BOUNDARY ENFORCED - NO INTRUSION", 
                            (20, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (16, 185, 129), 1)

            cv2.imshow("PetraKids - Zero-Knowledge Spatial Sentinel", synthetic_canvas)

            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    run_cabin_sentinel(0)