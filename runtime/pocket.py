"""Private stdin/stdout bridge: JSON requests, base64 mono 24 kHz PCM responses."""
import base64
import json
import os
import sys

protocol = sys.stdout
sys.stdout = sys.stderr
setup = sys.argv[1:] == ["--download"]
if not setup:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    # The generation worker cannot connect to any network, even if a library
    # ignores offline flags. Setup downloads are a separate explicit command.
    import socket
    def offline(*args, **kwargs):
        raise RuntimeError("Network disabled during local generation")
    socket.socket.connect = offline
    socket.socket.connect_ex = offline
    socket.create_connection = offline

try:
    import numpy as np
    import torch
    from pocket_tts import TTSModel
    torch.set_num_threads(2)
    model = TTSModel.load_model()
    if model.sample_rate != 24000:
        raise RuntimeError("Unexpected sample rate")
    supported_voices = ("jane", "george", "alba", "marius")
    voices = {}
    if setup:
        for name in supported_voices:
            model.get_state_for_audio_prompt(name)
        print("Pocket TTS model and supported voices are ready.", file=protocol, flush=True)
        sys.exit(0)
    print(json.dumps({"ready": True}), file=protocol, flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        text, voice = request["text"], request["voice"]
        if voice not in supported_voices or not isinstance(text, str) or not 0 < len(text) <= 10000:
            raise RuntimeError("Invalid speech request")
        if voice not in voices:
            voices[voice] = model.get_state_for_audio_prompt(voice)
        audio = model.generate_audio(voices[voice], text).detach().cpu().numpy()
        if audio.ndim != 1 or not np.isfinite(audio).all() or not 0 < audio.size <= 24000 * 180:
            raise RuntimeError("Invalid generated audio")
        peak = float(np.max(np.abs(audio)))
        if peak < 0.000001:
            raise RuntimeError("Silent generated audio")
        # Preserve peaks before integer conversion instead of hard-clipping them.
        if peak > 0.98:
            audio = audio * (0.98 / peak)
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        print(json.dumps({"pcm": base64.b64encode(pcm).decode("ascii")}), file=protocol, flush=True)
except Exception:
    # Do not expose library errors that could contain dialogue or credentials.
    print(json.dumps({"error": "Pocket TTS failed. Run plancast setup-local and retry."}), file=protocol, flush=True)
    sys.exit(1)
