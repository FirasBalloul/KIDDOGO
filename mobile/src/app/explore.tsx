import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Switch,
  Alert,
} from 'react-native';

export default function ExploreDiagnostics() {
  const [backendUrl, setBackendUrl] = useState('http://192.168.1.29:8000');

  const [useGeofenceAlerts, setUseGeofenceAlerts] = useState(true);
  const [autoSmsFallback, setAutoSmsFallback] = useState(false);
  const [pingStatus, setPingStatus] = useState<string | null>(null);

  const testBackendConnection = async () => {
    setPingStatus('Testing connection...');
    try {
      const response = await fetch(`${backendUrl}/docs`, { method: 'GET' });
      if (response.ok || response.status === 200) {
        setPingStatus('Online (HTTP 200)');
      } else {
        setPingStatus(`Replied with status: ${response.status}`);
      }
    } catch {
      setPingStatus('Unreachable (Check Wi-Fi / IP)');
    }
  };

  const triggerMockDistress = async () => {
    try {
      const response = await fetch(`${backendUrl}/api/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sound_type: 'Simulated Screaming',
          confidence: 0.94,
          latitude: 31.9539,
          longitude: 35.9106,
        }),
      });

      if (response.ok) {
        Alert.alert('Alert Dispatched', 'Synthetic distress packet sent to FastAPI brain.');
      } else {
        Alert.alert('Dispatch Error', `Server status: ${response.status}`);
      }
    } catch {
      Alert.alert('Network Failure', 'Failed to reach FastAPI backend.');
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {/* 1. Page Header */}
      <View style={styles.header}>
        <View style={styles.brandLockup}>
          <View style={styles.brandIconBadge}>
            <Text style={styles.brandIconText}>⚡</Text>
          </View>
          <View>
            <Text style={styles.pageTitle}>
              PetraRide <Text style={styles.titleAccent}>KIDDOGO</Text>
            </Text>
            <Text style={styles.pageSubtitle}>SYSTEM DIAGNOSTICS & HARDWARE AUDIT</Text>
          </View>
        </View>
      </View>

      {/* 2. Model Architecture Card */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>EDGE INFERENCE ENGINES</Text>
        <View style={styles.specRow}>
          <Text style={styles.specLabel}>Primary Acoustic Engine</Text>
          <Text style={styles.specValue}>YAMNet (Acoustic CNN)</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specLabel}>Quantization Format</Text>
          <Text style={styles.specValue}>TFLite (Float32 / INT8)</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specLabel}>Sample Windows</Text>
          <Text style={styles.specValue}>15,600 samples @ 16 kHz (~0.975s)</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specLabel}>Biometric Voice Shield</Text>
          <Text style={[styles.specValue, styles.highlightValue]}>SpeechBrain ECAPA-TDNN</Text>
        </View>
      </View>

      {/* 3. Network Configuration */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>BRAIN LINK (FASTAPI ENDPOINT)</Text>
        <TextInput
          style={styles.input}
          value={backendUrl}
          onChangeText={setBackendUrl}
          placeholder="http://192.168.x.x:8000"
          placeholderTextColor="#64748B"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.btnRow}>
          <TouchableOpacity style={styles.btnSecondary} onPress={testBackendConnection} activeOpacity={0.85}>
            <Text style={styles.btnSecondaryText}>PING SERVER</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnWarning} onPress={triggerMockDistress} activeOpacity={0.85}>
            <Text style={styles.btnWarningText}>SEND TEST DISTRESS</Text>
          </TouchableOpacity>
        </View>
        {pingStatus && <Text style={styles.pingText}>{pingStatus}</Text>}
      </View>

      {/* 4. Security Toggles */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>PROTOCOL DIRECTIVES</Text>
        <View style={styles.toggleRow}>
          <View style={styles.toggleTextContainer}>
            <Text style={styles.toggleTitle}>Geofence Telemetry</Text>
            <Text style={styles.toggleDesc}>Compute route deviations via Haversine</Text>
          </View>
          <Switch
            value={useGeofenceAlerts}
            onValueChange={setUseGeofenceAlerts}
            thumbColor={useGeofenceAlerts ? '#10B981' : '#64748B'}
            trackColor={{ false: '#1E293B', true: 'rgba(16, 185, 129, 0.4)' }}
          />
        </View>

        <View style={[styles.toggleRow, styles.toggleBorder]}>
          <View style={styles.toggleTextContainer}>
            <Text style={styles.toggleTitle}>Carrier SMS Fallback</Text>
            <Text style={styles.toggleDesc}>Broadcast emergency SMS on socket loss</Text>
          </View>
          <Switch
            value={autoSmsFallback}
            onValueChange={setAutoSmsFallback}
            thumbColor={autoSmsFallback ? '#10B981' : '#64748B'}
            trackColor={{ false: '#1E293B', true: 'rgba(16, 185, 129, 0.4)' }}
          />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#07090E',
  },
  content: {
    padding: 16,
    paddingTop: 52,
    gap: 14,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 4,
  },
  brandLockup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandIconBadge: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: 'rgba(14, 165, 233, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(14, 165, 233, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandIconText: { fontSize: 16 },
  pageTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  titleAccent: {
    color: '#38BDF8',
  },
  pageSubtitle: {
    fontSize: 8.5,
    color: '#94A3B8',
    fontWeight: '700',
    letterSpacing: 0.8,
    marginTop: 2,
  },
  card: {
    backgroundColor: '#0E131F',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 1,
    marginBottom: 12,
  },
  specRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.06)',
  },
  specLabel: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  specValue: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '700',
  },
  highlightValue: {
    color: '#38BDF8',
  },
  input: {
    backgroundColor: '#07090E',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#F8FAFC',
    fontSize: 13,
    marginBottom: 12,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  btnSecondary: {
    flex: 1,
    backgroundColor: '#141C2E',
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  btnSecondaryText: {
    color: '#F8FAFC',
    fontWeight: '800',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  btnWarning: {
    flex: 1,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  btnWarningText: {
    color: '#F87171',
    fontWeight: '800',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  pingText: {
    color: '#34D399',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 10,
    textAlign: 'center',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  toggleBorder: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.06)',
    marginTop: 4,
  },
  toggleTextContainer: {
    flex: 1,
    marginRight: 10,
  },
  toggleTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
  },
  toggleDesc: {
    color: '#64748B',
    fontSize: 10.5,
    marginTop: 2,
  },
});