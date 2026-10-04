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

const DISTRESS_CONFIDENCE_THRESHOLD = 0.20;

const DISTRESS_INDICES = [
  6, 9, 10, 11, 19, 20, 21, 22,
  306, 307, 316, 317, 318, 319,
  390, 391,
  434, 435, 436, 437,
  463, 464,
];

const SOUND_LABELS: Record<number, string> = {
  6: 'Shout / Distress',
  9: 'Yelling',
  10: 'Children Shouting',
  11: 'Screaming',
  19: 'Crying / Sobbing',
  20: 'Baby Cry',
  21: 'Whimper',
  22: 'Wailing',
  306: 'Vehicle Skidding',
  307: 'Tire Squeal',
  316: 'Emergency Vehicle',
  317: 'Police Siren',
  318: 'Ambulance Siren',
  319: 'Fire Truck Siren',
  390: 'Emergency Siren',
  391: 'Civil Defense Siren',
  434: 'Glass Cracking',
  435: 'Glass Impact',
  436: 'Glass Clink',
  437: 'Glass Shatter',
  463: 'Vehicle Crash / Smash',
  464: 'Impact Collision',
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

const COMPANION_PROMPTS = {
  ar: {
    checkInSpeech: 'طمني عليك يا بطل، كل اشي تمام؟',
    checkInTitle: 'فحص الأمان الذكي • AI CHECK-IN',
    checkInPrimary: 'طمني عليك، كل اشي تمام؟',
    checkInSecondary: 'Are you okay? Please confirm.',
    verifyPromptSpeech: 'احكيلي أنا بخير أو طمني شو صار.',
    confirmSafeBtn: 'أنا بخير • I\'M SAFE',
    confirmSafeVoiceBtn: '🎙️ أنا بخير (بصمة الصوت)',
    sosBtn: '🚨 طوارئ SOS',
    noVoiceDetected: 'لم يتم رصد صوت. جاري إرسال إشعار طوارئ.',
    impostorRejected: 'بصمة الصوت غير متطابقة. جاري إشعار غرفة العمليات.',
    serverError: 'تعذر الوصول لخادم الأمان. جاري تصعيد البلاغ.',
    safeReassurance: 'الحمدلله على سلامتك يا بطل، رحلتك مستمرة بأمان.',
    speechLang: 'ar-SA',
  },
  en: {
    checkInSpeech: 'Are you okay? Please confirm you are safe.',
    checkInTitle: 'AI COMPANION SAFETY CHECK',
    checkInPrimary: 'Are you okay?',
    checkInSecondary: 'طمني عليك، كل اشي تمام؟',
    verifyPromptSpeech: 'Say "I am safe" or tell me what happened.',
    confirmSafeBtn: 'I\'M SAFE • أنا بخير',
    confirmSafeVoiceBtn: '🎙️ I\'M SAFE (VERIFY VOICE)',
    sosBtn: '🚨 SOS NOW',
    noVoiceDetected: 'No voice audio detected. Escalating alert.',
    impostorRejected: 'Voice identity rejected. Alerting operations now.',
    serverError: 'Unable to reach safety verification server. Escalating.',
    safeReassurance: 'Safety confirmed! Everything is okay, have a safe trip.',
    speechLang: 'en-US',
  },
};

export default function GuardianAITester() {
  const [status, setStatus] = useState('Initializing...');
  const [latestSound, setLatestSound] = useState('Normal Vehicle Status');
  const [isDanger, setIsDanger] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [alertHistory, setAlertHistory] = useState<AlertEntry[]>([]);
  const [showLiveMap, setShowLiveMap] = useState(true);

  // Companion Spoken Prompt Language Selector ('ar' | 'en')
  const [companionLang, setCompanionLang] = useState<'ar' | 'en'>('ar');

  // Child Companion Chat State
  const [showChatModal, setShowChatModal] = useState(false);
  const wasListeningBeforeChat = useRef(false);

  const openChatModal = async () => {
    if (isListening) {
      wasListeningBeforeChat.current = true;
      await stopAudioListening();
    } else {
      wasListeningBeforeChat.current = false;
    }
    setShowChatModal(true);
  };

  const closeChatModal = async () => {
    setShowChatModal(false);
    if (wasListeningBeforeChat.current) {
      wasListeningBeforeChat.current = false;
      setTimeout(() => {
        startListening();
      }, 350);
    }
  };

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

    // Check if child voice profile is already enrolled on backend
    fetch(`${BACKEND_URL}/api/voice/status/child_01`)
      .then((res) => res.json())
      .then((data) => {
        if (data.enrolled) {
          setIsEnrolled(true);
        }
      })
      .catch(() => {});
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

  // Real-Time Kinematics & Device Health Tracking
  const [gForce, setGForce] = useState(0.0);
  const [batteryLevel, setBatteryLevel] = useState(98);
  const [corridorStatus, setCorridorStatus] = useState('ON ROUTE');
  const [offlineCount, setOfflineCount] = useState(0);

  const gForceRef = useRef(0.0);
  const batteryRef = useRef(98);
  const offlineQueueRef = useRef<{ url: string; body: any }[]>([]);

  // Flush queued requests when connectivity is established
  const flushOfflineQueue = async () => {
    if (offlineQueueRef.current.length === 0) return;
    const queue = [...offlineQueueRef.current];
    offlineQueueRef.current = [];
    setOfflineCount(0);

    for (const item of queue) {
      try {
        await fetch(item.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.body),
        });
      } catch {
        offlineQueueRef.current.push(item);
        setOfflineCount(offlineQueueRef.current.length);
        break;
      }
    }
  };

  const safePost = async (url: string, body: any) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        flushOfflineQueue();
      }
      return res;
    } catch {
      offlineQueueRef.current.push({ url, body });
      setOfflineCount(offlineQueueRef.current.length);
      return null;
    }
  };

  const lastSpeedRef = useRef<number>(0);
  const lastSpeedTimeRef = useRef<number>(Date.now());

  // Kinematic G-Force & acceleration delta calculation
  const computeKinematicGForce = (currentSpeedMs: number) => {
    const now = Date.now();
    const dt = (now - lastSpeedTimeRef.current) / 1000.0;
    if (dt > 0.4) {
      const dv = Math.abs(currentSpeedMs - lastSpeedRef.current);
      const accelMs2 = dv / dt;
      const g = Math.min(2.5, parseFloat((accelMs2 / 9.81).toFixed(2)));
      gForceRef.current = g;
      setGForce(g);
      lastSpeedRef.current = currentSpeedMs;
      lastSpeedTimeRef.current = now;
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

          safePost(`${BACKEND_URL}/api/telemetry/location`, {
            child_id: 'child_01',
            latitude: initialCoords.latitude,
            longitude: initialCoords.longitude,
            speed: initialPos.coords.speed || 0.0,
            g_force_delta: gForceRef.current,
            battery_level: batteryRef.current,
          }).then(async (res) => {
            if (res) {
              const data = await res.json();
              if (data?.corridor?.route_status) {
                setCorridorStatus(data.corridor.route_status);
              }
            }
          });
        }

        locationSubscriptionRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 2500, distanceInterval: 3 },
          (location) => {
            if (!isMounted) return;
            const updatedCoords = { latitude: location.coords.latitude, longitude: location.coords.longitude };
            coordsRef.current = updatedCoords;
            setCoords(updatedCoords);
            const currentSpeed = location.coords.speed || 0.0;
            computeKinematicGForce(currentSpeed);

            safePost(`${BACKEND_URL}/api/telemetry/location`, {
              child_id: 'child_01',
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
              speed: currentSpeed,
              g_force_delta: gForceRef.current,
              battery_level: batteryRef.current,
            }).then(async (res) => {
              if (res) {
                const data = await res.json();
                if (data?.corridor?.route_status) {
                  setCorridorStatus(data.corridor.route_status);
                }
              }
            });
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

    const config = COMPANION_PROMPTS[companionLang];
    Speech.speak(config.checkInSpeech, {
      language: config.speechLang,
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

    if (!isListening) {
      await startListening();
    }

    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setIsVerifyingVoice(true);

    isSpeakingRef.current = true;
    const config = COMPANION_PROMPTS[companionLang];
    Speech.speak(config.verifyPromptSpeech, {
      language: config.speechLang,
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
    const config = COMPANION_PROMPTS[companionLang];

    // Capture 3.5 seconds of child voice response
    setTimeout(async () => {
      isCapturingBiometrics.current = false;
      const samples = new Float32Array(sampleCaptureBuffer.current);
      sampleCaptureBuffer.current = [];

      if (samples.length < 16000) {
        setIsVerifyingVoice(false);
        Speech.speak(config.noVoiceDetected, { language: config.speechLang });
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
          const rejectionSpeech = companionLang === 'ar'
            ? config.impostorRejected
            : (data.triage?.reassurance_speech_en || config.impostorRejected);
          Speech.speak(rejectionSpeech, { language: config.speechLang });
          escalateAlertToBrain(pendingAlert?.soundName || 'Distress Event', pendingAlert?.confidence || 0.8, false, true);
          return;
        }

        // 2. Child identity verified: Check triage outcome
        if (data.triage?.is_emergency) {
          const calmingDistressPrompt = companionLang === 'ar'
            ? (data.triage.reassurance_speech_ar || 'خليك هادي يا بطل، المساعدة جاية بالطريق.')
            : (data.triage.reassurance_speech_en || 'Stay calm champion, help is on the way.');
          Speech.speak(calmingDistressPrompt, { language: config.speechLang });
          escalateAlertToBrain(data.triage.detected_situation, 0.95, false, false);
        } else {
          resolveSafeState(data.triage);
        }
      } catch (err) {
        console.error('Verification error:', err);
        setIsVerifyingVoice(false);
        Speech.speak(config.serverError, { language: config.speechLang });
        escalateAlertToBrain(pendingAlert?.soundName || 'Safety Server Unreachable', pendingAlert?.confidence || 0.8, false, false);
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

    const config = COMPANION_PROMPTS[companionLang];
    const spokenMessage = companionLang === 'ar'
      ? (triageData?.reassurance_speech_ar || config.safeReassurance)
      : (triageData?.reassurance_speech_en || config.safeReassurance);
    const lang = config.speechLang;

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
              const rawOutput: any = outputs[0];
              const scores = rawOutput instanceof Float32Array 
                ? rawOutput 
                : new Float32Array(rawOutput.buffer || rawOutput);

              // 1. Find the highest scoring distress sound among danger classes
              let topDistressScore = 0;
              let topDistressIndex = -1;
              for (const idx of DISTRESS_INDICES) {
                const s = scores[idx] || 0;
                if (s > topDistressScore) {
                  topDistressScore = s;
                  topDistressIndex = idx;
                }
              }

              // 2. Also track global top sound for general UI status
              let globalMaxScore = 0;
              let globalTopIndex = -1;
              for (let i = 0; i < scores.length; i++) {
                if (scores[i] > globalMaxScore) {
                  globalMaxScore = scores[i];
                  globalTopIndex = i;
                }
              }

              // 3. Trigger alert if distress sound exceeds threshold
              if (topDistressScore >= DISTRESS_CONFIDENCE_THRESHOLD && topDistressIndex !== -1) {
                const detectedName = SOUND_LABELS[topDistressIndex] || `Acoustic Anomaly`;
                setLatestSound(`🚨 ${detectedName} (${Math.round(topDistressScore * 100)}%)`);

                if (!showVerificationModalRef.current) {
                  initiateCompanionCheckIn(topDistressIndex, topDistressScore);
                }
              } else if (globalMaxScore > 0.30 && globalTopIndex !== -1) {
                const generalName = SOUND_LABELS[globalTopIndex] || (globalTopIndex === 0 ? 'Speech' : `Ambient (${globalTopIndex})`);
                setLatestSound(`${generalName} (${Math.round(globalMaxScore * 100)}%)`);
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
        <View style={styles.headerTopRow}>
          <View style={styles.brandLockup}>
            <View style={styles.brandIconBadge}>
              <Text style={styles.brandIconText}>🛡️</Text>
            </View>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.brandTitle} numberOfLines={1}>
                PetraRide <Text style={styles.brandAccent}>KIDDOGO</Text>
              </Text>
              <Text style={styles.brandSubtitle} numberOfLines={1}>COCKPIT • TRIP PR-9942</Text>
            </View>
          </View>

          <View style={styles.headerRightActions}>
            <TouchableOpacity
              style={styles.langSelectorPill}
              onPress={() => setCompanionLang((prev) => (prev === 'ar' ? 'en' : 'ar'))}
              activeOpacity={0.8}
            >
              <Text style={styles.langSelectorPillText}>
                {companionLang === 'ar' ? '🌐 عربي' : '🌐 EN'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.chatLaunchPill}
              onPress={openChatModal}
              activeOpacity={0.8}
            >
              <Text style={styles.chatLaunchPillText}>💬 BUDDY</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Biometric Shield Interactive Status Strip */}
        <TouchableOpacity
          style={[styles.shieldBannerBtn, isEnrolled ? styles.shieldBannerActive : styles.shieldBannerInactive]}
          onPress={() => setShowEnrollModal(true)}
          activeOpacity={0.85}
        >
          <View style={styles.shieldBannerLeft}>
            <Text style={styles.shieldBannerIcon}>{isEnrolled ? '🛡️' : '⚠️'}</Text>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.shieldBannerTitle} numberOfLines={1}>
                {isEnrolled ? 'BIOMETRIC VOICE SHIELD ACTIVE' : 'VOICE SHIELD NOT CALIBRATED'}
              </Text>
              <Text style={styles.shieldBannerSub} numberOfLines={1}>
                {isEnrolled ? 'Passenger voice verified • Anti-override locked' : 'Tap to record signature and protect checks'}
              </Text>
            </View>
          </View>
          <View style={[styles.shieldActionTag, isEnrolled ? styles.shieldTagActive : styles.shieldTagInactive]}>
            <Text style={[styles.shieldActionTagText, isEnrolled ? styles.shieldTagTextActive : styles.shieldTagTextInactive]}>
              {isEnrolled ? 'CALIBRATED' : 'CALIBRATE'}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Captain Profile Ribbon */}
      <View style={styles.captainRibbon}>
        <View style={styles.captainRibbonLeft}>
          <View style={styles.captainMiniAvatar}>
            <Text style={styles.captainMiniAvatarText}>AZ</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.captainRibbonName} numberOfLines={1}>
              Captain Ahmad Al-Zoubi
            </Text>
            <Text style={styles.captainRibbonCar} numberOfLines={1}>
              Kia Niro • 24-81923 • ★ 4.98
            </Text>
          </View>
        </View>
        <View style={styles.verifiedTag}>
          <Text style={styles.verifiedTagText}>KIDS-CERTIFIED</Text>
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
              {coords.latitude.toFixed(4)}, {coords.longitude.toFixed(4)} • {showLiveMap ? 'MAP ACTIVE' : 'MAP OFF'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Real-Time Kinematics & Health Strip */}
      <View style={styles.telemetryStrip}>
        <View style={styles.telemetryTile}>
          <Text style={styles.telemetryTileValue}>{gForce.toFixed(2)} G</Text>
          <Text style={styles.telemetryTileLabel}>Motion / G-Force</Text>
        </View>

        <View style={styles.telemetryTile}>
          <Text style={[styles.telemetryTileValue, { color: '#10B981' }]}>{corridorStatus}</Text>
          <Text style={styles.telemetryTileLabel}>Safe Corridor</Text>
        </View>

        <View style={styles.telemetryTile}>
          <Text style={styles.telemetryTileValue}>🔋 {batteryLevel}%</Text>
          <Text style={styles.telemetryTileLabel}>Battery Health</Text>
        </View>
      </View>

      {offlineCount > 0 && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>
            📶 Offline Buffer: {offlineCount} events queued. Auto-syncing...
          </Text>
        </View>
      )}

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* 3. Companion Voice Triage Card */}
        {showVerificationModal && (
          <View style={styles.triageCard}>
            <View style={styles.triageTopRow}>
              <View style={styles.companionPulse} />
              <Text style={styles.triageTitle}>{COMPANION_PROMPTS[companionLang].checkInTitle}</Text>
            </View>

            <Text style={styles.triagePrimaryText}>
              "{COMPANION_PROMPTS[companionLang].checkInPrimary}"
            </Text>
            <Text style={styles.triageSecondaryText}>
              "{COMPANION_PROMPTS[companionLang].checkInSecondary}"
            </Text>

            <Text style={styles.triageSubtitle}>
              Event: {pendingAlert?.soundName} • Safety window:
            </Text>
            <Text style={styles.countdownNumber}>{countdown}s</Text>

            {isVerifyingVoice ? (
              <View style={styles.verifyingContainer}>
                <ActivityIndicator color="#38BDF8" size="small" />
                <Text style={styles.verifyingText}>
                  {companionLang === 'ar' ? 'جاري التحقق من بصمة الصوت...' : 'Verifying Voice Signature...'}
                </Text>
              </View>
            ) : (
              <View style={styles.triageActionRow}>
                <TouchableOpacity style={styles.safeConfirmBtn} onPress={verifyAndConfirmSafe} activeOpacity={0.85}>
                  <Text style={styles.safeConfirmBtnText}>
                    {isEnrolled
                      ? COMPANION_PROMPTS[companionLang].confirmSafeVoiceBtn
                      : COMPANION_PROMPTS[companionLang].confirmSafeBtn}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.sosInstantBtn}
                  onPress={() => {
                    if (pendingAlert) {
                      escalateAlertToBrain(pendingAlert.soundName, pendingAlert.confidence, true);
                    }
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={styles.sosInstantBtnText}>
                    {COMPANION_PROMPTS[companionLang].sosBtn}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* 4. Real-Time Classifier Feedback */}
        <View style={[styles.card, isDanger && styles.cardDanger]}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardHeader}>CABIN ACOUSTIC TELEMETRY</Text>
            <View style={[styles.statusIndicatorDot, { backgroundColor: isDanger ? '#EF4444' : '#10B981' }]} />
          </View>
          <Text style={styles.detectedSound}>{latestSound}</Text>
          <Text style={styles.engineStatus}>SENTINEL: {status.toUpperCase()}</Text>
        </View>

        {/* 5. Incident Log */}
        <View style={styles.card}>
          <Text style={styles.cardHeader}>TRIP SAFETY AUDIT LOG</Text>
          {alertHistory.length === 0 ? (
            <Text style={styles.emptyAlerts}>Normal transit. No acoustic anomalies logged.</Text>
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
          <TouchableOpacity style={styles.startBtn} onPress={startListening} activeOpacity={0.85}>
            <Text style={styles.btnText}>ARM CABIN MONITORING</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.stopBtn} onPress={stopAudioListening} activeOpacity={0.85}>
            <Text style={styles.btnText}>DISARM MONITORING</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* 7. Child Voice Calibration Modal */}
      <Modal visible={showEnrollModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.enrollBox}>
            <Text style={styles.enrollTitle}>🎙️ Voice Signature Calibration</Text>
            <Text style={styles.enrollDesc}>
              Enroll your child's biometric voice profile. This guarantees only your child can dismiss automated safety prompts.
            </Text>

            <View style={styles.enrollStatusCard}>
              <Text style={styles.enrollStatusLabel}>{enrollStatusText}</Text>
            </View>

            <View style={styles.enrollActions}>
              {!isEnrollingAudio ? (
                <TouchableOpacity style={styles.recordEnrollBtn} onPress={startEnrollmentRecording} activeOpacity={0.85}>
                  <Text style={styles.recordEnrollBtnText}>START 4S RECORDING</Text>
                </TouchableOpacity>
              ) : (
                <ActivityIndicator color="#38BDF8" size="large" />
              )}

              <TouchableOpacity style={styles.closeEnrollBtn} onPress={() => setShowEnrollModal(false)} activeOpacity={0.85}>
                <Text style={styles.closeEnrollBtnText}>DISMISS</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 8. Dedicated Child Conversational Chatbot (PetraBuddy) */}
      <CompanionChatModal
        visible={showChatModal}
        onClose={closeChatModal}
        backendUrl={BACKEND_URL}
        coords={coords}
        onPauseMonitoring={stopAudioListening}
        onResumeMonitoring={startListening}
        onTriggerSOS={() => {
          setShowChatModal(false);
          escalateAlertToBrain('MANUAL CHILD COMPANION SOS', 1.0, true, false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#07090E' },
  header: {
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 52 : 44,
    paddingBottom: 12,
    backgroundColor: '#0E131F',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
    gap: 10,
  },
  headerTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  brandLockup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    flex: 1,
    paddingRight: 8,
  },
  brandIconBadge: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: 'rgba(14, 165, 233, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(14, 165, 233, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandIconText: { fontSize: 15 },
  brandTitle: { fontSize: 16.5, fontWeight: '900', color: '#FFFFFF', letterSpacing: -0.2 },
  brandAccent: { color: '#38BDF8' },
  brandSubtitle: { fontSize: 8.5, color: '#94A3B8', fontWeight: '700', letterSpacing: 0.6, marginTop: 1 },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  langSelectorPill: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.16)',
    paddingHorizontal: 8,
    paddingVertical: 5.5,
    borderRadius: 8,
  },
  langSelectorPillText: {
    color: '#F8FAFC',
    fontSize: 9.5,
    fontWeight: '800',
  },
  chatLaunchPill: {
    backgroundColor: 'rgba(14, 165, 233, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(14, 165, 233, 0.4)',
    paddingHorizontal: 8,
    paddingVertical: 5.5,
    borderRadius: 8,
  },
  chatLaunchPillText: {
    color: '#38BDF8',
    fontSize: 9.5,
    fontWeight: '800',
  },

  shieldBannerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  shieldBannerActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  shieldBannerInactive: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  shieldBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    paddingRight: 6,
  },
  shieldBannerIcon: {
    fontSize: 14,
  },
  shieldBannerTitle: {
    fontSize: 10.5,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: 0.2,
  },
  shieldBannerSub: {
    fontSize: 8.5,
    color: '#94A3B8',
    fontWeight: '600',
    marginTop: 1,
  },
  shieldActionTag: {
    paddingHorizontal: 7,
    paddingVertical: 3.5,
    borderRadius: 6,
  },
  shieldTagActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  shieldTagInactive: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
  },
  shieldActionTagText: {
    fontSize: 8.5,
    fontWeight: '800',
  },
  shieldTagTextActive: {
    color: '#34D399',
  },
  shieldTagTextInactive: {
    color: '#FBBF24',
  },

  captainRibbon: {
    backgroundColor: '#12192A',
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  captainRibbonLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  captainMiniAvatar: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#182338',
    borderWidth: 1.5,
    borderColor: '#0EA5E9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  captainMiniAvatarText: {
    color: '#38BDF8',
    fontWeight: '800',
    fontSize: 12,
  },
  captainRibbonName: {
    color: '#F8FAFC',
    fontSize: 12.5,
    fontWeight: '800',
  },
  captainRibbonCar: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '600',
    marginTop: 1,
  },
  verifiedTag: {
    backgroundColor: 'rgba(14, 165, 233, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(14, 165, 233, 0.3)',
  },
  verifiedTagText: {
    color: '#38BDF8',
    fontSize: 8.5,
    fontWeight: '800',
    letterSpacing: 0.4,
  },

  mapContainer: { width: '100%', height: 210, position: 'relative', backgroundColor: '#07090E' },
  webView: { flex: 1, backgroundColor: '#07090E' },
  telemetryCard: { margin: 16, backgroundColor: '#0E131F', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  telemetryValue: { fontSize: 10, fontWeight: '900', color: '#10B981', letterSpacing: 0.8, marginBottom: 4 },
  coordsDisplay: { color: '#94A3B8', fontSize: 13, fontWeight: '700' },

  coordsOverlay: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    backgroundColor: 'rgba(10, 14, 24, 0.88)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  coordsText: { color: '#94A3B8', fontSize: 10.5, fontWeight: '700' },

  scrollContent: { padding: 16, gap: 12, paddingBottom: 110 },
  card: { backgroundColor: '#0E131F', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.08)' },
  cardDanger: { borderColor: '#EF4444', backgroundColor: 'rgba(239, 68, 68, 0.08)' },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardHeader: { fontSize: 10, fontWeight: '800', color: '#64748B', letterSpacing: 1 },
  statusIndicatorDot: { width: 7, height: 7, borderRadius: 4 },
  detectedSound: { fontSize: 19, fontWeight: '900', color: '#F8FAFC', marginBottom: 4 },
  engineStatus: { fontSize: 11, fontWeight: '700', color: '#38BDF8' },

  triageCard: { backgroundColor: '#141C2E', borderRadius: 16, padding: 18, borderWidth: 2, borderColor: '#38BDF8', alignItems: 'center' },
  triageTopRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  companionPulse: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#38BDF8' },
  triageTitle: { fontSize: 11, fontWeight: '900', color: '#38BDF8', letterSpacing: 1 },
  triagePrimaryText: { fontSize: 21, fontWeight: '900', color: '#FFFFFF', textAlign: 'center', lineHeight: 28 },
  triageSecondaryText: { fontSize: 14, fontWeight: '700', color: '#BAE6FD', textAlign: 'center', marginTop: 2, marginBottom: 4 },
  triageSubtitle: { fontSize: 11, color: '#94A3B8', textAlign: 'center', marginTop: 4 },
  countdownNumber: { fontSize: 34, fontWeight: '900', color: '#EF4444', marginVertical: 4 },
  verifyingContainer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  verifyingText: { color: '#BAE6FD', fontSize: 13, fontWeight: '700' },
  triageActionRow: { flexDirection: 'row', gap: 10, width: '100%', marginTop: 8 },
  safeConfirmBtn: { flex: 1, backgroundColor: '#10B981', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  safeConfirmBtnText: { color: '#FFFFFF', fontWeight: '900', fontSize: 12 },
  sosInstantBtn: { flex: 1, backgroundColor: '#EF4444', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  sosInstantBtnText: { color: '#FFFFFF', fontWeight: '900', fontSize: 12 },

  emptyAlerts: { color: '#475569', fontSize: 12.5, fontStyle: 'italic' },
  alertRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: 'rgba(255, 255, 255, 0.06)' },
  alertLabel: { color: '#F1F5F9', fontWeight: '700', fontSize: 12.5 },
  alertTime: { color: '#64748B', fontSize: 10.5, marginTop: 2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  badgeSuppressed: { backgroundColor: 'rgba(16, 185, 129, 0.15)', borderWidth: 1, borderColor: 'rgba(16, 185, 129, 0.35)' },
  badgeEscalated: { backgroundColor: 'rgba(239, 68, 68, 0.2)', borderWidth: 1, borderColor: 'rgba(239, 68, 68, 0.45)' },
  statusBadgeText: { fontSize: 10.5, fontWeight: '800' },
  textSuppressed: { color: '#34D399' },
  textEscalated: { color: '#F87171' },

  actionFooter: { position: 'absolute', bottom: 0, width: width, padding: 16, paddingBottom: Platform.OS === 'ios' ? 32 : 20, backgroundColor: '#0E131F', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.08)' },
  startBtn: { backgroundColor: '#0EA5E9', paddingVertical: 14, borderRadius: 12, alignItems: 'center', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  stopBtn: { backgroundColor: '#EF4444', paddingVertical: 14, borderRadius: 12, alignItems: 'center', shadowColor: '#EF4444', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  btnText: { color: '#FFFFFF', fontWeight: '900', fontSize: 13.5, letterSpacing: 0.8 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  enrollBox: { backgroundColor: '#0E131F', width: '100%', borderRadius: 18, padding: 22, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.12)' },
  enrollTitle: { fontSize: 17, fontWeight: '900', color: '#FFF', marginBottom: 8 },
  enrollDesc: { fontSize: 12, color: '#94A3B8', lineHeight: 18, marginBottom: 16 },
  enrollStatusCard: { backgroundColor: '#141C2E', padding: 14, borderRadius: 10, alignItems: 'center', marginBottom: 18, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.06)' },
  enrollStatusLabel: { color: '#38BDF8', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  enrollActions: { gap: 10 },
  recordEnrollBtn: { backgroundColor: '#0EA5E9', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  recordEnrollBtnText: { color: '#FFF', fontWeight: '900', fontSize: 13 },
  closeEnrollBtn: { backgroundColor: '#182338', paddingVertical: 10, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.08)' },
  closeEnrollBtnText: { color: '#94A3B8', fontWeight: '700', fontSize: 12 },

  telemetryStrip: {
    flexDirection: 'row',
    backgroundColor: '#0A0E18',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
    gap: 8,
  },
  telemetryTile: {
    flex: 1,
    backgroundColor: '#07090E',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  telemetryTileValue: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: 12,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  telemetryTileLabel: {
    fontSize: 8,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#64748B',
    marginTop: 2,
  },
  offlineBanner: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(239, 68, 68, 0.35)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    alignItems: 'center',
  },
  offlineBannerText: {
    color: '#FCA5A5',
    fontSize: 10.5,
    fontWeight: '700',
  },
});