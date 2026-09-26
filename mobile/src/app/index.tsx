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
  Modal,
  ActivityIndicator,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { useAudioRecorder } from '@siteed/audio-studio';
import { Buffer } from 'buffer';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { CompanionChatModal } from '../components/CompanionChatModal';

const { width } = Dimensions.get('window');
const BACKEND_URL = 'http://192.168.1.29:8000';

const DISTRESS_CONFIDENCE_THRESHOLD = 0.35;

const DISTRESS_INDICES = [
  20, 21, 22, 23,
  280, 281, 282, 283,
  322, 326,
  358, 359,
  410, 412, 413, 414,
  420, 421, 422, 423,
  432, 433, 434, 435, 436,
  513, 514, 515, 516, 517,
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
  status: 'SUPPRESSED' | 'ESCALATED' | 'MANUAL_SOS' | 'IMPOSTOR_BLOCKED';
}

function createWavBase64(samples: Float32Array, sampleRate: number = 16000): string {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return Buffer.from(buffer).toString('base64');
}

export default function GuardianAITester() {
  const [status, setStatus] = useState('Initializing...');
  const [latestSound, setLatestSound] = useState('Normal Vehicle Status');
  const [isDanger, setIsDanger] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [alertHistory, setAlertHistory] = useState<AlertEntry[]>([]);
  const [showLiveMap, setShowLiveMap] = useState(true);

  // Child Companion Chat State
  const [showChatModal, setShowChatModal] = useState(false);

  // Companion Check-in States
  const [showVerificationModal, setShowVerificationModal] = useState(false);
  const [countdown, setCountdown] = useState(6);
  const [pendingAlert, setPendingAlert] = useState<{ soundName: string; confidence: number; index: number } | null>(null);
  const [isVerifyingVoice, setIsVerifyingVoice] = useState(false);

  // Biometric Voice Calibration States
  const [showEnrollModal, setShowEnrollModal] = useState(false);
  const [isEnrolled, setIsEnrolled] = useState(false);
  const [enrollStatusText, setEnrollStatusText] = useState('Tap record and speak for 4 seconds');
  const [isEnrollingAudio, setIsEnrollingAudio] = useState(false);

  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webViewRef = useRef<WebView>(null);
  const isSpeakingRef = useRef(false);
  const showVerificationModalRef = useRef(false);

  // Cooldown & echo suppression refs
  const lastAlertTime = useRef<number>(0);
  const cooldownUntilRef = useRef<number>(0);

  // Buffer used for biometrics extraction
  const sampleCaptureBuffer = useRef<number[]>([]);
  const isCapturingBiometrics = useRef(false);

  // GPS Telemetry Tracking
  const locationSubscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const coordsRef = useRef({ latitude: 31.9539, longitude: 35.9106 });
  const [coords, setCoords] = useState(coordsRef.current);

  const plugin = useTensorflowModel(require('../../assets/yamnet.tflite'), []);
  const audioBufferRef = useRef<number[]>([]);

  useEffect(() => {
    showVerificationModalRef.current = showVerificationModal;
  }, [showVerificationModal]);

  const { startRecording, stopRecording } = useAudioRecorder();

  useEffect(() => {
    if (plugin.state === 'loaded') {
      setStatus('SafeTrack Active');
    } else if (plugin.state === 'error') {
      const modelError = (plugin as any).error ?? new Error('Model load fault');
      setStatus(`Offline: ${modelError.message || 'Engine fault'}`);
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

  // Continuous high-precision GPS telemetry stream
  useEffect(() => {
    let isMounted = true;
    const startLocationWatch = async () => {
      try {
        let { status: permStatus } = await Location.requestForegroundPermissionsAsync();
        if (permStatus !== 'granted') return;

        const initialPos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (isMounted) {
          const initialCoords = { latitude: initialPos.coords.latitude, longitude: initialPos.coords.longitude };
          coordsRef.current = initialCoords;
          setCoords(initialCoords);
          updateMapCoordinates(initialCoords.latitude, initialCoords.longitude);

          fetch(`${BACKEND_URL}/api/telemetry/location`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              child_id: 'child_01',
              latitude: initialCoords.latitude,
              longitude: initialCoords.longitude,
              speed: initialPos.coords.speed || 0.0,
            }),
          }).catch(() => {});
        }

        locationSubscriptionRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 2500, distanceInterval: 3 },
          (location) => {
            if (!isMounted) return;
            const updatedCoords = { latitude: location.coords.latitude, longitude: location.coords.longitude };
            coordsRef.current = updatedCoords;
            setCoords(updatedCoords);
            updateMapCoordinates(updatedCoords.latitude, updatedCoords.longitude);

            fetch(`${BACKEND_URL}/api/telemetry/location`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                child_id: 'child_01',
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
                speed: location.coords.speed || 0.0,
              }),
            }).catch(() => {});
          }
        );
      } catch (err) {
        console.error('GPS Telemetry error:', err);
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
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
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
      onDone: () => { isSpeakingRef.current = false; },
      onError: () => { isSpeakingRef.current = false; },
    });
  };

  const escalateAlertToBrain = async (soundName: string, confidence: number, manual: boolean = false, impostor: boolean = false) => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setShowVerificationModal(false);
    showVerificationModalRef.current = false;
    setIsDanger(true);
    setLatestSound(impostor ? 'Unauthorized Override Blocked' : 'Operations Dispatched');
    audioBufferRef.current = [];

    const escalationType = manual ? 'MANUAL_SOS' : impostor ? 'IMPOSTOR_BLOCKED' : 'ESCALATED';

    const entry: AlertEntry = {
      id: Math.random().toString(36).substring(7),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      label: impostor ? 'Voice Mismatch Alert Blocked' : soundName,
      confidence: Math.round(confidence * 100),
      status: escalationType,
    };
    setAlertHistory((prev) => [entry, ...prev.slice(0, 4)]);

    const currentLat = coordsRef.current.latitude;
    const currentLon = coordsRef.current.longitude;

    try {
      await fetch(`${BACKEND_URL}/api/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sound_type: soundName,
          confidence: parseFloat(confidence.toFixed(2)),
          latitude: currentLat,
          longitude: currentLon,
          status: impostor ? 'IMPOSTOR_BLOCKED' : manual ? 'MANUAL_SOS_TRIGGERED' : 'CRITICAL_ESCALATION',
        }),
      });
    } catch (err) {
      console.error('Dispatch failed:', err);
    }
  };

  // Biometric Voice Verification and LLM Triage
  const verifyAndConfirmSafe = async () => {
    if (!isEnrolled) {
      resolveSafeState();
      return;
    }

    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setIsVerifyingVoice(true);

    isSpeakingRef.current = true;
    Speech.speak('Say "I am safe" or tell me what happened.', {
      language: 'en-US',
      onDone: () => {
        isSpeakingRef.current = false;
        listenForVerificationVoice();
      },
      onError: () => {
        isSpeakingRef.current = false;
        listenForVerificationVoice();
      }
    });
  };

  const listenForVerificationVoice = () => {
    sampleCaptureBuffer.current = [];
    isCapturingBiometrics.current = true;

    // Capture 3.5 seconds of child voice response
    setTimeout(async () => {
      isCapturingBiometrics.current = false;
      const samples = new Float32Array(sampleCaptureBuffer.current);
      sampleCaptureBuffer.current = [];

      if (samples.length < 16000) {
        setIsVerifyingVoice(false);
        escalateAlertToBrain(pendingAlert?.soundName || 'Distress Event', pendingAlert?.confidence || 0.8, false, true);
        return;
      }

      const wavBase64 = createWavBase64(samples);

      try {
        const res = await fetch(`${BACKEND_URL}/api/voice/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            child_id: 'child_01',
            audio_base64: wavBase64,
            detected_sound: pendingAlert?.soundName || 'In-Cabin Acoustic Event',
          }),
        });
        const data = await res.json();
        setIsVerifyingVoice(false);

        // 1. Biometric verification failed: Reject impostor attempt
        if (!data.verified) {
          const rejectionSpeech = data.triage?.reassurance_speech_en || 'Voice identity rejected. Alerting operations now.';
          Speech.speak(rejectionSpeech, { language: 'en-US' });
          escalateAlertToBrain(pendingAlert?.soundName || 'Distress Event', pendingAlert?.confidence || 0.8, false, true);
          return;
        }

        // 2. Child identity verified: Check triage outcome
        if (data.triage?.is_emergency) {
          const calmingDistressPrompt = data.triage.reassurance_speech_ar || 'خليك هادي يا بطل، المساعدة جاي بالطريق.';
          Speech.speak(calmingDistressPrompt, { language: 'ar-SA' });
          escalateAlertToBrain(data.triage.detected_situation, 0.95, false, false);
        } else {
          resolveSafeState(data.triage);
        }
      } catch (err) {
        console.error('Verification error:', err);
        setIsVerifyingVoice(false);
        resolveSafeState();
      }
    }, 3500);
  };

  const resolveSafeState = (triageData?: any) => {
    setShowVerificationModal(false);
    showVerificationModalRef.current = false;
    setIsDanger(false);
    setLatestSound('Normal Vehicle Status');
    
    audioBufferRef.current = [];
    sampleCaptureBuffer.current = [];

    const spokenMessage = triageData?.reassurance_speech_ar || 'الحمدلله على سلامتك يا بطل، رحلتك مستمرة بأمان.';
    const lang = triageData?.reassurance_speech_ar ? 'ar-SA' : 'en-US';

    isSpeakingRef.current = true;
    cooldownUntilRef.current = Date.now() + 12000;

    Speech.speak(spokenMessage, {
      language: lang,
      onDone: () => {
        setTimeout(() => {
          isSpeakingRef.current = false;
          audioBufferRef.current = [];
        }, 1500);
      },
      onError: () => {
        isSpeakingRef.current = false;
        audioBufferRef.current = [];
      },
    });

    const situationSummary = triageData?.detected_situation
      ? `${pendingAlert?.soundName || 'Acoustic Alert'} (${triageData.detected_situation})`
      : pendingAlert?.soundName || 'Safety Confirmed';

    if (pendingAlert) {
      const entry: AlertEntry = {
        id: Math.random().toString(36).substring(7),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        label: situationSummary,
        confidence: Math.round((pendingAlert?.confidence || 0.9) * 100),
        status: 'SUPPRESSED',
      };
      setAlertHistory((prev) => [entry, ...prev.slice(0, 4)]);
    }
    setPendingAlert(null);
  };

  // One-Time Child Voice Enrollment
  const startEnrollmentRecording = async () => {
    if (!isListening) {
      await startListening();
    }

    setIsEnrollingAudio(true);
    setEnrollStatusText('Listening... Say: "KiddoGo, I am safe in the car"');
    sampleCaptureBuffer.current = [];
    isCapturingBiometrics.current = true;

    setTimeout(async () => {
      isCapturingBiometrics.current = false;
      setIsEnrollingAudio(false);
      setEnrollStatusText('Extracting Biometric Signature...');

      const samples = new Float32Array(sampleCaptureBuffer.current);
      sampleCaptureBuffer.current = [];

      const wavBase64 = createWavBase64(samples);

      try {
        const res = await fetch(`${BACKEND_URL}/api/voice/enroll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            child_id: 'child_01',
            audio_base64: wavBase64,
          }),
        });
        const data = await res.json();
        if (data.status === 'ENROLLED') {
          setIsEnrolled(true);
          setEnrollStatusText('Voice Shield Successfully Calibrated!');
          setTimeout(() => setShowEnrollModal(false), 1500);
        } else {
          setEnrollStatusText('Calibration failed. Please retry.');
        }
      } catch (err) {
        console.error('Enrollment network error:', err);
        setEnrollStatusText('Failed to reach backend.');
      }
    }, 4000);
  };

  const initiateCompanionCheckIn = (topIndex: number, confidence: number) => {
    const now = Date.now();
    if (now < cooldownUntilRef.current || now - lastAlertTime.current < 10000) return;
    lastAlertTime.current = now;

    audioBufferRef.current = [];
    const soundName = SOUND_LABELS[topIndex] || `Distress Event ${topIndex}`;

    setPendingAlert({ soundName, confidence, index: topIndex });
    setShowVerificationModal(true);
    showVerificationModalRef.current = true;
    setCountdown(6);

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
      alert('Wait for acoustic model to initialize');
      return;
    }

    const hasPermission = await requestMicrophonePermission();
    if (!hasPermission) return;

    setIsListening(true);
    setStatus('SafeTrack Active');

    try {
      await startRecording({
        sampleRate: 16000,
        channels: 1,
        encoding: 'pcm_16bit',
        interval: 200,
        onAudioStream: async (event: any) => {
          const chunkBuffer = Buffer.from(event.data, 'base64');
          const int16View = new Int16Array(chunkBuffer.buffer, chunkBuffer.byteOffset, chunkBuffer.length / 2);

          if (isCapturingBiometrics.current) {
            for (let i = 0; i < int16View.length; i++) {
              sampleCaptureBuffer.current.push(int16View[i] / 32768.0);
            }
            return;
          }

          if (
            isSpeakingRef.current || 
            showVerificationModalRef.current || 
            Date.now() < cooldownUntilRef.current
          ) {
            audioBufferRef.current = [];
            return;
          }

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
                const isDistress = DISTRESS_INDICES.includes(topIndex);
                const detectedName = SOUND_LABELS[topIndex] || `Class ${topIndex}`;
                setLatestSound(`${detectedName} (${Math.round(maxScore * 100)}%)`);

                if (isDistress && !showVerificationModalRef.current) {
                  initiateCompanionCheckIn(topIndex, maxScore);
                }
              }
            } catch (err) {
              console.error('Acoustic inference error:', err);
            }
          }
        },
      });
    } catch (error) {
      setIsListening(false);
      setStatus('Microphone Offline');
    }
  };

  const stopAudioListening = async () => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    await stopRecording();
    setIsListening(false);
    setStatus('Standby');
    setLatestSound('Monitoring paused');
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
          body, html, #map { margin: 0; padding: 0; width: 100%; height: 100%; background: #090D14; }
          .leaflet-control-attribution { display: none !important; }
        </style>
      </head>
      <body>
        <div id="map"></div>
        <script>
          const map = L.map('map', { zoomControl: false }).setView([${coords.latitude}, ${coords.longitude}], 15);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

          let marker = L.circleMarker([${coords.latitude}, ${coords.longitude}], {
            radius: 8,
            fillColor: "${isDanger ? '#EF4444' : '#0EA5E9'}",
            color: "#FFFFFF",
            weight: 2,
            opacity: 1,
            fillOpacity: 0.95
          }).addTo(map);

          let rangeCircle = L.circle([${coords.latitude}, ${coords.longitude}], {
            radius: 120,
            fillColor: "${isDanger ? '#EF4444' : '#0EA5E9'}",
            fillOpacity: 0.15,
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
      {/* 1. Brand & Trip Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.brandTitle}>
            PETRA<Text style={styles.brandAccent}>RIDE</Text>
          </Text>
          <Text style={styles.brandSubtitle}>SAFETRACK GUARDIAN • TRIP PR-9942</Text>
        </View>

        <View style={styles.headerRightActions}>
          <TouchableOpacity
            style={styles.chatLaunchPill}
            onPress={() => setShowChatModal(true)}
          >
            <Text style={styles.chatLaunchPillText}>💬 BUDDY CHAT</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.shieldPill, isEnrolled ? styles.shieldActive : styles.shieldInactive]}
            onPress={() => setShowEnrollModal(true)}
          >
            <Text style={styles.shieldText}>
              {isEnrolled ? '🛡️ ENROLLED' : '⚠️ ENROLL'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Captain Profile Ribbon (Pillar 1) */}
      <View style={styles.captainRibbon}>
        <View style={styles.captainRibbonLeft}>
          <View style={styles.captainMiniAvatar}>
            <Text style={styles.captainMiniAvatarText}>AZ</Text>
          </View>
          <View>
            <Text style={styles.captainRibbonName}>Captain Ahmad Al-Zoubi</Text>
            <Text style={styles.captainRibbonCar}>Kia Niro (24-81923) • Rating 4.98</Text>
          </View>
        </View>
        <View style={styles.verifiedTag}>
          <Text style={styles.verifiedTagText}>★ KIDS-CERTIFIED</Text>
        </View>
      </View>

      {/* 2. Real-Time Telemetry Map */}
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
            <Text style={styles.telemetryValue}>ROUTE SATELLITE LOCK ACTIVE</Text>
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
        {showVerificationModal && (
          <View style={styles.triageCard}>
            <View style={styles.triageTopRow}>
              <View style={styles.companionPulse} />
              <Text style={styles.triageTitle}>AI COMPANION CHECK-IN</Text>
            </View>

            <Text style={styles.triageEnglishText}>"Are you okay?"</Text>
            <Text style={styles.triageArabicText}>"طمني عليك، كل اشي تمام؟"</Text>

            <Text style={styles.triageSubtitle}>
              Event: {pendingAlert?.soundName} • Safety window:
            </Text>
            <Text style={styles.countdownNumber}>{countdown}s</Text>

            {isVerifyingVoice ? (
              <View style={styles.verifyingContainer}>
                <ActivityIndicator color="#0EA5E9" size="small" />
                <Text style={styles.verifyingText}>Verifying Voice Signature...</Text>
              </View>
            ) : (
              <View style={styles.triageActionRow}>
                <TouchableOpacity style={styles.safeConfirmBtn} onPress={verifyAndConfirmSafe}>
                  <Text style={styles.safeConfirmBtnText}>
                    {isEnrolled ? "🎙️ I'M SAFE (VERIFY VOICE)" : "I'M SAFE • أنا بخير"}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.sosInstantBtn}
                  onPress={() => {
                    if (pendingAlert) {
                      escalateAlertToBrain(pendingAlert.soundName, pendingAlert.confidence, true);
                    }
                  }}
                >
                  <Text style={styles.sosInstantBtnText}>🚨 SOS NOW</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* 4. Real-Time Classifier Feedback */}
        <View style={[styles.card, isDanger && styles.cardDanger]}>
          <Text style={styles.cardHeader}>CABIN ACOUSTIC TELEMETRY</Text>
          <Text style={styles.detectedSound}>{latestSound}</Text>
          <Text style={styles.engineStatus}>SYSTEM: {status.toUpperCase()}</Text>
        </View>

        {/* 5. Incident Log */}
        <View style={styles.card}>
          <Text style={styles.cardHeader}>TRIP EVENT AUDIT LOG</Text>
          {alertHistory.length === 0 ? (
            <Text style={styles.emptyAlerts}>Normal transit. No safety breaches logged.</Text>
          ) : (
            alertHistory.map((item) => (
              <View key={item.id} style={styles.alertRow}>
                <View style={{ flex: 1, paddingRight: 8 }}>
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
                      item.status === 'SUPPRESSED' ? styles.textSuppressed : styles.textEscalated,
                    ]}
                  >
                    {item.status} ({item.confidence}%)
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {/* 6. Footer Button */}
      <View style={styles.actionFooter}>
        {!isListening ? (
          <TouchableOpacity style={styles.startBtn} onPress={startListening}>
            <Text style={styles.btnText}>ARM CABIN MONITORING</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.stopBtn} onPress={stopAudioListening}>
            <Text style={styles.btnText}>DISARM MONITORING</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* 7. Child Voice Calibration Modal */}
      <Modal visible={showEnrollModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.enrollBox}>
            <Text style={styles.enrollTitle}>🎙️ Passenger Voice Calibration</Text>
            <Text style={styles.enrollDesc}>
              Enroll your child's voice signature. This prevents drivers or third parties from dismissing automated safety checks on the child's behalf.
            </Text>

            <View style={styles.enrollStatusCard}>
              <Text style={styles.enrollStatusLabel}>{enrollStatusText}</Text>
            </View>

            <View style={styles.enrollActions}>
              {!isEnrollingAudio ? (
                <TouchableOpacity style={styles.recordEnrollBtn} onPress={startEnrollmentRecording}>
                  <Text style={styles.recordEnrollBtnText}>START 4S RECORDING</Text>
                </TouchableOpacity>
              ) : (
                <ActivityIndicator color="#0EA5E9" size="large" />
              )}

              <TouchableOpacity style={styles.closeEnrollBtn} onPress={() => setShowEnrollModal(false)}>
                <Text style={styles.closeEnrollBtnText}>CLOSE</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 8. Dedicated Child Conversational Chatbot (PetraBuddy) */}
      <CompanionChatModal
        visible={showChatModal}
        onClose={() => setShowChatModal(false)}
        backendUrl={BACKEND_URL}
        coords={coords}
        onTriggerSOS={() => {
          setShowChatModal(false);
          escalateAlertToBrain('MANUAL CHILD COMPANION SOS', 1.0, true, false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#090D14' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 50,
    paddingBottom: 14,
    backgroundColor: '#111726',
    borderBottomWidth: 1,
    borderBottomColor: '#232F48',
  },
  brandTitle: { fontSize: 20, fontWeight: '900', color: '#F8FAFC', letterSpacing: 1.2 },
  brandAccent: { color: '#0EA5E9' },
  brandSubtitle: { fontSize: 8.5, color: '#94A3B8', fontWeight: '700', letterSpacing: 0.6 },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chatLaunchPill: {
    backgroundColor: 'rgba(14, 165, 233, 0.15)',
    borderWidth: 1,
    borderColor: '#0EA5E9',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 12,
  },
  chatLaunchPillText: {
    color: '#0EA5E9',
    fontSize: 9.5,
    fontWeight: '800',
  },
  shieldPill: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 12, borderWidth: 1 },
  shieldActive: { backgroundColor: 'rgba(16, 185, 129, 0.15)', borderColor: '#10B981' },
  shieldInactive: { backgroundColor: 'rgba(239, 68, 68, 0.15)', borderColor: '#EF4444' },
  shieldText: { color: '#FFF', fontSize: 9.5, fontWeight: '800' },

  captainRibbon: {
    backgroundColor: '#182238',
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#232F48',
  },
  captainRibbonLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  captainMiniAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#0EA5E9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  captainMiniAvatarText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 12,
  },
  captainRibbonName: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '700',
  },
  captainRibbonCar: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '500',
  },
  verifiedTag: {
    backgroundColor: 'rgba(14, 165, 233, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(14, 165, 233, 0.4)',
  },
  verifiedTagText: {
    color: '#0EA5E9',
    fontSize: 9,
    fontWeight: '800',
  },

  mapContainer: { width: '100%', height: 210, position: 'relative', backgroundColor: '#090D14' },
  webView: { flex: 1, backgroundColor: '#090D14' },
  telemetryCard: { margin: 16, backgroundColor: '#111726', borderRadius: 14, padding: 14 },
  telemetryValue: { fontSize: 10, fontWeight: '900', color: '#10B981', letterSpacing: 0.8, marginBottom: 4 },
  coordsDisplay: { color: '#94A3B8', fontSize: 13, fontWeight: '700' },

  coordsOverlay: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    backgroundColor: 'rgba(17, 23, 38, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  coordsText: { color: '#94A3B8', fontSize: 11, fontWeight: '700' },

  scrollContent: { padding: 16, gap: 12, paddingBottom: 110 },
  card: { backgroundColor: '#111726', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#232F48' },
  cardDanger: { borderColor: '#EF4444', backgroundColor: 'rgba(239, 68, 68, 0.08)' },
  cardHeader: { fontSize: 10, fontWeight: '800', color: '#64748B', letterSpacing: 1, marginBottom: 8 },
  detectedSound: { fontSize: 20, fontWeight: '900', color: '#F8FAFC', marginBottom: 4 },
  engineStatus: { fontSize: 11, fontWeight: '700', color: '#0EA5E9' },

  triageCard: { backgroundColor: '#182238', borderRadius: 16, padding: 18, borderWidth: 2, borderColor: '#0EA5E9', alignItems: 'center' },
  triageTopRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  companionPulse: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#0EA5E9' },
  triageTitle: { fontSize: 11, fontWeight: '900', color: '#38BDF8', letterSpacing: 1 },
  triageEnglishText: { fontSize: 24, fontWeight: '900', color: '#FFFFFF', textAlign: 'center' },
  triageArabicText: { fontSize: 15, fontWeight: '700', color: '#BAE6FD', textAlign: 'center', marginBottom: 4 },
  triageSubtitle: { fontSize: 11, color: '#94A3B8', textAlign: 'center', marginTop: 4 },
  countdownNumber: { fontSize: 36, fontWeight: '900', color: '#EF4444', marginVertical: 4 },
  verifyingContainer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  verifyingText: { color: '#BAE6FD', fontSize: 13, fontWeight: '700' },
  triageActionRow: { flexDirection: 'row', gap: 10, width: '100%', marginTop: 8 },
  safeConfirmBtn: { flex: 1, backgroundColor: '#10B981', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  safeConfirmBtnText: { color: '#FFFFFF', fontWeight: '900', fontSize: 12 },
  sosInstantBtn: { flex: 1, backgroundColor: '#EF4444', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  sosInstantBtnText: { color: '#FFFFFF', fontWeight: '900', fontSize: 12 },

  emptyAlerts: { color: '#475569', fontSize: 13, fontStyle: 'italic' },
  alertRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#232F48' },
  alertLabel: { color: '#E2E8F0', fontWeight: '700', fontSize: 13 },
  alertTime: { color: '#64748B', fontSize: 11 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  badgeSuppressed: { backgroundColor: 'rgba(16, 185, 129, 0.15)', borderWidth: 1, borderColor: '#10B981' },
  badgeEscalated: { backgroundColor: 'rgba(239, 68, 68, 0.2)', borderWidth: 1, borderColor: '#EF4444' },
  statusBadgeText: { fontSize: 11, fontWeight: '800' },
  textSuppressed: { color: '#10B981' },
  textEscalated: { color: '#EF4444' },

  actionFooter: { position: 'absolute', bottom: 0, width: width, padding: 16, paddingBottom: 28, backgroundColor: '#111726', borderTopWidth: 1, borderTopColor: '#232F48' },
  startBtn: { backgroundColor: '#0EA5E9', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  stopBtn: { backgroundColor: '#EF4444', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  btnText: { color: '#FFF', fontWeight: '900', fontSize: 14, letterSpacing: 1 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  enrollBox: { backgroundColor: '#111726', width: '100%', borderRadius: 18, padding: 22, borderWidth: 1, borderColor: '#232F48' },
  enrollTitle: { fontSize: 18, fontWeight: '900', color: '#FFF', marginBottom: 8 },
  enrollDesc: { fontSize: 12, color: '#94A3B8', lineHeight: 18, marginBottom: 16 },
  enrollStatusCard: { backgroundColor: '#182238', padding: 14, borderRadius: 10, alignItems: 'center', marginBottom: 18 },
  enrollStatusLabel: { color: '#38BDF8', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  enrollActions: { gap: 10 },
  recordEnrollBtn: { backgroundColor: '#0EA5E9', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  recordEnrollBtnText: { color: '#FFF', fontWeight: '900', fontSize: 13 },
  closeEnrollBtn: { backgroundColor: '#232F48', paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  closeEnrollBtnText: { color: '#94A3B8', fontWeight: '700', fontSize: 12 },
});