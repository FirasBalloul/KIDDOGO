import numpy as np
import tensorflow as tf
import librosa
import csv

# 1. Load the class map
def load_class_map(csv_path):
    with open(csv_path, 'r') as f:
        reader = csv.reader(f)
        next(reader)  # Skip header
        return {int(row[0]): row[2] for row in reader}

class_map = load_class_map('yamnet_class_map.csv')

# 2. Load the TFLite Model
interpreter = tf.lite.Interpreter(model_path="yamnet.tflite")
interpreter.allocate_tensors()

input_details = interpreter.get_input_details()
output_details = interpreter.get_output_details()

# 3. Load and format the audio file
# YAMNet requires 16kHz mono audio as a 1D float32 array
audio_path = 'test_scream.wav'
wav_data, sr = librosa.load(audio_path, sr=16000, mono=True)

# 4. Run Inference
# The TFLite mobile version requires exactly 15,600 samples (0.975 seconds of audio)
input_data = np.array(wav_data[:15600], dtype=np.float32)
interpreter.set_tensor(input_details[0]['index'], input_data)
interpreter.invoke()

# 5. Get Results
scores = interpreter.get_tensor(output_details[0]['index'])[0]
top_5_indices = np.argsort(scores)[::-1][:5]

print("\n--- YAMNet Edge ML Results ---")
for i in top_5_indices:
    print(f"{class_map[i]}: {scores[i]:.3f}")