KiddoGo.AI — Multi-Modal Guardian Architecture
==============================================

**KiddoGo.AI** is an intelligent child-safety and guardian mobile client built on React Native's New Architecture (Fabric). It runs low-latency, on-device acoustic distress classification using a quantified TensorFlow Lite model (YAMNet), executes voice check-in triage routines, and dispatches incident telemetry with live GPS to an operations command dashboard.

Architecture Overview
---------------------

Plaintext

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML       `[ Raw Microphone Input (16 kHz PCM) ]                           │                           ▼          [ @siteed/audio-studio Ring Buffer ]                           │  (15,600 samples = ~0.975s)                           ▼     [ YAMNet TFLite Engine (react-native-fast-tflite) ]                           │                           ▼           [ Multi-Class Distress Detection ]       (Glass Break, Vehicle Crash, Screaming, Sirens)                           │           ┌───────────────┴───────────────┐           ▼                               ▼   [ Below Threshold ]           [ Distress Anomaly Detected ]     (Normal Audio)                        │                                           ▼                               [ Companion Voice Triage ]                                - Arabic / English TTS                                - 5-Second Countdown                                - Haptic Feedback                                           │                      ┌────────────────────┴────────────────────┐                      ▼                                         ▼              [ "I'm Safe" Pressed ]                [ Countdown Expired / SOS ]              - Event Suppressed                    - Autonomous Dispatch              - Logged to History                   - POST to FastAPI /api/alerts                                                    - Pinned on KiddoGo Command Map`

Key Features
------------

*   **Edge Acoustic Inference:** On-device neural inference using Google's YAMNet model compiled via react-native-fast-tflite (C++ TurboModules/Nitro), avoiding continuous cloud audio streaming for privacy and speed.
    
*   **Tuned Distress Taxonomy:** Target-classified indices mapped for acoustic trauma:
    
    *   Glass breakage, shattering, and ceramic impact (358, 412, 432–436).
        
    *   Severe impact, smash, and collision (410, 413, 414, 422, 423).
        
    *   Vocal distress, crying, screaming, and grunts (20–23, 513–517).
        
    *   Sirens and emergency signals (280–283).
        
*   **Companion Voice Triage:** Immediate spoken interaction (_"Are you okay?"_) with an on-screen timeout counter to differentiate true emergencies from benign drops or loud toys.
    
*   **Feedback Loop Protection:** Dynamic stream gating via internal flags (isSpeakingRef, modal state sync) that mutes the microphone while TTS is speaking to prevent the model from classifying its own voice.
    
*   **Fabric-Safe Embedded Mapping:** High-performance, self-contained Leaflet/OpenStreetMap interface mounted using react-native-webview to eliminate native view hierarchy collisions on the New Architecture.
    
*   **Operations Dispatch:** Real-time transmission of GPS coordinates, confidence ratings, and incident tags to the centralized FastAPI backend.
    

Tech Stack
----------

### Mobile Client

*   **Framework:** React Native (New Architecture / Fabric enabled) via Expo Router
    
*   **Neural Runtime:** react-native-fast-tflite (YAMNet float32/int8)
    
*   **Audio Streaming:** @siteed/audio-studio
    
*   **Hardware & Device APIS:** expo-location, expo-speech
    
*   **Maps & Visual Surfaces:** react-native-webview (OpenStreetMap / Leaflet)
    

### Backend & Operations

*   **API Service:** FastAPI
    
*   **Command Center:** Real-time OpenStreetMap web view with telemetry logs
    

Directory Structure
-------------------

Plaintext

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   ├── assets/  │   └── yamnet.tflite          # Quantized YAMNet model weights  ├── mobile/  │   ├── android/               # Native Android project configuration  │   ├── src/  │   │   └── app/  │   │       └── index.tsx      # Core Guardian edge inference & UI screen  │   ├── app.json               # Expo client configuration  │   └── package.json  └── README.md   `

Getting Started
---------------

### Prerequisites

*   Node.js $\\ge 18$
    
*   Android Studio with Android SDK Platform 34/35 and NDK (27.1.12297006)
    
*   Physical Android device (microphone streaming and TFLite performance are best validated on hardware)
    

### Installation

1.  Bashcd mobile
    
2.  Bashnpm install
    
3.  Ensure the YAMNet model asset exists at assets/yamnet.tflite.
    

### Running Native Android Build

Because the project relies on C++ Nitro modules and TurboModules (react-native-fast-tflite, react-native-webview), compile directly with:

Bash

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   npx expo run:android   `

Start the Metro development server if not running automatically:

Bash

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   npx expo start -c   `

Configuration & Tuning
----------------------

*   **Distress Threshold:** Configured via DISTRESS\_CONFIDENCE\_THRESHOLD inside src/app/index.tsx (default: 0.35).
    
*   TypeScriptconst BACKEND\_URL = 'http://:8000/api/alerts';
    

Security & Privacy Notice
-------------------------

Audio recorded by the Guardian client is buffered strictly in volatile memory on-device for the duration of each evaluation window (~$0.975\\text{ s}$). Raw audio waveforms are never saved to disk or transmitted across network interfaces; only non-audio diagnostic event tags, confidence scores, and GPS coordinates are forwarded upon verified incident escalation.