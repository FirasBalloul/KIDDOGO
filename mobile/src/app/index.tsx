import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  PermissionsAndroid,
  Platform,
  Dimensions,
  Vibration,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { useAudioRecorder } from '@siteed/audio-studio';
import { Buffer } from 'buffer';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';

const { width } = Dimensions.get('window');

// Production sensitivity lock (35% confidence floor)
const DISTRESS_CONFIDENCE_THRESHOLD = 0.35;

// Updated YAMNet distress and anomaly indices
const DISTRESS_INDICES = [
  20, 21, 22, 23,          // Crying, Baby cry, Screaming, Shout
  280, 281, 282, 283,      // Siren, Civil defense siren, Police car / Ambulance
  322, 326,                // Door slam / Knock impact
  358, 359,                // Dishes/pots/pans (sharp glass clatter/breakage)
  410, 412, 413, 414,      // Slap, Breaking, Smash, Splinter
  420, 421, 422, 423,      // Explosion, Gunshot, Crash, Collision
  432, 433, 434, 435, 436, // Glass, Shatter, Breaking glass, Chink/Clink
  513, 514, 515, 516, 517, // Vocal distress / Screaming / Grunt / Groan
];

const SOUND_LABELS: Record<number, string> = {
  20: 'Crying',
  21: 'Baby Cry',
  22: 'Screaming',
  23: 'Shout / Distress',
  280: 'Emergency Siren',
  281: 'Civil Defense Siren',
  282: 'Ambulance / Police Siren',
  283: 'Fire Engine Siren',
  322: 'Door Slam / Impact',
  326: 'Door Knock / Thud',
  358: 'Glass / Ceramic Impact',
  359: 'Metal Clatter',
  410: 'Impact / Smack',
  412: 'Breaking / Smash',
  413: 'Splintering',
  420: 'Explosion',
  421: 'Gunshot / Bang',
  422: 'Vehicle Crash',
  423: 'Collision Anomaly',
  432: 'Glass Sound',
  433: 'Glass Shatter',
  434: 'Glass Breaking',
  435: 'Glass Clink / Shatter',
  436: 'Cracking Glass',
  514: 'Vocal Distress / Screaming',
};

interface AlertEntry {
  id: string;
  time: string;
  label: string;
  confidence: number;
  status: 'SUPPRESSED' | 'ESCALATED' | 'MANUAL_SOS';
}

