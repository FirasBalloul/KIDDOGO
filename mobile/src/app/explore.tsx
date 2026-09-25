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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* 1. Page Header */}
      <View style={styles.header}>
        <Text style={styles.pageTitle}>SYSTEM DIAGNOSTICS</Text>
        <Text style={styles.pageSubtitle}>TELEMETRY, HARDWARE & NETWORK AUDIT</Text>
      </View>

      {/* 2. Model Architecture Card */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>EDGE INFERENCE ENGINES</Text>
        <View style={styles.specRow}>
          <Text style={styles.specLabel}>Primary Model</Text>
          <Text style={styles.specValue}>YAMNet (Acoustic CNN)</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specLabel}>Quantization</Text>
          <Text style={styles.specValue}>TFLite (Float32 / INT8)</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specLabel}>Input Windows</Text>
          <Text style={styles.specValue}>15,600 samples @ 16 kHz (~0.975s)</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specLabel}>Visual Verification</Text>
          <Text style={[styles.specValue, styles.highlightValue]}>ResNet50 (Target)</Text>
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
          placeholderTextColor="#4B5563"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.btnRow}>
          <TouchableOpacity style={styles.btnSecondary} onPress={testBackendConnection}>
            <Text style={styles.btnSecondaryText}>PING SERVER</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnWarning} onPress={triggerMockDistress}>
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
            <Text style={styles.toggleDesc}>Compute boundary violations via Haversine</Text>
          </View>
          <Switch
            value={useGeofenceAlerts}
            onValueChange={setUseGeofenceAlerts}
            thumbColor={useGeofenceAlerts ? '#10B981' : '#6B7280'}
            trackColor={{ false: '#374151', true: 'rgba(16, 185, 129, 0.4)' }}
          />
        </View>

        <View style={[styles.toggleRow, styles.toggleBorder]}>
          <View style={styles.toggleTextContainer}>
            <Text style={styles.toggleTitle}>Carrier SMS Fallback</Text>
            <Text style={styles.toggleDesc}>Broadcast emergency SMS on socket failure</Text>
          </View>
          <Switch
            value={autoSmsFallback}
            onValueChange={setAutoSmsFallback}
            thumbColor={autoSmsFallback ? '#10B981' : '#6B7280'}
            trackColor={{ false: '#374151', true: 'rgba(16, 185, 129, 0.4)' }}
          />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0F17',
  },
  content: {
    padding: 16,
    paddingTop: 50,
    gap: 14,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 8,
  },
  pageTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#F9FAFB',
    letterSpacing: 1.5,
  },
  pageSubtitle: {
    fontSize: 9,
    color: '#9CA3AF',
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 2,
  },
  card: {
    backgroundColor: '#111827',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#6B7280',
    letterSpacing: 1,
    marginBottom: 12,
  },
  specRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  specLabel: {
    color: '#9CA3AF',
    fontSize: 12,
    fontWeight: '600',
  },
  specValue: {
    color: '#E5E7EB',
    fontSize: 12,
    fontWeight: '700',
  },
  highlightValue: {
    color: '#3B82F6',
  },
  input: {
    backgroundColor: '#0B0F17',
    borderWidth: 1,
    borderColor: '#374151',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#F9FAFB',
    fontSize: 13,
    marginBottom: 10,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  btnSecondary: {
    flex: 1,
    backgroundColor: '#1F2937',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#374151',
  },
  btnSecondaryText: {
    color: '#E5E7EB',
    fontWeight: '800',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  btnWarning: {
    flex: 1,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#EF4444',
  },
  btnWarningText: {
    color: '#EF4444',
    fontWeight: '800',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  pingText: {
    color: '#10B981',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 8,
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
    borderTopColor: '#1F2937',
    marginTop: 4,
  },
  toggleTextContainer: {
    flex: 1,
    marginRight: 10,
  },
  toggleTitle: {
    color: '#E5E7EB',
    fontSize: 13,
    fontWeight: '700',
  },
  toggleDesc: {
    color: '#6B7280',
    fontSize: 10,
    marginTop: 2,
  },
});