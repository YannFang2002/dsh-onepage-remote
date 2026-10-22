#!/usr/bin/env python3
"""Standalone transcription worker, executed by the *ASR venv's* Python.

The bridge runs under DSH's interpreter (3.12 here). Importing faster-whisper
from there would mix site-packages built for another Python version -- numpy and
ctranslate2 are compiled extensions and fail with ABI errors. So the heavy,
version-sensitive part lives in its own process and talks JSON over stdout.

Usage: python asr_runner.py <wav> <model> <model_dir> <lang>
"""

import json
import sys

# Steer the decoder: Whisper's zh output can come back as 繁体 even for Mandarin
# audio. A simplified-Chinese prompt biases the token stream toward 简体 at
# generation time, which is the real fix; OpenCC below is only a safety net for
# the cases the prompt does not catch.
PROMPT_ZH = "以下是普通话的句子，请使用简体中文输出。"

# Whisper's zh output follows whatever it heard: a Mandarin phrase with any
# traditional bias comes back as 繁体. The user wants 简体, and this venv already
# has OpenCC, so normalise here rather than on the device.
try:
    from opencc import OpenCC

    _T2S = OpenCC("t2s")
except Exception:  # noqa: BLE001 - absence just means "no conversion"
    _T2S = None


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage"}))
        return 2

    wav = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else "small"
    model_dir = sys.argv[3] if len(sys.argv) > 3 else ""
    lang = sys.argv[4] if len(sys.argv) > 4 else "zh"

    try:
        from faster_whisper import WhisperModel

        instance = WhisperModel(
            model,
            device="cpu",
            compute_type="int8",
            download_root=model_dir or None,
        )
        segments, _ = instance.transcribe(
            wav,
            language=lang or None,
            vad_filter=True,
            beam_size=1,
            initial_prompt=PROMPT_ZH if (lang or "").lower().startswith("zh") else None,
        )
        text = "".join(segment.text for segment in segments).strip()
        if _T2S is not None and text:
            text = _T2S.convert(text)
        print(json.dumps({"ok": True, "text": text}, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 - report the reason to the bridge
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
