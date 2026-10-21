#!/usr/bin/env python3
"""OnePage Agent Remote host bridge.

Owned by the DSH plugin (spawned as a child process). It provides:
  - local Whisper ASR
  - a UDP 8767 discovery responder (device -> host)
  - /status and /send forwarding into the in-DSH plugin on loopback

The plugin picks the bridge port from 8765-8770 and passes it as argv[1];
the discovery reply always advertises the actual port, so the device never
hardcodes 8765.

Endpoints:
  GET  /api/v1/status
  POST /api/v1/send    {"text":"..."}
  POST /api/v1/voice   audio/wav  -> {"ok":true,"text":"..."}

Discovery:
  device -> 255.255.255.255:8767  {"type":"hello","id":"..."}
  bridge -> device               {"type":"host","host":"192.168.x.y","port":8765}
"""

import json
import os
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("ONEPAGE_MODEL_DIR", os.path.join(HERE, "models"))
MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
LANGUAGE = os.environ.get("WHISPER_LANG", "zh")
DSH_URL = os.environ.get("DSH_URL", "http://127.0.0.1:8766").rstrip("/")
DISCOVERY_PORT = int(os.environ.get("ONEPAGE_DISCOVERY_PORT", "8767"))

LAST_REPLY = "等待消息"
_MODEL = None
_MODEL_LOCK = threading.Lock()
_DEVICE_IPS = set()
_DEVICE_LOCK = threading.Lock()

try:
    from opencc import OpenCC

    _T2S = OpenCC("t2s")
except Exception:  # pragma: no cover - optional dependency
    _T2S = None


def get_lan_ip(peer: str | None = None) -> str:
    # Prefer the address this host uses to reach the device. The default route
    # can be a proxy/VPN interface (e.g. 198.18.0.1), which the device cannot use.
    if peer:
        try:
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.connect((peer, 80))
            ip = probe.getsockname()[0]
            probe.close()
            if not ip.startswith("127."):
                return ip
        except OSError:
            pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        ip = probe.getsockname()[0]
        probe.close()
        return ip
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return "127.0.0.1"


def discovery_loop() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("0.0.0.0", DISCOVERY_PORT))
    except OSError as exc:
        print(f"[discovery] cannot bind UDP {DISCOVERY_PORT}: {exc}", flush=True)
        return

    print(f"[discovery] listening on UDP {DISCOVERY_PORT}", flush=True)
    while True:
        try:
            data, addr = sock.recvfrom(512)
        except OSError:
            continue
        try:
            message = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if message.get("type") != "hello":
            continue
        with _DEVICE_LOCK:
            _DEVICE_IPS.add(addr[0])
        reply = {
            "type": "host",
            "host": get_lan_ip(addr[0]),
            "port": PORT,
        }
        try:
            sock.sendto(json.dumps(reply).encode("utf-8"), addr)
        except OSError:
            pass


def get_model():
    global _MODEL
    with _MODEL_LOCK:
        if _MODEL is None:
            from faster_whisper import WhisperModel

            print(f"[asr] loading Whisper {MODEL_NAME} ...", flush=True)
            _MODEL = WhisperModel(
                MODEL_NAME,
                device="cpu",
                compute_type="int8",
                download_root=MODEL_DIR,
            )
            print("[asr] model ready", flush=True)
        return _MODEL


def transcribe_wav(data: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        with wave.open(path, "rb") as w:
            print(
                f"[asr] {w.getnchannels()}ch {w.getframerate()}Hz "
                f"{w.getnframes() / max(1, w.getframerate()):.1f}s",
                flush=True,
            )
        model = get_model()
        segments, _ = model.transcribe(
            path,
            language=LANGUAGE,
            vad_filter=True,
            beam_size=1,
        )
        text = "".join(segment.text for segment in segments).strip()
        if _T2S is not None:
            text = _T2S.convert(text)
        return text
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def dsh_request(path: str, payload: dict | None = None, timeout: float = 5.0):
    """Call the plugin's loopback HTTP. Returns None only when it is unreachable.

    An HTTP error (409 no_agent, 500, ...) still carries a JSON body and must be
    returned as-is: treating it as "unreachable" is what previously made /send
    fall back to a fake mock success.
    """
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{DSH_URL}{path}", data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            return json.loads(exc.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, OSError):
            return None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None


def device_allowed(address: str) -> bool:
    if address in ("127.0.0.1", "::1"):
        return True
    with _DEVICE_LOCK:
        if not _DEVICE_IPS:
            # Bootstrap before the first HELLO: allow so a configured device can
            # still talk; after HELLO only that address set is accepted.
            return True
        return address in _DEVICE_IPS


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _guard(self) -> bool:
        if device_allowed(self.client_address[0]):
            return True
        self._send(403, {"ok": False, "error": "device_not_paired"})
        return False

    def do_GET(self):
        if not self._guard():
            return
        if self.path.split("?")[0] != "/api/v1/status":
            self._send(404, {"ok": False, "error": "not_found"})
            return
        dsh = dsh_request("/api/v1/status")
        if dsh is not None:
            reply = dsh.get("lastReply")
            if isinstance(reply, str):
                dsh["lastReply"] = " ".join(reply.split())[:80]
            self._send(200, dsh)
            return
        self._send(
            200,
            {
                "ok": True,
                "agent": "Mock",
                "repo": "onepage-hub",
                "state": "offline",
                "lastReply": "DSH 未连接（当前是 mock）",
            },
        )

    def do_POST(self):
        global LAST_REPLY
        if not self._guard():
            return
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2 * 1024 * 1024:
            self._send(413, {"ok": False, "error": "body_too_large"})
            return
        raw = self.rfile.read(length) if length else b""

        if path == "/api/v1/send":
            try:
                text = json.loads(raw.decode("utf-8")).get("text", "")
            except Exception:
                self._send(400, {"ok": False, "error": "bad_json"})
                return
            print(f"[bridge] received text: {text}", flush=True)

            dsh = dsh_request("/api/v1/send", {"text": text})
            if dsh is None:
                # Never fake a successful send when DSH is unreachable.
                self._send(503, {"ok": False, "error": "dsh_unavailable"})
                return
            LAST_REPLY = dsh.get("reply", "已发送到 DSH")
            print(f"[bridge] DSH reply: {dsh}", flush=True)
            self._send(200, dsh)
            return

        if path == "/api/v1/voice":
            print(f"[asr] received {len(raw)} bytes", flush=True)
            try:
                text = transcribe_wav(raw)
            except Exception as exc:
                print(f"[asr] failed: {exc}", flush=True)
                self._send(500, {"ok": False, "error": f"asr_failed: {exc}"})
                return
            print(f"[asr] text: {text}", flush=True)
            if not text:
                self._send(200, {"ok": False, "error": "empty_transcript"})
                return
            LAST_REPLY = f"你说: {text}"
            self._send(200, {"ok": True, "text": text})
            return

        self._send(404, {"ok": False, "error": "not_found"})

    def log_message(self, fmt, *args):
        print(f"[bridge] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    threading.Thread(target=discovery_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[bridge] HTTP listening on 0.0.0.0:{PORT}", flush=True)
    print(f"[bridge] ASR model={MODEL_NAME} lang={LANGUAGE} dir={MODEL_DIR}", flush=True)
    server.serve_forever()
