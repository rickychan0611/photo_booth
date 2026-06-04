# Kokoro TTS Setup

Use this on the photo booth computer to enable offline Kokoro host voice generation.

## 1. Install Python 3.12

Download Python 3.12 for Windows from:

https://www.python.org/downloads/

During install, check:

```text
Add python.exe to PATH
```

## 2. Create The Kokoro Folder

```powershell
mkdir G:\photo_booth\resources\tts\kokoro
cd G:\photo_booth\resources\tts\kokoro
```

## 3. Create A Python Virtual Environment

```powershell
py -3.12 -m venv .venv
```

## 4. Install Kokoro

```powershell
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install kokoro-tts
```

After this, Kokoro should exist here:

```text
G:\photo_booth\resources\tts\kokoro\.venv\Scripts\kokoro-tts.exe
```

## 5. Download Kokoro Model Files

Download these two files:

- https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
- https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

Put both files here:

```text
G:\photo_booth\resources\tts\kokoro\
```

The folder should contain:

```text
G:\photo_booth\resources\tts\kokoro\.venv\
G:\photo_booth\resources\tts\kokoro\kokoro-v1.0.onnx
G:\photo_booth\resources\tts\kokoro\voices-v1.0.bin
```

## 6. Test Kokoro Manually

```powershell
"Welcome! Press start to begin!" | Out-File -Encoding utf8 test.txt
.\.venv\Scripts\kokoro-tts.exe test.txt test.wav --voice af_heart --speed 1.08
```

If `test.wav` appears and plays, Kokoro is ready.

## 7. Use Kokoro In The App

Open the app admin panel:

```text
Admin -> Workflow
```

Use these settings:

```text
Audio enabled: On
Enable host voice: On
Voice engine: Kokoro
Voice name: af_heart
Speed: 1.08
Volume: 1
```

Then click:

```text
Generate all host lines
```

## Recommended Female Voices

Try these first for an energetic photo booth host:

```text
af_heart
af_sarah
af_bella
af_nova
af_sky
```

## Runtime Notes

- The app does not require internet at runtime.
- Kokoro generates cached WAV files under the event folder.
- The guest flow only plays local generated audio files during the event.
- Uploaded MP3 files still work as manual overrides for any cue.
