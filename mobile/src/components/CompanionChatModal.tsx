import React, { useState, useRef } from 'react';
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
} from 'react-native';
import * as Speech from 'expo-speech';

interface Message {
  id: string;
  sender: 'child' | 'buddy';
  text: string;
  lang?: 'en' | 'ar';
  time: string;
}

interface CompanionChatModalProps {
  visible: boolean;
  onClose: () => void;
  backendUrl: string;
  coords: { latitude: number; longitude: number };
  onTriggerSOS: () => void;
}

export const CompanionChatModal: React.FC<CompanionChatModalProps> = ({
  visible,
  onClose,
  backendUrl,
  coords,
  onTriggerSOS,
}) => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      sender: 'buddy',
      text: "Hi champ! I'm PetraBuddy, your in-ride companion. How's your ride going?",
      lang: 'en',
      time: 'Just now',
    },
  ]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [sosCountdown, setSosCountdown] = useState<number | null>(null);

  const sosTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
        lang: data.language || 'en',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, buddyMsg]);
    } catch {
      const fallbackMsg: Message = {
        id: (Date.now() + 1).toString(),
        sender: 'buddy',
        text: "I'm right here with you. Everything is monitored and safe.",
        lang: 'en',
        time: 'Just now',
      };
      setMessages((prev) => [...prev, fallbackMsg]);
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
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>✕ Close</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.avatarIcon}>🛡️</Text>
            <View>
              <Text style={styles.buddyTitle}>PetraBuddy</Text>
              <Text style={styles.buddySubtitle}>AI Trip Companion</Text>
            </View>
          </View>

          {/* Instant SOS Click Button */}
          <TouchableOpacity style={styles.sosButton} onPress={handleSosClick}>
            <Text style={styles.sosButtonText}>🚨 SOS HELP</Text>
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
            <TouchableOpacity style={styles.cancelSosBtn} onPress={cancelSosCountdown}>
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
                {/* 1. Full-Width Text Container */}
                <Text style={[styles.bubbleText, isAr && styles.arabicText]}>
                  {item.text}
                </Text>

                {/* 2. Metadata & Audio Control Row */}
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

        {/* Quick Suggestion Pills */}
        <View style={styles.quickRepliesContainer}>
          {quickReplies.map((pill, idx) => (
            <TouchableOpacity
              key={idx}
              style={styles.quickReplyPill}
              onPress={() => sendMessage(pill)}
            >
              <Text style={styles.quickReplyText}>{pill}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Input Bar */}
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder="Type your message in English or عربي..."
            placeholderTextColor="#64748B"
            value={inputText}
            onChangeText={setInputText}
          />
          <TouchableOpacity
            style={[styles.sendBtn, !inputText.trim() && styles.sendBtnDisabled]}
            onPress={() => sendMessage(inputText)}
            disabled={!inputText.trim() || loading}
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
  container: { flex: 1, backgroundColor: '#090D14' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 50,
    paddingBottom: 14,
    backgroundColor: '#111726',
    borderBottomWidth: 1,
    borderBottomColor: '#232F48',
  },
  headerCenter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  avatarIcon: { fontSize: 22 },
  buddyTitle: { color: '#F8FAFC', fontSize: 14, fontWeight: '800' },
  buddySubtitle: { color: '#0EA5E9', fontSize: 10, fontWeight: '600' },
  closeBtn: { padding: 6 },
  closeBtnText: { color: '#94A3B8', fontSize: 12, fontWeight: '700' },

  sosButton: {
    backgroundColor: '#EF4444',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#F87171',
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
    paddingVertical: 10,
    borderRadius: 16,
  },
  childBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#0EA5E9',
    borderBottomRightRadius: 2,
  },
  buddyBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#182238',
    borderBottomLeftRadius: 2,
    borderWidth: 1,
    borderColor: '#232F48',
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 22,
    color: '#F8FAFC',
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
  },
  listenIconBtn: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 6,
  },
  listenIcon: {
    fontSize: 12,
  },

  quickRepliesContainer: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 6,
    flexWrap: 'wrap',
  },
  quickReplyPill: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  quickReplyText: { color: '#94A3B8', fontSize: 11, fontWeight: '600' },

  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    paddingBottom: 28,
    backgroundColor: '#111726',
    borderTopWidth: 1,
    borderTopColor: '#232F48',
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: '#090D14',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#FFF',
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#232F48',
  },
  sendBtn: {
    backgroundColor: '#0EA5E9',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: '#FFF', fontWeight: '800', fontSize: 13 },
});