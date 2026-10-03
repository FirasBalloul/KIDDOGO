import time
from typing import Dict, List, Optional
from collections import deque

class MultimodalFusionEngine:
    def __init__(self, window_seconds: float = 3.0):
        self.window_seconds = window_seconds
        
        # Sliding event buffers (timestamp, data)
        self.vision_buffer: deque = deque()
        self.audio_buffer: deque = deque()
        self.kinematic_buffer: deque = deque()

        # Configurable weights for late fusion
        self.w_vision = 0.45
        self.w_audio = 0.40
        self.w_kinematic = 0.15

    def _prune(self, now: float):
        """Remove observations older than the sliding window threshold."""
        while self.vision_buffer and (now - self.vision_buffer[0]["time"]) > self.window_seconds:
            self.vision_buffer.popleft()
        while self.audio_buffer and (now - self.audio_buffer[0]["time"]) > self.window_seconds:
            self.audio_buffer.popleft()
        while self.kinematic_buffer and (now - self.kinematic_buffer[0]["time"]) > self.window_seconds:
            self.kinematic_buffer.popleft()

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
        
        # g_force_delta > 0.4G indicates sharp swerve or hard braking
        kinematic_score = 0.8 if g_force_delta > 0.4 else 0.0
        self.kinematic_buffer.append({
            "time": now,
            "speed": speed_kmh,
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
        has_audio = a_score > 0.5

        if has_vision and has_audio:
            classification = "TIER_1_CRITICAL_DISTRESS"
            action = "DISPATCH_EMERGENCY_COOLDOWN"
            summary = "Simultaneous spatial cabin intrusion and acoustic distress detected."
            status = "CRITICAL_ESCALATION"
        elif has_vision:
            classification = "SPATIAL_ANOMALY"
            action = "WARN_CABIN_PARTITION"
            summary = "Physical boundary breach detected with normal cabin acoustics."
            status = "INCIDENT_FLAGGED"
        elif has_audio:
            # Acoustic event occurred with zero spatial intrusion and smooth motion
            if k_score == 0.0:
                classification = "BENIGN_ACOUSTIC_ARTIFACT"
                action = "SUPPRESS_ALERT"
                summary = "Acoustic peak decoupled: No spatial intrusion or kinematic delta."
                status = "PASSENGER_SAFE"
            else:
                classification = "UNVERIFIED_ACOUSTIC_DISTRESS"
                action = "REQUEST_CHECKIN"
                summary = "Acoustic peak accompanied by vehicle motion changes."
                status = "DISTRESS_DETECTED"
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
            "telemetry_breakdown": {
                "vision_component": v_score,
                "audio_component": a_score,
                "kinematic_component": k_score
            }
        }

# Global singleton instance for the backend
fusion_engine = MultimodalFusionEngine(window_seconds=3.5)