export default function GuardianAITester() {
  const [status, setStatus] = useState('Initializing...');
  const [latestSound, setLatestSound] = useState('Standby');
  const [isDanger, setIsDanger] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [alertHistory, setAlertHistory] = useState<AlertEntry[]>([]);
  const [showLiveMap, setShowLiveMap] = useState(true);

  const [showVerificationModal, setShowVerificationModal] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const [pendingAlert, setPendingAlert] = useState<{ soundName: string; confidence: number; index: number } | null>(null);

  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webViewRef = useRef<WebView>(null);
  const isSpeakingRef = useRef(false);
  const showVerificationModalRef = useRef(false);

  // Dynamic location management
  const locationSubscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const coordsRef = useRef({
    latitude: 31.9539,
    longitude: 35.9106,
  });
  const [coords, setCoords] = useState(coordsRef.current);

  // 1. TFLite Model
  const plugin = useTensorflowModel(require('../../assets/yamnet.tflite'), []);
  const audioBufferRef = useRef<number[]>([]);
  const lastAlertTime = useRef<number>(0);

  // Keep modal state ref in sync to immediately halt audio stream processing
  useEffect(() => {
    showVerificationModalRef.current = showVerificationModal;
  }, [showVerificationModal]);

  // 2. Audio Recorder Hook
  const { startRecording, stopRecording } = useAudioRecorder();

  useEffect(() => {
    if (plugin.state === 'loaded') {
      setStatus('AI Engine Ready');
    } else if (plugin.state === 'error') {
      const modelError = (plugin as any).error ?? new Error('Failed to load model');
      setStatus(`Error: ${modelError.message || 'Failed to load model'}`);
      console.error('TFLite Load Error:', modelError);
    }
  }, [plugin.state]);

  const updateMapCoordinates = (lat: number, lon: number) => {
    if (webViewRef.current) {
      const jsCode = `
        if (window.updatePassengerLocation) {
          window.updatePassengerLocation(${lat}, ${lon});
        }
        true;
      `;
      webViewRef.current.injectJavaScript(jsCode);
    }
  };

  // Continuous High-Accuracy GPS Tracking
  useEffect(() => {
    let isMounted = true;

    const startLocationWatch = async () => {
      try {
        let { status: permStatus } = await Location.requestForegroundPermissionsAsync();
        if (permStatus !== 'granted') {
          console.warn('Foreground location permission denied.');
          return;
        }

        // Fast initial position acquisition
        const initialPos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        if (isMounted) {
          const initialCoords = {
            latitude: initialPos.coords.latitude,
            longitude: initialPos.coords.longitude,
          };
          coordsRef.current = initialCoords;
          setCoords(initialCoords);
          updateMapCoordinates(initialCoords.latitude, initialCoords.longitude);
        }

        // Real-time continuous location watcher (updates on 5m displacement or every 3 seconds)
        locationSubscriptionRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 3000,
            distanceInterval: 5,
          },
          (location) => {
            if (!isMounted) return;
            const updatedCoords = {
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
            };
            coordsRef.current = updatedCoords;
            setCoords(updatedCoords);
            updateMapCoordinates(updatedCoords.latitude, updatedCoords.longitude);
          }
        );
      } catch (err) {
        console.error('Failed to initialize live GPS stream:', err);
      }
    };

    startLocationWatch();

    return () => {
      isMounted = false;
      if (locationSubscriptionRef.current) {
        locationSubscriptionRef.current.remove();
        locationSubscriptionRef.current = null;
      }
    };
  }, []);

  const requestMicrophonePermission = async () => {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Microphone Access',
          message: 'Guardian needs microphone access to detect distress sounds on-device.',
          buttonPositive: 'Authorize',
        }
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true;
  };

  const speakCompanionPrompt = () => {
    Vibration.vibrate([0, 300, 200, 300]);
    isSpeakingRef.current = true;

    Speech.speak('Are you okay?', {
      language: 'en-US',
      pitch: 1.0,
      rate: 1.0,
      onDone: () => {
        isSpeakingRef.current = false;
      },
      onError: () => {
        isSpeakingRef.current = false;
      },
    });
  };

  const escalateAlertToBrain = async (soundName: string, confidence: number, manual: boolean = false) => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setShowVerificationModal(false);
    showVerificationModalRef.current = false;
    setIsDanger(true);
    setLatestSound('Alert Dispatched');
    audioBufferRef.current = [];

    const escalationType = manual ? 'MANUAL_SOS' : 'ESCALATED';

    const entry: AlertEntry = {
      id: Math.random().toString(36).substring(7),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      label: manual ? `${soundName} (Manual SOS)` : soundName,
      confidence: Math.round(confidence * 100),
      status: escalationType,
    };
    setAlertHistory((prev) => [entry, ...prev.slice(0, 4)]);

    // Instantly use freshest cached coordinates from continuous watcher
    const currentLat = coordsRef.current.latitude;
    const currentLon = coordsRef.current.longitude;

    try {
      const BACKEND_URL = 'http://192.168.1.29:8000/api/alerts';
      await fetch(BACKEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sound_type: soundName,
          confidence: parseFloat(confidence.toFixed(2)),
          latitude: currentLat,
          longitude: currentLon,
          status: manual ? 'MANUAL_SOS_TRIGGERED' : 'ESCALATED_TIMEOUT_DISTRESS',
        }),
      });
      console.log('🚨 Emergency Alert Dispatched to Operations & Parents with Live GPS!');
    } catch (err) {
      console.error('Backend Dispatch Failed:', err);
    }
  };

  const confirmChildSafe = () => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setShowVerificationModal(false);
    showVerificationModalRef.current = false;
    setIsDanger(false);
    setLatestSound('Standby');
    audioBufferRef.current = [];

    isSpeakingRef.current = true;
    Speech.speak('Glad you are safe.', {
      language: 'en-US',
      onDone: () => {
        isSpeakingRef.current = false;
      },
      onError: () => {
        isSpeakingRef.current = false;
      },
    });

    if (pendingAlert) {
      const entry: AlertEntry = {
        id: Math.random().toString(36).substring(7),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        label: pendingAlert.soundName,
        confidence: Math.round(pendingAlert.confidence * 100),
        status: 'SUPPRESSED',
      };
      setAlertHistory((prev) => [entry, ...prev.slice(0, 4)]);
    }
    setPendingAlert(null);
  };

  const initiateCompanionCheckIn = (topIndex: number, confidence: number) => {
    const now = Date.now();
    if (now - lastAlertTime.current < 6000) return;
    lastAlertTime.current = now;

    // Flush buffer immediately to avoid stale audio processing
    audioBufferRef.current = [];

    const soundName = SOUND_LABELS[topIndex] || `Distress Index ${topIndex}`;

    setPendingAlert({ soundName, confidence, index: topIndex });
    setShowVerificationModal(true);
    showVerificationModalRef.current = true;
    setCountdown(5);

    speakCompanionPrompt();

    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
          escalateAlertToBrain(soundName, confidence, false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const startListening = async () => {
    if (plugin.state !== 'loaded' || !plugin.model) {
      alert('Wait for the AI model to finish loading!');
      return;
    }

    const hasPermission = await requestMicrophonePermission();
    if (!hasPermission) {
      alert('Microphone permission denied.');
      return;
    }

    setIsListening(true);
    setStatus('Edge Inference Active');

    try {
      await startRecording({
        sampleRate: 16000,
        channels: 1,
        encoding: 'pcm_16bit',
        interval: 200,
        onAudioStream: async (event: any) => {
          // Break acoustic feedback loops: ignore incoming mic chunks while TTS is speaking or modal is open
          if (isSpeakingRef.current || showVerificationModalRef.current) {
            audioBufferRef.current = [];
            return;
          }

          const chunkBuffer = Buffer.from(event.data, 'base64');
          const int16View = new Int16Array(chunkBuffer.buffer, chunkBuffer.byteOffset, chunkBuffer.length / 2);

          for (let i = 0; i < int16View.length; i++) {
            audioBufferRef.current.push(int16View[i] / 32768.0);
          }

          if (audioBufferRef.current.length >= 15600) {
            const inputFloat32 = new Float32Array(audioBufferRef.current.slice(0, 15600));
            audioBufferRef.current = audioBufferRef.current.slice(15600);

            try {
              const outputs = await plugin.model.run([inputFloat32.buffer]);
              const scores = new Float32Array(outputs[0]);

              let maxScore = 0;
              let topIndex = -1;
              for (let i = 0; i < scores.length; i++) {
                if (scores[i] > maxScore) {
                  maxScore = scores[i];
                  topIndex = i;
                }
              }

              if (maxScore > DISTRESS_CONFIDENCE_THRESHOLD) {
                console.log(`Detected Index: ${topIndex} with confidence: ${(maxScore * 100).toFixed(1)}%`);

                const isDistress = DISTRESS_INDICES.includes(topIndex);
                const detectedName = SOUND_LABELS[topIndex] || `Class ${topIndex}`;
                setLatestSound(`${detectedName} (${Math.round(maxScore * 100)}%)`);

                if (isDistress && !showVerificationModalRef.current) {
                  initiateCompanionCheckIn(topIndex, maxScore);
                }
              }
            } catch (err) {
              console.error('Inference Error:', err);
            }
          }
        },
      });
    } catch (error) {
      console.error('Audio recording startup failure:', error);
      setIsListening(false);
      setStatus('Microphone Error');
    }
  };

  const stopAudioListening = async () => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    await stopRecording();
    setIsListening(false);
    setStatus('Standby');
    setLatestSound('Listening halted');
    setIsDanger(false);
    setShowVerificationModal(false);
    showVerificationModalRef.current = false;
    audioBufferRef.current = [];
  };

  const leafletMapHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <style>
          body, html, #map { margin: 0; padding: 0; width: 100%; height: 100%; background: #0B0F17; }
          .leaflet-control-attribution { display: none !important; }
        </style>
      </head>
      <body>
        <div id="map"></div>
        <script>
          const map = L.map('map', { zoomControl: false }).setView([${coords.latitude}, ${coords.longitude}], 15);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

          let marker = L.circleMarker([${coords.latitude}, ${coords.longitude}], {
            radius: 9,
            fillColor: "${isDanger ? '#EF4444' : '#3B82F6'}",
            color: "#FFFFFF",
            weight: 2,
            opacity: 1,
            fillOpacity: 0.9
          }).addTo(map);

          let rangeCircle = L.circle([${coords.latitude}, ${coords.longitude}], {
            radius: 120,
            fillColor: "${isDanger ? '#EF4444' : '#3B82F6'}",
            fillOpacity: 0.2,
            stroke: false
          }).addTo(map);

          window.updatePassengerLocation = function(lat, lon) {
            marker.setLatLng([lat, lon]);
            rangeCircle.setLatLng([lat, lon]);
            map.panTo([lat, lon]);
          };
        </script>
      </body>
    </html>
  `;

  return (
    <View style={styles.container}>
      {/* 1. Tactical Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.brandTitle}>
            KIDDOGO<Text style={styles.brandAccent}>.AI</Text>
          </Text>
          <Text style={styles.brandSubtitle}>MULTI-MODAL GUARDIAN ARCHITECTURE</Text>
        </View>
        <View
          style={[
            styles.badge,
            isListening ? (isDanger ? styles.badgeDanger : styles.badgeActive) : styles.badgeStandby,
          ]}
        >
          <View
            style={[
              styles.dot,
              isListening ? (isDanger ? styles.dotDanger : styles.dotActive) : styles.dotStandby,
            ]}
          />
          <Text style={styles.badgeText}>
            {isDanger ? 'ESCALATED' : isListening ? 'GUARDING' : 'IDLE'}
          </Text>
        </View>
      </View>

      {/* 2. Embedded Real-Time Map (Fabric Safe via WebView) */}
      <View style={styles.mapContainer}>
        {showLiveMap ? (
          <WebView
            ref={webViewRef}
            originWhitelist={['*']}
            source={{ html: leafletMapHtml }}
            style={styles.webView}
            scrollEnabled={false}
          />
        ) : (
          <View style={styles.telemetryCard}>
            <View style={styles.telemetryRow}>
              <Text style={styles.telemetryLabel}>GPS SATELLITE LOCK</Text>
              <Text style={styles.telemetryValue}>ACTIVE</Text>
            </View>
            <Text style={styles.coordsDisplay}>
              {coords.latitude.toFixed(6)}° N, {coords.longitude.toFixed(6)}° E
            </Text>
          </View>
        )}

        <View style={styles.coordsOverlay}>
          <TouchableOpacity onPress={() => setShowLiveMap((prev) => !prev)}>
            <Text style={styles.coordsText}>
              {coords.latitude.toFixed(4)}, {coords.longitude.toFixed(4)} • {showLiveMap ? 'MAP ON' : 'MAP OFF'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* 3. Companion Voice Triage Card */}
        <View>
          {showVerificationModal && (
            <View style={styles.triageCard}>
              <View style={styles.triageTopRow}>
                <View style={styles.companionPulse} />
                <Text style={styles.triageTitle}>AI COMPANION CHECK-IN</Text>
              </View>

              <Text style={styles.triageEnglishText}>"Are you okay?"</Text>
              <Text style={styles.triageArabicText}>"طمني عليك، كل اشي تمام؟"</Text>

              <Text style={styles.triageSubtitle}>
                Detected anomaly: {pendingAlert?.soundName} • Auto-alerting parents in:
              </Text>
              <Text style={styles.countdownNumber}>{countdown}s</Text>

              <View style={styles.triageActionRow}>
                <TouchableOpacity style={styles.safeConfirmBtn} onPress={confirmChildSafe}>
                  <Text style={styles.safeConfirmBtnText}>I'M SAFE • أنا بخير</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.sosInstantBtn}
                  onPress={() => {
                    if (pendingAlert) {
                      escalateAlertToBrain(pendingAlert.soundName, pendingAlert.confidence, true);
                    }
                  }}
                >
                  <Text style={styles.sosInstantBtnText}>🚨 SOS NOW • استغاثة</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* 4. Real-Time Classifier Feedback */}
        <View style={[styles.card, isDanger && styles.cardDanger]}>
          <Text style={styles.cardHeader}>EDGE ACOUSTIC TELEMETRY</Text>
          <Text style={styles.detectedSound}>{latestSound}</Text>
          <Text style={styles.engineStatus}>CORE ENGINE: {status.toUpperCase()}</Text>
        </View>

        {/* 5. Multi-Signal Verification Log */}
        <View style={styles.card}>
          <Text style={styles.cardHeader}>TRIAGE & INCIDENT AUDIT</Text>
          <View>
            {alertHistory.length === 0 ? (
              <Text style={styles.emptyAlerts}>No incidents detected.</Text>
            ) : (
              alertHistory.map((item) => (
                <View key={item.id} style={styles.alertRow}>
                  <View>
                    <Text style={styles.alertLabel}>{item.label}</Text>
                    <Text style={styles.alertTime}>{item.time}</Text>
                  </View>
                  <View
                    style={[
                      styles.statusBadge,
                      item.status === 'SUPPRESSED'
                        ? styles.badgeSuppressed
                        : styles.badgeEscalated,
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusBadgeText,
                        item.status === 'SUPPRESSED'
                          ? styles.textSuppressed
                          : styles.textEscalated,
                      ]}
                    >
                      {item.status} ({item.confidence}%)
                    </Text>
                  </View>
                </View>
              ))
            )}
          </View>
        </View>
      </ScrollView>

      {/* 6. Action Footer */}
      <View style={styles.actionFooter}>
        {!isListening ? (
          <TouchableOpacity style={styles.startBtn} onPress={startListening}>
            <Text style={styles.btnText}>ARM GUARDIAN SURVEILLANCE</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.stopBtn} onPress={stopAudioListening}>
            <Text style={styles.btnText}>DISARM SYSTEM</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0F17' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 50,
    paddingBottom: 16,
    backgroundColor: '#111827',
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  brandTitle: { fontSize: 20, fontWeight: '900', color: '#F9FAFB', letterSpacing: 1.5 },
  brandAccent: { color: '#3B82F6' },
  brandSubtitle: { fontSize: 9, color: '#9CA3AF', fontWeight: '700', letterSpacing: 0.8 },
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  badgeStandby: { backgroundColor: '#1F2937' },
  badgeActive: { backgroundColor: 'rgba(16, 185, 129, 0.2)', borderWidth: 1, borderColor: '#10B981' },
  badgeDanger: { backgroundColor: 'rgba(239, 68, 68, 0.25)', borderWidth: 1, borderColor: '#EF4444' },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  dotStandby: { backgroundColor: '#6B7280' },
  dotActive: { backgroundColor: '#10B981' },
  dotDanger: { backgroundColor: '#EF4444' },
  badgeText: { fontSize: 10, fontWeight: '800', color: '#FFF' },

  mapContainer: { width: '100%', height: 210, position: 'relative', backgroundColor: '#0B0F17' },
  webView: { flex: 1, backgroundColor: '#0B0F17' },
  telemetryCard: {
    margin: 16,
    backgroundColor: '#111827',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  telemetryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  telemetryLabel: { fontSize: 10, fontWeight: '800', color: '#6B7280', letterSpacing: 1 },
  telemetryValue: { fontSize: 10, fontWeight: '900', color: '#10B981', letterSpacing: 0.8 },
  coordsDisplay: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  coordsOverlay: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    backgroundColor: 'rgba(17, 24, 39, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#374151',
  },
  coordsText: { color: '#9CA3AF', fontSize: 11, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  scrollContent: { padding: 16, gap: 12, paddingBottom: 110 },
  card: { backgroundColor: '#111827', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#1F2937' },
  cardDanger: { borderColor: '#EF4444', backgroundColor: 'rgba(239, 68, 68, 0.08)' },
  cardHeader: { fontSize: 10, fontWeight: '800', color: '#6B7280', letterSpacing: 1, marginBottom: 8 },
  detectedSound: { fontSize: 22, fontWeight: '900', color: '#F3F4F6', marginBottom: 4 },
  engineStatus: { fontSize: 11, fontWeight: '700', color: '#3B82F6' },

  triageCard: {
    backgroundColor: '#1E1B4B',
    borderRadius: 16,
    padding: 18,
    borderWidth: 2,
    borderColor: '#6366F1',
    alignItems: 'center',
  },
  triageTopRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  companionPulse: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#818CF8' },
  triageTitle: { fontSize: 11, fontWeight: '900', color: '#A5B4FC', letterSpacing: 1 },
  triageEnglishText: { fontSize: 24, fontWeight: '900', color: '#FFFFFF', textAlign: 'center', marginBottom: 2 },
  triageArabicText: { fontSize: 15, fontWeight: '700', color: '#C7D2FE', textAlign: 'center', marginBottom: 4 },
  triageSubtitle: { fontSize: 11, color: '#9CA3AF', textAlign: 'center', marginTop: 4 },
  countdownNumber: { fontSize: 36, fontWeight: '900', color: '#F87171', marginVertical: 4 },
  triageActionRow: { flexDirection: 'row', gap: 10, width: '100%', marginTop: 8 },
  safeConfirmBtn: {
    flex: 1,
    backgroundColor: '#10B981',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  safeConfirmBtnText: { color: '#FFFFFF', fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },
  sosInstantBtn: {
    flex: 1,
    backgroundColor: '#EF4444',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  sosInstantBtnText: { color: '#FFFFFF', fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },

  emptyAlerts: { color: '#4B5563', fontSize: 13, fontStyle: 'italic', marginTop: 4 },
  alertRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  alertLabel: { color: '#E5E7EB', fontWeight: '700', fontSize: 14 },
  alertTime: { color: '#6B7280', fontSize: 11 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  badgeSuppressed: { backgroundColor: 'rgba(16, 185, 129, 0.15)', borderWidth: 1, borderColor: '#10B981' },
  badgeEscalated: { backgroundColor: 'rgba(239, 68, 68, 0.2)', borderWidth: 1, borderColor: '#EF4444' },
  statusBadgeText: { fontSize: 11, fontWeight: '800' },
  textSuppressed: { color: '#10B981' },
  textEscalated: { color: '#EF4444' },

  actionFooter: {
    position: 'absolute',
    bottom: 0,
    width: width,
    padding: 16,
    paddingBottom: 28,
    backgroundColor: '#111827',
    borderTopWidth: 1,
    borderTopColor: '#1F2937',
  },
  startBtn: { backgroundColor: '#10B981', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  stopBtn: { backgroundColor: '#EF4444', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  btnText: { color: '#FFF', fontWeight: '900', fontSize: 14, letterSpacing: 1 },
});