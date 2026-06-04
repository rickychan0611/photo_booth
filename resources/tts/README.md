Offline TTS engines live here for packaged Electron builds.

Expected layout:

resources/tts/kokoro/kokoro-tts.exe
resources/tts/kokoro/.venv/Scripts/kokoro-tts.exe
resources/tts/kokoro/kokoro-v1.0.onnx
resources/tts/kokoro/voices-v1.0.bin

resources/tts/piper/piper.exe
resources/tts/piper/voices/en_US-lessac-medium.onnx
resources/tts/piper/voices/en_US-lessac-medium.onnx.json

At runtime, the app also checks the event folder first:

{eventFolder}/audio/tts/kokoro/kokoro-tts.exe
{eventFolder}/audio/tts/kokoro/models/...
{eventFolder}/audio/tts/piper/piper.exe
{eventFolder}/audio/tts/piper/voices/...
