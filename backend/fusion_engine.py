import time
import math
from typing import Dict, List, Optional, Tuple
from collections import deque

class MultimodalFusionEngine:
    def __init__(self, window_seconds: float = 3.5):
        self.window_seconds = window_seconds
        
        # Sliding event buffers (timestamp, data)
        self.vision_buffer: deque = deque()
        self.audio_buffer: deque = deque()
        self.kinematic_buffer: deque = deque()

        # Configurable weights for late fusion
        self.w_vision = 0.45
        self.w_audio = 0.40
        self.w_kinematic = 0.15

        # Planned Safe Route Corridor (Amman Business Park -> Mecca St -> 7th Circle -> Abdoun)
        self.route_corridor: List[Tuple[float, float]] = [
            (31.9715, 35.8354),  # King Hussein Business Park
            (31.9680, 35.8450),  # Mecca Street Corridor
            (31.9610, 35.8560),  # Mecca St Intersection
            (31.9539, 35.8650),  # 7th Circle
            (31.9480, 35.8820),  # Zahran St / 5th Circle
            (31.9420, 35.8950),  # Abdoun North
            (31.9380, 35.9010),  # Abdoun Circle Destination
        ]
        self.max_corridor_deviation_meters = 800.0  # Alert if >800m off route while in motion
        self.stationary_alert_threshold_sec = 180.0  # Alert if stationary > 3 mins while trip is active

        # Anomaly tracking state
        self.stationary_start_time: Optional[float] = None
        self.last_known_location: Optional[Tuple[float, float]] = None
        self.last_corridor_distance_m: float = 0.0
        self.trip_origin: Optional[Tuple[float, float]] = None
        self.last_corridor_alert_time: float = 0.0
        self.last_stationary_alert_time: float = 0.0

    def set_trip_origin(self, lat: float, lon: float):
        """Sets the trip origin dynamically to the actual passenger pickup location."""
        self.trip_origin = (lat, lon)
        # Prepend actual pickup to corridor if not already close
        if self.route_corridor:
            first_wp = self.route_corridor[0]
            if self._haversine_distance_m(lat, lon, first_wp[0], first_wp[1]) > 500:
                self.route_corridor.insert(0, (lat, lon))

    def _prune(self, now: float):
        """Remove observations older than the sliding window threshold."""
        while self.vision_buffer and (now - self.vision_buffer[0]["time"]) > self.window_seconds:
            self.vision_buffer.popleft()
        while self.audio_buffer and (now - self.audio_buffer[0]["time"]) > self.window_seconds:
            self.audio_buffer.popleft()
        while self.kinematic_buffer and (now - self.kinematic_buffer[0]["time"]) > self.window_seconds:
            self.kinematic_buffer.popleft()

    @staticmethod
    def _haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Computes great-circle distance between two GPS coordinates in meters."""
        r = 6371000.0  # Earth radius in meters
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        delta_phi = math.radians(lat2 - lat1)
        delta_lambda = math.radians(lon2 - lon1)

        a = (math.sin(delta_phi / 2.0) ** 2 +
             math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2))
        c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
        return r * c

    def _min_distance_to_corridor(self, lat: float, lon: float) -> float:
        """Finds minimum perpendicular/waypoint distance to the expected route corridor."""
        min_dist = float("inf")
        for w_lat, w_lon in self.route_corridor:
            d = self._haversine_distance_m(lat, lon, w_lat, w_lon)
            if d < min_dist:
                min_dist = d
        return min_dist

    def record_location_telemetry(self, lat: float, lon: float, speed_kmh: float, g_force_delta: float = 0.0) -> Dict:
        """Processes live location, route compliance, and stationary anomaly tracking."""
        now = time.time()
        if self.trip_origin is None:
            self.set_trip_origin(lat, lon)

        self.last_known_location = (lat, lon)
        self.record_kinematics(speed_kmh=speed_kmh, g_force_delta=g_force_delta)

        # 1. Route corridor compliance
        dist_m = self._min_distance_to_corridor(lat, lon)
        self.last_corridor_distance_m = round(dist_m, 1)

        # Only flag deviation if vehicle is in ACTIVE motion (speed > 8 km/h)
        # Prevents false alarms when user is standing still or waiting at starting location
        is_in_transit = speed_kmh > 8.0
        should_alert_deviation = False

        if is_in_transit and dist_m > self.max_corridor_deviation_meters:
            if (now - self.last_corridor_alert_time) > 180.0:  # 3 min cooldown
                self.last_corridor_alert_time = now
                should_alert_deviation = True

        # 2. Prolonged stationary tracking (only if car was previously moving in trip)
        stationary_duration = 0.0
        should_alert_stop = False
        if speed_kmh < 1.5:
            if self.stationary_start_time is None:
                self.stationary_start_time = now
            stationary_duration = now - self.stationary_start_time
            if stationary_duration >= self.stationary_alert_threshold_sec:
                if (now - self.last_stationary_alert_time) > 180.0:
                    self.last_stationary_alert_time = now
                    should_alert_stop = True
        else:
            self.stationary_start_time = None

        route_status = "CORRIDOR_BREACH" if (is_in_transit and dist_m > self.max_corridor_deviation_meters) else ("UNEXPECTED_STOP" if stationary_duration >= self.stationary_alert_threshold_sec else "ON_ROUTE")

        return {
            "corridor_distance_meters": self.last_corridor_distance_m,
            "is_corridor_deviated": should_alert_deviation,
            "stationary_duration_sec": round(stationary_duration, 1),
            "is_unexpected_stop": should_alert_stop,
            "route_status": route_status
        }

    def record_vision_breach(self, zone: str, limb: str) -> Dict:
        now = time.time()
        self._prune(now)
        
        event = {
            "time": now,
            "zone": zone,
            "limb": limb,
            "score": 0.85
        }
        self.vision_buffer.append(event)
        return self._evaluate_fusion(now, trigger_source="VISION")

    def record_audio_event(self, sound_type: str, confidence: float) -> Dict:
        now = time.time()
        self._prune(now)

        event = {
            "time": now,
            "sound_type": sound_type,
            "score": min(confidence, 1.0)
        }
        self.audio_buffer.append(event)
        return self._evaluate_fusion(now, trigger_source="AUDIO")

    def record_kinematics(self, speed_kmh: float, g_force_delta: float = 0.0) -> None:
        now = time.time()
        self._prune(now)
        
        # g_force_delta > 0.4G indicates sharp swerve or hard braking; > 0.9G indicates collision
        if g_force_delta > 0.9:
            kinematic_score = 1.0
        elif g_force_delta > 0.4:
            kinematic_score = 0.8
        else:
            kinematic_score = 0.0

        self.kinematic_buffer.append({
            "time": now,
            "speed": speed_kmh,
            "g_force_delta": g_force_delta,
            "score": kinematic_score
        })

    def _evaluate_fusion(self, now: float, trigger_source: str) -> Dict:
        # Determine highest active scores inside the sliding window
        v_score = max([e["score"] for e in self.vision_buffer], default=0.0)
        a_score = max([e["score"] for e in self.audio_buffer], default=0.0)
        k_score = max([e["score"] for e in self.kinematic_buffer], default=0.0)

        # Compute fused score
        fused_score = (self.w_vision * v_score) + (self.w_audio * a_score) + (self.w_kinematic * k_score)

        # Multi-modal correlation decisions
        has_vision = v_score > 0.0
        has_audio = a_score >= 0.20
        has_impact_kinematics = k_score >= 0.4

        last_sound = self.audio_buffer[-1].get("sound_type", "") if self.audio_buffer else ""
        is_critical_sound = any(k in last_sound.lower() for k in ["scream", "glass", "shatter", "sos", "distress", "impostor", "crash", "smash", "gunshot", "explosion", "unauthorized"])

        if has_vision and has_audio:
            classification = "TIER_1_CRITICAL_DISTRESS"
            action = "DISPATCH_EMERGENCY_COOLDOWN"
            summary = f"Simultaneous spatial intrusion and acoustic alert ({last_sound}) detected."
            status = "CRITICAL_ESCALATION"
        elif has_audio and has_impact_kinematics:
            classification = "KINEMATIC_COLLISION_DISTRESS"
            action = "DISPATCH_ACCIDENT_RESPONSE"
            summary = f"Kinematic delta correlated with acoustic signature: {last_sound}."
            status = "CRITICAL_ESCALATION"
        elif is_critical_sound or (has_audio and a_score >= 0.35):
            classification = "CABIN_ACOUSTIC_DISTRESS"
            action = "ALERT_OPERATIONS"
            summary = f"Verified acoustic incident in cabin: {last_sound} ({round(a_score*100)}% confidence)."
            status = "INCIDENT_ALERT"
        elif has_vision:
            classification = "SPATIAL_ANOMALY"
            action = "WARN_CABIN_PARTITION"
            summary = "Physical boundary breach detected in cabin."
            status = "INCIDENT_FLAGGED"
        elif has_audio:
            classification = "UNVERIFIED_ACOUSTIC_EVENT"
            action = "REQUEST_CHECKIN"
            summary = f"Acoustic event detected: {last_sound}."
            status = "INVESTIGATING_AUDIO"
        else:
            classification = "NOMINAL"
            action = "NONE"
            summary = "Cabin parameters normal."
            status = "SAFE"

        return {
            "fused_score": round(fused_score, 2),
            "classification": classification,
            "status": status,
            "action": action,
            "summary": summary,
            "trigger": trigger_source,
            "corridor_distance_m": self.last_corridor_distance_m,
            "telemetry_breakdown": {
                "vision_component": v_score,
                "audio_component": a_score,
                "kinematic_component": k_score
            }
        }

# Global singleton instance for the backend
fusion_engine = MultimodalFusionEngine(window_seconds=3.5)