import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Vibration,
  Animated,
} from 'react-native';
import * as Speech from 'expo-speech';
import { useAudioRecorder } from '@siteed/audio-studio';
import { Buffer } from 'buffer';

interface Message {
  id: string;
  sender: 'child' | 'buddy';
  text: string;
  isVoice?: boolean;
  lang?: 'en' | 'ar';
  time: string;
}

interface CompanionChatModalProps {
  visible: boolean;
  onClose: () => void;
  backendUrl: string;
  coords: { latitude: number; longitude: number };
  onTriggerSOS: () => void;
  onPauseMonitoring?: () => Promise<void>;
  onResumeMonitoring?: () => Promise<void>;
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

export const CompanionChatModal: React.FC<CompanionChatModalProps> = ({
  visible,
  onClose,
  backendUrl,
  coords,
  onTriggerSOS,
  onPauseMonitoring,
  onResumeMonitoring,
}) => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      sender: 'buddy',
      text: "Hi champ! I'm PetraBuddy, your in-ride safety friend. How's your ride going? You can type or tap the mic to speak with me!",
      lang: 'en',
      time: 'Just now',
    },
  ]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const [sosCountdown, setSosCountdown] = useState<number | null>(null);

  const sosTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voiceSampleBuffer = useRef<number[]>([]);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const { startRecording, stopRecording } = useAudioRecorder();

  useEffect(() => {
    if (isRecordingVoice) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.25, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1.0, duration: 600, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isRecordingVoice]);

  const quickReplies = [
    '🚗 How long until we arrive?',
    '✨ Tell me a fun riddle',
    '⚠️ Something feels wrong',
    '🚗 كم ضايل ونوصل؟',
  ];

  const sendMessage = async (textToSend: string) => {
    if (!textToSend.trim() || loading) return;

    const isArabicInput = anyArabicChar(textToSend);
    const userMsg: Message = {
      id: Date.now().toString(),
      sender: 'child',
      text: textToSend,
      lang: isArabicInput ? 'ar' : 'en',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    setLoading(true);

    try {
      const res = await fetch(`${backendUrl}/api/companion/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          child_id: 'child_01',
          message: textToSend,
          latitude: coords.latitude,
          longitude: coords.longitude,
        }),
      });

      const data = await res.json();
      const buddyMsg: Message = {
        id: (Date.now() + 1).toString(),
        sender: 'buddy',
        text: data.reply,
        lang: data.language || (isArabicInput ? 'ar' : 'en'),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, buddyMsg]);
      // Note: Do not auto-play voice for typed text; user can tap 🔊 on the bubble to listen
    } catch {
      const fallbackMsg: Message = {
        id: (Date.now() + 1).toString(),
        sender: 'buddy',
        text: isArabicInput
          ? 'أنا معك يا بطل وسامعك، كل اشي مراقب وبأمان.'
          : "I'm right here with you. Everything is monitored and safe.",
        lang: isArabicInput ? 'ar' : 'en',
        time: 'Just now',
      };
      setMessages((prev) => [...prev, fallbackMsg]);
      // Note: Do not auto-play voice for typed text
    } finally {
      setLoading(false);
    }
  };

  const startVoiceRecording = async () => {
    try {
      if (onPauseMonitoring) {
        await onPauseMonitoring();
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      Vibration.vibrate([0, 60]);
      voiceSampleBuffer.current = [];
      setIsRecordingVoice(true);
      setRecordDuration(0);

      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      recordTimerRef.current = setInterval(() => {
        setRecordDuration((prev) => prev + 1);
      }, 1000);

      await startRecording({
        sampleRate: 16000,
        channels: 1,
        encoding: 'pcm_16bit',
        interval: 200,
        onAudioStream: async (event: any) => {
          const chunkBuffer = Buffer.from(event.data, 'base64');
          const int16View = new Int16Array(chunkBuffer.buffer, chunkBuffer.byteOffset, chunkBuffer.length / 2);
          for (let i = 0; i < int16View.length; i++) {
            voiceSampleBuffer.current.push(int16View[i] / 32768.0);
          }
        },
      });
    } catch (err) {
      console.error('Failed to start voice message recording:', err);
      setIsRecordingVoice(false);
      if (onResumeMonitoring) {
        onResumeMonitoring();
      }
    }
  };

  const stopAndSendVoice = async () => {
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    setIsRecordingVoice(false);
    Vibration.vibrate([0, 80]);

    try {
      await stopRecording();
    } catch {}

    const samples = new Float32Array(voiceSampleBuffer.current);
    voiceSampleBuffer.current = [];

    if (samples.length < 8000) {
      // Less than 0.5s audio
      if (onResumeMonitoring) {
        setTimeout(() => onResumeMonitoring(), 400);
      }
      return;
    }

    const wavBase64 = createWavBase64(samples);
    setLoading(true);

    try {
      const res = await fetch(`${backendUrl}/api/companion/chat-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          child_id: 'child_01',
          audio_base64: wavBase64,
          latitude: coords.latitude,
          longitude: coords.longitude,
        }),
      });

      const data = await res.json();
      const transcribedText = data.transcription || 'Voice message sent';
      const isArabic = data.language === 'ar' || anyArabicChar(transcribedText);

      const userVoiceMsg: Message = {
        id: Date.now().toString(),
        sender: 'child',
        text: `🎙️ ${transcribedText}`,
        isVoice: true,
        lang: isArabic ? 'ar' : 'en',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      const buddyReplyMsg: Message = {
        id: (Date.now() + 1).toString(),
        sender: 'buddy',
        text: data.reply,
        lang: data.language || (isArabic ? 'ar' : 'en'),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, userVoiceMsg, buddyReplyMsg]);
      playSpeech(buddyReplyMsg.text, buddyReplyMsg.lang);
    } catch (err) {
      console.error('Voice chat send error:', err);
      const fallbackBuddy: Message = {
        id: (Date.now() + 1).toString(),
        sender: 'buddy',
        text: 'أنا معك وسامعك يا بطل، رحلتك مستمرة بأمان.',
        lang: 'ar',
        time: 'Just now',
      };
      setMessages((prev) => [...prev, fallbackBuddy]);
      playSpeech(fallbackBuddy.text, 'ar');
    } finally {
      setLoading(false);
    }
  };

  const playSpeech = (text: string, lang: 'en' | 'ar' = 'en') => {
    Speech.stop();
    Speech.speak(text, {
      language: lang === 'ar' ? 'ar-SA' : 'en-US',
      pitch: 1.05,
      rate: 0.95,
    });
  };

  const handleSosClick = () => {
    Vibration.vibrate([0, 250, 150, 250]);
    setSosCountdown(3);

    if (sosTimerRef.current) clearInterval(sosTimerRef.current);
    sosTimerRef.current = setInterval(() => {
      setSosCountdown((prev) => {
        if (prev === null || prev <= 1) {
          if (sosTimerRef.current) clearInterval(sosTimerRef.current);
          onTriggerSOS();
          setSosCountdown(null);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const cancelSosCountdown = () => {
    if (sosTimerRef.current) clearInterval(sosTimerRef.current);
    setSosCountdown(null);
    Vibration.cancel();
  };

  function anyArabicChar(str: string) {
    return /[\u0600-\u06FF]/.test(str);
  }

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={() => {
              Speech.stop();
              onClose();
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.closeBtnText}>✕ Close</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <View style={styles.avatarPill}>
              <Text style={styles.avatarIcon}>🛡️</Text>
            </View>
            <View>
              <Text style={styles.buddyTitle}>PetraRide KIDDOGO</Text>
              <Text style={styles.buddySubtitle}>AI SafeTrack Companion</Text>
            </View>
          </View>

          {/* Instant SOS Click Button */}
          <TouchableOpacity style={styles.sosButton} onPress={handleSosClick} activeOpacity={0.85}>
            <Text style={styles.sosButtonText}>🚨 SOS</Text>
          </TouchableOpacity>
        </View>

        {/* SOS Countdown Alert Banner */}
        {sosCountdown !== null && (
          <View style={styles.countdownBanner}>
            <View style={{ flex: 1 }}>
              <Text style={styles.countdownText}>
                ⚠️ Alerting Operations & Parents in {sosCountdown}s...
              </Text>
              <Text style={styles.countdownSub}>Tap cancel if this was a mistake.</Text>
            </View>
            <TouchableOpacity style={styles.cancelSosBtn} onPress={cancelSosCountdown} activeOpacity={0.85}>
              <Text style={styles.cancelSosBtnText}>CANCEL ✕</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Messages Feed */}
        <FlatList
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messageList}
          renderItem={({ item }) => {
            const isChild = item.sender === 'child';
            const isAr = item.lang === 'ar';
            return (
              <View
                style={[
                  styles.bubble,
                  isChild ? styles.childBubble : styles.buddyBubble,
                ]}
              >
                <Text style={[styles.bubbleText, isAr && styles.arabicText]}>
                  {item.text}
                </Text>

                <View style={styles.bubbleFooterRow}>
                  <Text style={styles.bubbleTime}>{item.time}</Text>

                  {!isChild && (
                    <TouchableOpacity
                      style={styles.listenIconBtn}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      onPress={() => playSpeech(item.text, item.lang)}
                    >
                      <Text style={styles.listenIcon}>🔊</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          }}
        />

        {/* Voice Recording In-Progress Banner */}
        {isRecordingVoice && (
          <View style={styles.recordingBanner}>
            <Animated.View style={[styles.recordingDot, { transform: [{ scale: pulseAnim }] }]} />
            <Text style={styles.recordingText}>Listening... Speak to Kiddogo Buddy ({recordDuration}s)</Text>
            <TouchableOpacity style={styles.sendVoiceBtn} onPress={stopAndSendVoice} activeOpacity={0.85}>
              <Text style={styles.sendVoiceBtnText}>SEND 🎙️</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Quick Suggestion Pills */}
        <View style={styles.quickRepliesContainer}>
          {quickReplies.map((pill, idx) => (
            <TouchableOpacity
              key={idx}
              style={styles.quickReplyPill}
              onPress={() => sendMessage(pill)}
              activeOpacity={0.8}
            >
              <Text style={styles.quickReplyText}>{pill}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Input Bar */}
        <View style={styles.inputContainer}>
          <TouchableOpacity
            style={[styles.micBtn, isRecordingVoice && styles.micBtnActive]}
            onPress={isRecordingVoice ? stopAndSendVoice : startVoiceRecording}
            activeOpacity={0.85}
          >
            <Text style={styles.micBtnIcon}>{isRecordingVoice ? '⏹️' : '🎙️'}</Text>
          </TouchableOpacity>

          <TextInput
            style={styles.input}
            placeholder="Type or tap mic to speak..."
            placeholderTextColor="#64748B"
            value={inputText}
            onChangeText={setInputText}
          />

          <TouchableOpacity
            style={[styles.sendBtn, !inputText.trim() && styles.sendBtnDisabled]}
            onPress={() => sendMessage(inputText)}
            disabled={!inputText.trim() || loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.sendBtnText}>Send</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#07090E' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 52 : 44,
    paddingBottom: 14,
    backgroundColor: '#0E131F',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  headerCenter: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatarPill: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(14, 165, 233, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(14, 165, 233, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarIcon: { fontSize: 16 },
  buddyTitle: { color: '#F8FAFC', fontSize: 14.5, fontWeight: '900', letterSpacing: -0.2 },
  buddySubtitle: { color: '#38BDF8', fontSize: 9.5, fontWeight: '700', marginTop: 1 },
  closeBtn: { padding: 6 },
  closeBtnText: { color: '#94A3B8', fontSize: 12, fontWeight: '700' },

  sosButton: {
    backgroundColor: '#EF4444',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.5)',
    shadowColor: '#EF4444',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  sosButtonText: { color: '#FFF', fontSize: 11, fontWeight: '900' },

  countdownBanner: {
    backgroundColor: '#7F1D1D',
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#EF4444',
  },
  countdownText: { color: '#FEE2E2', fontSize: 12, fontWeight: '800' },
  countdownSub: { color: '#FCA5A5', fontSize: 10, marginTop: 2 },
  cancelSosBtn: {
    backgroundColor: '#EF4444',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  cancelSosBtnText: { color: '#FFF', fontSize: 11, fontWeight: '900' },

  messageList: { padding: 16, gap: 12 },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 16,
  },
  childBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#0284C7',
    borderBottomRightRadius: 2,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  buddyBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#141C2E',
    borderBottomLeftRadius: 2,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 22,
    color: '#F8FAFC',
    fontWeight: '600',
    writingDirection: 'auto',
  },
  arabicText: {
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  bubbleFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
    gap: 8,
  },
  bubbleTime: {
    fontSize: 10,
    color: 'rgba(255, 255, 255, 0.55)',
    fontWeight: '600',
  },
  listenIconBtn: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 6,
  },
  listenIcon: { fontSize: 12 },

  recordingBanner: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#EF4444',
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#EF4444' },
  recordingText: { color: '#FEE2E2', fontSize: 12, fontWeight: '700', flex: 1, marginLeft: 10 },
  sendVoiceBtn: { backgroundColor: '#EF4444', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  sendVoiceBtnText: { color: '#FFF', fontSize: 11, fontWeight: '900' },

  quickRepliesContainer: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 6,
    flexWrap: 'wrap',
  },
  quickReplyPill: {
    backgroundColor: '#141C2E',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  quickReplyText: { color: '#94A3B8', fontSize: 11, fontWeight: '700' },

  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 14,
    backgroundColor: '#0E131F',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
    gap: 8,
  },
  micBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: 'rgba(14, 165, 233, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(14, 165, 233, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderColor: '#EF4444',
  },
  micBtnIcon: { fontSize: 18 },
  input: {
    flex: 1,
    backgroundColor: '#07090E',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#FFF',
    fontSize: 13,
    fontWeight: '600',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  sendBtn: {
    backgroundColor: '#0EA5E9',
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 12,
  },
  sendBtnDisabled: { opacity: 0.35 },
  sendBtnText: { color: '#FFF', fontWeight: '900', fontSize: 13 },
});