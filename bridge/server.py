#!/usr/bin/env python3
"""ONEPAGE-HUB host bridge.

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
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid
from collections import deque
from datetime import datetime
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("ONEPAGE_MODEL_DIR", os.path.join(HERE, "models"))
MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
LANGUAGE = os.environ.get("WHISPER_LANG", "zh")
DSH_URL = os.environ.get("DSH_URL", "http://127.0.0.1:8766").rstrip("/")
DISCOVERY_PORT = int(os.environ.get("ONEPAGE_DISCOVERY_PORT", "8767"))
# Wire tag for every discovery packet. Anything else on UDP 8767 hears a
# distinctive string instead of a bare {"type":"hello"}.
PROTOCOL = "ONEPAGE-HUB"
# A device counts as online only while it keeps talking to us: the app sends a
# heartbeat every 20 s, and deep sleep / leaving the app drops the WiFi link.
# Without this the UI showed a stale address as "online" forever.
DEVICE_TTL_SEC = 60

LAST_REPLY = "等待消息"
_MODEL = None_MODEL_LOCK = threading.Lock()
_DEVICE_IPS = set()
_DEVICE_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# Host-side observability
#
# The device is the only client, so before this existed there was nothing on the
# host that told you whether the bridge was even reachable, which device had
# paired, or what the last ASR actually heard. Everything the dashboard shows is
# derived from these fields, which are updated in the request handlers below.
# ---------------------------------------------------------------------------
STARTED_AT = time.time()
EVENTS = deque(maxlen=120)
STATE = {
    "device_ip": None,
    "last_hello_at": None,
    "last_seen_ts": None,
    "last_asr_ms": None,
    "last_error": None,
    "last_text": None,
    "last_reply": None,
    "last_voice_bytes": None,
    "last_voice_seconds": None,
    "last_voice_text": None,
    "counts": {"hello": 0, "scan": 0, "status": 0, "send": 0, "voice": 0, "error": 0},
}
STATE_LOCK = threading.Lock()


def now_hms() -> str:
    return datetime.now().strftime("%H:%M:%S")


def log_event(kind: str, message: str) -> None:
    """Record one dashboard event and echo it to the bridge log."""
    with STATE_LOCK:
        EVENTS.appendleft({"at": now_hms(), "kind": kind, "message": message})
    print(f"[{kind}] {message}", flush=True)


def bump(key: str) -> None:
    with STATE_LOCK:
        STATE["counts"][key] = STATE["counts"].get(key, 0) + 1


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


def display_lan_ip() -> str:
    """An address the device can actually reach.

    get_lan_ip() follows the default route, which on some machines points at a
    proxy/VPN adapter in 198.18.0.0/15 -- useless for the device, and confusing
    on the dashboard before the device has announced itself. Prefer a real
    private-range address when we do not yet know the peer.
    """
    with STATE_LOCK:
        peer = STATE["device_ip"]
    if peer:
        return get_lan_ip(peer)
    try:
        candidates = [info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)]
    except OSError:
        candidates = []
    for ip in candidates:
        if ip.startswith("192.168.") or ip.startswith("10."):
            return ip
        if ip.startswith("172."):
            try:
                if 16 <= int(ip.split(".")[1]) <= 31:
                    return ip
            except (IndexError, ValueError):
                pass
    return get_lan_ip()


def candidate_ips(primary: str) -> list[str]:
    """All private IPv4 addresses of this host, `primary` first.

    A multi-homed host (phone hotspot + company LAN + VPN) can only guess which
    address the device can reach; the device gets the whole list and tries them
    until one answers.
    """
    found = [primary] if primary else []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip in found or ip.startswith(("127.", "169.254.")):
                continue
            if ip.startswith(("192.168.", "10.")):
                found.append(ip)
            elif ip.startswith("172."):
                try:
                    if 16 <= int(ip.split(".")[1]) <= 31:
                        found.append(ip)
                except (IndexError, ValueError):
                    pass
    except OSError:
        pass
    return found


def discovery_loop() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    # Windows: SO_REUSEADDR lets several sockets bind 8767 at once, and a stale
    # bridge then steals HELLO packets from the live one -- the device is told a
    # port nobody serves. Ask for exclusive binding so a second instance fails
    # loudly instead. POSIX needs the flag for a clean restart.
    if os.name != "nt":
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("0.0.0.0", DISCOVERY_PORT))
    except OSError as exc:
        log_event("error", f"UDP {DISCOVERY_PORT} 已被占用，设备发现不可用：{exc}")
        print(f"[discovery] cannot bind UDP {DISCOVERY_PORT}: {exc}", flush=True)
        return

    log_event("discovery", f"UDP {DISCOVERY_PORT} 已监听，等待设备 HELLO")
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
        if message.get("protocol") not in (None, PROTOCOL):
            continue  # some other service on UDP 8767
        if message.get("type") != "hello":
            continue
        answer_host = get_lan_ip(addr[0])
        mark_device(addr[0], "HELLO")
        log_event("discovery", f"→ 分配 {answer_host}:{PORT}")
        reply = {
            "type": "host",
            "host": answer_host,
            "port": PORT,
            "hosts": candidate_ips(primary=answer_host),
        }
        try:
            sock.sendto(json.dumps(reply).encode("utf-8"), addr)
        except OSError:
            pass


def local_ipv4s() -> list:
    """Private IPv4 addresses of this host (hotspot / LAN / VPN excluded-ish)."""
    ips = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip in ips or ip.startswith(("127.", "169.254.")):
                continue
            if ip.startswith(("192.168.", "10.")):
                ips.append(ip)
            elif ip.startswith("172."):
                try:
                    if 16 <= int(ip.split(".")[1]) <= 31:
                        ips.append(ip)
                except (IndexError, ValueError):
                    pass
    except OSError:
        pass
    return ips


def mark_device(ip: str, source: str) -> None:
    """Record a device address discovered by either direction."""
    with _DEVICE_LOCK:
        _DEVICE_IPS.add(ip)
    with STATE_LOCK:
        STATE["device_ip"] = ip
        STATE["last_hello_at"] = now_hms()
        STATE["last_seen_ts"] = time.time()
    bump("hello" if source == "hello" else "scan")
    log_event("discovery", f"{source} 发现设备 ONEPAGE-HUB @ {ip}")


def scan_loop() -> None:
    """Host-initiated discovery.

    Until this existed the device had to broadcast first; if its broadcast was
    filtered (firewall, AP isolation, VLAN) nothing ever happened and the user
    was told to type an address. Here the host probes each of its subnets and
    carries its own address in the probe, so the device can answer and adopt it.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind(("0.0.0.0", 0))
    sock.settimeout(0.4)
    announced = False

    while True:
        with STATE_LOCK:
            seen_ts = STATE["last_seen_ts"]
        # Stop probing while a device is actively talking to us.
        if seen_ts is not None and time.time() - seen_ts < 45:
            time.sleep(5)
            continue

        if not announced:
            announced = True
            log_event("discovery", f"主动扫描中（协议 {PROTOCOL}，UDP {DISCOVERY_PORT}）")

        for ip in local_ipv4s():
            parts = ip.split(".")
            target = ".".join(parts[:3] + ["255"])
            probe = json.dumps(
                {"type": "onepage-scan", "protocol": PROTOCOL, "host": ip, "port": PORT}
            ).encode("utf-8")
            try:
                sock.sendto(probe, (target, DISCOVERY_PORT))
            except OSError:
                pass

        deadline = time.time() + 1.2
        while time.time() < deadline:
            try:
                data, addr = sock.recvfrom(512)
            except socket.timeout:
                break
            except OSError:
                break
            try:
                message = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if message.get("protocol") not in (None, PROTOCOL):
                continue
            if message.get("type") != "onepage-hub":
                continue
            mark_device(addr[0], "scan")

        time.sleep(2)


ASR_CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".onepage-agent", "asr.json")

# Two very different ASR costs live behind the same device endpoint:
#   local -> faster-whisper on this CPU. No key, no audio leaves the machine,
#            but the first run downloads a model and every request burns CPU.
#   api   -> an OpenAI-compatible /audio/transcriptions endpoint. No model
#            download, much faster on weak CPUs, but the audio leaves the
#            machine and needs a key.
# "auto" picks api only when a key is configured; otherwise local.
ASR_DEFAULTS = {
    "backend": os.environ.get("ONEPAGE_ASR", "auto"),
    "lang": LANGUAGE,
    "local_model": MODEL_NAME,
    "api_base": os.environ.get("ONEPAGE_ASR_API_BASE", "https://api.openai.com/v1"),
    "api_key": os.environ.get("ONEPAGE_ASR_API_KEY", ""),
    "api_model": os.environ.get("ONEPAGE_ASR_MODEL", "whisper-1"),
    # Where the local stack lives. Both are editable from the UI so the ~600 MB
    # of venv + model can go on another drive instead of the system disk.
    "venv_path": os.environ.get("ONEPAGE_ASR_VENV", os.path.join(os.path.expanduser("~"), ".onepage-agent", "venv")),
    "model_dir": os.environ.get("ONEPAGE_ASR_MODEL_DIR", MODEL_DIR),
}


def load_asr_config() -> dict:
    """Saved settings in ~/.onepage-agent/asr.json, overridden by env vars."""
    config = dict(ASR_DEFAULTS)
    try:
        with open(ASR_CONFIG_PATH, "r", encoding="utf-8") as handle:
            saved = json.load(handle)
        if isinstance(saved, dict):
            for key in config:
                if isinstance(saved.get(key), str):
                    config[key] = saved[key]
    except (OSError, json.JSONDecodeError):
        pass
    # Env vars are an explicit per-run override, so they win over the file.
    overrides = {
        "backend": os.environ.get("ONEPAGE_ASR"),
        "lang": os.environ.get("WHISPER_LANG"),
        "local_model": os.environ.get("WHISPER_MODEL"),
        "api_base": os.environ.get("ONEPAGE_ASR_API_BASE"),
        "api_key": os.environ.get("ONEPAGE_ASR_API_KEY"),
        "api_model": os.environ.get("ONEPAGE_ASR_MODEL"),
        "venv_path": os.environ.get("ONEPAGE_ASR_VENV"),
        "model_dir": os.environ.get("ONEPAGE_ASR_MODEL_DIR"),
    }
    for key, value in overrides.items():
        if value:
            config[key] = value
    if config["backend"] not in ("auto", "local", "api"):
        config["backend"] = "auto"
    return config


ASR = load_asr_config()
ASR_LOCK = threading.Lock()


def save_asr_config(patch: dict) -> dict:
    with ASR_LOCK:
        for key, value in patch.items():
            if key in ASR_DEFAULTS and isinstance(value, str):
                ASR[key] = value
        if ASR["backend"] not in ("auto", "local", "api"):
            ASR["backend"] = "auto"
        snapshot = dict(ASR)
    try:
        os.makedirs(os.path.dirname(ASR_CONFIG_PATH), exist_ok=True)
        with open(ASR_CONFIG_PATH, "w", encoding="utf-8") as handle:
            json.dump(snapshot, handle, ensure_ascii=False, indent=2)
    except OSError as exc:
        log_event("error", f"ASR 配置保存失败：{exc}")
    return snapshot


def effective_backend() -> str:
    with ASR_LOCK:
        chosen = ASR["backend"]
        has_key = bool(ASR["api_key"].strip())
    if chosen in ("local", "api"):
        return chosen
    return "api" if has_key else "local"


def venv_python(venv_path: str) -> str:
    if os.name == "nt":
        return os.path.join(venv_path, "Scripts", "python.exe")
    return os.path.join(venv_path, "bin", "python")


def venv_site(venv_path: str) -> str:
    if os.name == "nt":
        return os.path.join(venv_path, "Lib", "site-packages")
    return os.path.join(venv_path, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages")


def ensure_site_on_path(venv_path: str) -> None:
    site = venv_site(venv_path)
    if os.path.isdir(site) and site not in sys.path:
        sys.path.insert(0, site)


def local_asr_ready() -> bool:
    """Ready means the configured venv actually carries faster_whisper."""
    with ASR_LOCK:
        venv_path = ASR["venv_path"]
    site = venv_site(venv_path)
    if not os.path.isdir(os.path.join(site, "faster_whisper")):
        return False
    ensure_site_on_path(venv_path)
    try:
        import importlib.util

        return importlib.util.find_spec("faster_whisper") is not None
    except (ImportError, ValueError):
        return False


def model_present() -> bool:
    with ASR_LOCK:
        model_dir = ASR["model_dir"]
        name = ASR["local_model"]
    try:
        entries = os.listdir(model_dir)
    except OSError:
        return False
    for entry in entries:
        if entry == name or (entry.startswith("models--") and name in entry):
            return True
    return False


# --- local ASR installation -------------------------------------------------
#
# Installing is a multi-minute, ~600 MB operation (venv + ctranslate2 + model),
# so it must never run inside a request. It runs on a worker thread and the UI
# polls `install` in the diag payload for stage/progress.
INSTALL = {
    "state": "idle",  # idle | running | done | error
    "stage": "",
    "progress": 0,
    "message": "",
    "log": deque(maxlen=30),
    "started_at": None,
    "finished_at": None,
}
INSTALL_LOCK = threading.Lock()


def install_snapshot() -> dict:
    with INSTALL_LOCK:
        return {
            "state": INSTALL["state"],
            "stage": INSTALL["stage"],
            "progress": INSTALL["progress"],
            "message": INSTALL["message"],
            "log": list(INSTALL["log"]),
            "started_at": INSTALL["started_at"],
            "finished_at": INSTALL["finished_at"],
        }


def set_install(**kwargs) -> None:
    with INSTALL_LOCK:
        INSTALL.update(kwargs)


def append_install_log(line: str) -> None:
    with INSTALL_LOCK:
        INSTALL["log"].append(line.rstrip())


def _run_step(cmd) -> int:
    append_install_log("$ " + " ".join(cmd))
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.stdout is not None:
        for line in proc.stdout:
            append_install_log(line)
    return proc.wait()


def install_worker(venv_path: str, model_dir: str, model_name: str) -> None:
    global _MODEL
    try:
        os.makedirs(os.path.dirname(venv_path) or ".", exist_ok=True)
        os.makedirs(model_dir, exist_ok=True)

        if not os.path.exists(venv_python(venv_path)):
            set_install(stage="创建虚拟环境", progress=8, message=venv_path)
            if _run_step([sys.executable, "-m", "venv", venv_path]) != 0:
                raise RuntimeError("虚拟环境创建失败")
        else:
            append_install_log(f"复用已有虚拟环境: {venv_path}")

        py = venv_python(venv_path)
        set_install(stage="安装 faster-whisper（约 100 MB）", progress=25)
        _run_step([py, "-m", "pip", "install", "--upgrade", "pip"])
        code = _run_step(
            [py, "-m", "pip", "install", "--upgrade", "faster-whisper", "av==12.3.0", "opencc-python-reimplemented"]
        )
        if code != 0:
            raise RuntimeError(f"pip 安装失败（exit {code}）")

        set_install(stage=f"下载模型 {model_name}（约 480 MB）", progress=60)
        ensure_site_on_path(venv_path)
        preload = (
            "import sys;"
            f"sys.path.insert(0, {venv_site(venv_path)!r});"
            "from faster_whisper import WhisperModel;"
            f"WhisperModel({model_name!r}, device='cpu', compute_type='int8', download_root={model_dir!r});"
            "print('MODEL_READY')"
        )
        if _run_step([py, "-c", preload]) != 0:
            raise RuntimeError("模型下载失败")

        set_install(state="done", stage="完成", progress=100, message="本地识别已就绪", finished_at=now_hms())
        log_event("asr", f"本地 ASR 安装完成：{venv_path}")
        _MODEL = None
    except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
        set_install(state="error", stage="失败", message=str(exc), finished_at=now_hms())
        log_event("error", f"本地 ASR 安装失败：{exc}")


def start_install(venv_path: str, model_dir: str, model_name: str) -> bool:
    with INSTALL_LOCK:
        if INSTALL["state"] == "running":
            return False
        INSTALL.update(
            state="running",
            stage="准备",
            progress=5,
            message="",
            log=deque(maxlen=30),
            started_at=now_hms(),
            finished_at=None,
        )
    threading.Thread(target=install_worker, args=(venv_path, model_dir, model_name), daemon=True).start()
    return True


def asr_summary() -> dict:
    with ASR_LOCK:
        snapshot = dict(ASR)
    return {
        "effective": effective_backend(),
        "mode": snapshot["backend"],
        "lang": snapshot["lang"],
        "local_model": snapshot["local_model"],
        "local_installed": local_asr_ready(),
        "model_present": model_present(),
        "venv_path": snapshot["venv_path"],
        "model_dir": snapshot["model_dir"],
        "api_base": snapshot["api_base"],
        "api_model": snapshot["api_model"],
        "api_key_set": bool(snapshot["api_key"].strip()),
        "config_path": ASR_CONFIG_PATH,
        "install": install_snapshot(),
    }


def get_model():
    global _MODEL
    with _MODEL_LOCK:
        if _MODEL is None:
            with ASR_LOCK:
                model_name = ASR["local_model"]
                model_dir = ASR["model_dir"]
                venv_path = ASR["venv_path"]
            # A venv installed from the UI is not on this interpreter's path yet.
            ensure_site_on_path(venv_path)
            from faster_whisper import WhisperModel

            print(f"[asr] loading Whisper {model_name} from {model_dir} ...", flush=True)
            _MODEL = WhisperModel(
                model_name,
                device="cpu",
                compute_type="int8",
                download_root=model_dir,
            )
            print("[asr] model ready", flush=True)
        return _MODEL


def _transcribe_local(data: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        handle.write(data)
        path = handle.name
    try:
        with wave.open(path, "rb") as wav:
            print(
                f"[asr] {wav.getnchannels()}ch {wav.getframerate()}Hz "
                f"{wav.getnframes() / max(1, wav.getframerate()):.1f}s",
                flush=True,
            )
        model = get_model()
        with ASR_LOCK:
            lang = ASR["lang"]
        segments, _ = model.transcribe(
            path,
            language=lang,
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


def _transcribe_api(data: bytes) -> str:
    with ASR_LOCK:
        base = ASR["api_base"].rstrip("/")
        key = ASR["api_key"].strip()
        model = ASR["api_model"]
        lang = ASR["lang"]
    if not key:
        raise RuntimeError("api_key_missing")

    boundary = "----onepage" + uuid.uuid4().hex
    fields = {"model": model, "response_format": "json", "language": lang}
    body = bytearray()
    for name, value in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode(
            "utf-8"
        )
    body += (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8")
    body += data
    body += f"\r\n--{boundary}--\r\n".encode("utf-8")

    request = urllib.request.Request(
        f"{base}/audio/transcriptions",
        data=bytes(body),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"asr_http_{exc.code}: {detail}") from exc
    text = str(payload.get("text", "")).strip()
    if _T2S is not None:
        text = _T2S.convert(text)
    return text


def transcribe_wav(data: bytes) -> str:
    if effective_backend() == "api":
        return _transcribe_api(data)
    return _transcribe_local(data)


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


def diag_snapshot() -> dict:
    """Everything the dashboard renders, in one poll."""
    dsh = dsh_request("/api/v1/status", timeout=0.8)
    with STATE_LOCK:
        counts = dict(STATE["counts"])
        device_ip = STATE["device_ip"]
        last_hello_at = STATE["last_hello_at"]
        last_seen_ts = STATE["last_seen_ts"]
        last = {
            "text": STATE["last_text"],
            "reply": STATE["last_reply"],
            "voice_bytes": STATE["last_voice_bytes"],
            "voice_seconds": STATE["last_voice_seconds"],
            "voice_text": STATE["last_voice_text"],
            "asr_ms": STATE["last_asr_ms"],
            "error": STATE["last_error"],
        }
        events = list(EVENTS)
    with _DEVICE_LOCK:
        paired = sorted(_DEVICE_IPS)
    return {
        "ok": True,
        "service": {
            "port": PORT,
            "uptime_sec": int(time.time() - STARTED_AT),
            "lan_ip": display_lan_ip(),
            "model": MODEL_NAME,
            "lang": LANGUAGE,
            "dsh_url": DSH_URL,
            "discovery_port": DISCOVERY_PORT,
        },
        "device": {
            "ip": device_ip,
            "last_hello_at": last_hello_at,
            "paired": paired,
            "online": last_seen_ts is not None and (time.time() - last_seen_ts) < DEVICE_TTL_SEC,
            "last_seen_ago": None if last_seen_ts is None else int(time.time() - last_seen_ts),
            "ttl_sec": DEVICE_TTL_SEC,
        },
        "dsh": {
            "reachable": dsh is not None,
            "agent": (dsh or {}).get("agent"),
            "repo": (dsh or {}).get("repo"),
            "state": (dsh or {}).get("state"),
            "error": (dsh or {}).get("error"),
        },
        "last": last,
        "counts": counts,
        "events": events,
        "asr": asr_summary(),
    }


DASHBOARD_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ONEPAGE-HUB · 主机状态</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font: 14px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    background: #f5f6f8; color: #1d2129;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #86909c; font-size: 12px; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 14px; }
  .card { background: #fff; border: 1px solid #e5e6eb; border-radius: 10px; padding: 14px 16px; }
  .card .k { color: #86909c; font-size: 12px; margin-bottom: 6px; }
  .card .v { font-size: 17px; font-weight: 600; word-break: break-all; }
  .card .n { color: #86909c; font-size: 12px; margin-top: 4px; }
  .ok { color: #00b42a; } .bad { color: #f53f3f; } .idle { color: #ff7d00; }
  section { background: #fff; border: 1px solid #e5e6eb; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  section h2 { font-size: 13px; margin: 0 0 10px; color: #4e5969; font-weight: 600; }
  .row { display: flex; gap: 10px; padding: 5px 0; border-bottom: 1px dashed #f2f3f5; }
  .row:last-child { border-bottom: 0; }
  .time { color: #c9cdd4; font-variant-numeric: tabular-nums; width: 62px; flex: none; }
  .tag { flex: none; width: 76px; font-size: 12px; }
  .tag.discovery { color: #722ed1; } .tag.voice { color: #0e7a8c; }
  .tag.send { color: #1677ff; } .tag.error { color: #f53f3f; } .tag.service { color: #86909c; }
  .msg { flex: 1; word-break: break-word; }
  .empty { color: #c9cdd4; }
  textarea { width: 100%; min-height: 62px; padding: 8px 10px; border: 1px solid #e5e6eb; border-radius: 8px; font: inherit; resize: vertical; }
  button { margin-top: 8px; padding: 8px 16px; border: 0; border-radius: 8px; background: #1677ff; color: #fff; font: inherit; cursor: pointer; }
  button:disabled { background: #a9c9ff; cursor: default; }
  code { background: #f2f3f5; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  #out { margin-top: 8px; color: #4e5969; font-size: 13px; white-space: pre-wrap; }
  .asrform { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; align-items: end; }
  .asrform label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #86909c; }
  .asrform input, .asrform select { padding: 7px 9px; border: 1px solid #e5e6eb; border-radius: 8px; font: inherit; color: #1d2129; background: #fff; }
  .asrform button { grid-column: 1 / -1; justify-self: start; }
  #asr-out { grid-column: 1 / -1; color: #4e5969; font-size: 13px; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>ONEPAGE-HUB · 主机状态</h1>
<div class="sub">每 1.5 秒自动刷新 · 本页面只监听本机回环地址</div>

<div class="grid">
  <div class="card"><div class="k">服务</div><div class="v" id="svc">…</div><div class="n" id="svc2"></div></div>
  <div class="card"><div class="k">设备</div><div class="v" id="dev">…</div><div class="n" id="dev2"></div></div>
  <div class="card"><div class="k">DSH 连接</div><div class="v" id="dsh">…</div><div class="n" id="dsh2"></div></div>
  <div class="card"><div class="k">最近识别</div><div class="v" id="asr">…</div><div class="n" id="asr2"></div></div>
  <div class="card"><div class="k">ASR 后端</div><div class="v" id="asrmode">…</div><div class="n" id="asrmode2"></div></div>
</div>

<section>
  <h2>语音识别（ASR）</h2>
  <div class="row"><div class="msg" id="asrline">…</div></div>
  <div class="asrform">
    <label>后端
      <select id="asr-mode">
        <option value="auto">自动（有 Key 走 API，否则本地）</option>
        <option value="local">本地 faster-whisper</option>
        <option value="api">厂商 API（OpenAI 兼容）</option>
      </select>
    </label>
    <label>API 地址 <input id="asr-base" placeholder="https://api.openai.com/v1"></label>
    <label>API Key <input id="asr-key" type="password" placeholder="留空则保持原值"></label>
    <label>API 模型 <input id="asr-model" placeholder="whisper-1"></label>
    <label>语言 <input id="asr-lang" placeholder="zh"></label>
    <button id="asr-save">保存</button>
    <div id="asr-out"></div>
  </div>
</section>

<section>
  <h2>最近一次语音 / 消息</h2>
  <div class="row"><div class="msg" id="voice">尚无语音</div></div>
  <div class="row"><div class="msg" id="text">尚无发送</div></div>
</section>

<section>
  <h2>活动时间线</h2>
  <div id="events" class="empty">尚无事件</div>
</section>

<section>
  <h2>发送测试文本到 DSH</h2>
  <textarea id="payload">来自 ONEPAGE-HUB 主机状态面板的连通性测试</textarea>
  <button id="send">发送</button>
  <div id="out"></div>
</section>

<script>
const fmtUptime = (s) => {
  if (s == null) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ' 小时 ' : '') + (h || m ? m + ' 分 ' : '') + sec + ' 秒';
};
let asrInit = false;

async function refresh() {
  let d;
  try {
    const r = await fetch('/api/v1/diag', { cache: 'no-store' });
    d = await r.json();
  } catch (e) {
    document.getElementById('svc').innerHTML = '<span class="bad">桥已停止</span>';
    document.getElementById('svc2').textContent = '请重启 DSH 或重新运行 bridge/server.py';
    return;
  }
  if (!d || !d.ok) return;

  const svc = d.service;
  document.getElementById('svc').innerHTML = '<span class="ok">运行中</span>';
  document.getElementById('svc2').textContent =
    '端口 ' + svc.port + ' · 已运行 ' + fmtUptime(svc.uptime_sec);

  document.getElementById('dev').innerHTML = d.device.ip
    ? '<span class="ok">' + d.device.ip + '</span>'
    : '<span class="idle">等待设备</span>';
  document.getElementById('dev2').textContent = d.device.ip
    ? '最后 HELLO ' + (d.device.last_hello_at || '—') + ' · 配对 ' + d.device.paired.length + ' 台'
    : '在设备上进入「Agent 遥控」即可自动发现';

  if (d.dsh.reachable) {
    document.getElementById('dsh').innerHTML = '<span class="ok">已连接</span>';
    document.getElementById('dsh2').textContent =
      [d.dsh.agent, d.dsh.repo, d.dsh.state].filter(Boolean).join(' · ') || '—';
  } else {
    document.getElementById('dsh').innerHTML = '<span class="bad">未连接</span>';
    document.getElementById('dsh2').textContent = d.dsh.error || '插件未运行或未装配到桌面端';
  }

  if (d.last.voice_text) {
    document.getElementById('asr').textContent = d.last.asr_ms != null ? d.last.asr_ms + ' ms' : '已识别';
    document.getElementById('asr2').textContent =
      (d.last.voice_bytes ? (d.last.voice_bytes / 1024).toFixed(0) + ' KB' : '') +
      (d.last.voice_seconds ? ' · ' + d.last.voice_seconds.toFixed(1) + ' s' : '');
  } else {
    document.getElementById('asr').innerHTML = '<span class="idle">尚无</span>';
    document.getElementById('asr2').textContent = '按住设备的确认键说话';
  }

  const a = d.asr;
  document.getElementById('asrmode').textContent = a.effective === 'api' ? '厂商 API' : '本地 Whisper';
  document.getElementById('asrmode2').textContent = a.effective === 'api'
    ? (a.api_model + ' · ' + (a.api_key_set ? 'Key 已设置' : '缺少 Key'))
    : (a.local_installed ? 'faster-whisper 已安装' : '未安装 faster-whisper');
  document.getElementById('asrline').textContent =
    '模式 ' + a.mode + ' · 语言 ' + a.lang +
    ' · 本地模型 ' + a.local_model + (a.local_installed ? '' : '（未安装）') +
    ' · API ' + a.api_base + (a.api_key_set ? '（Key 已设置）' : '（无 Key）') +
    ' · 配置 ' + a.config_path;
  if (!asrInit) {
    asrInit = true;
    document.getElementById('asr-mode').value = a.mode;
    document.getElementById('asr-base').value = a.api_base;
    document.getElementById('asr-model').value = a.api_model;
    document.getElementById('asr-lang').value = a.lang;
  }

  document.getElementById('voice').textContent = d.last.voice_text
    ? '识别：' + d.last.voice_text
    : '尚无语音';
  document.getElementById('text').textContent = d.last.text
    ? '发送：' + d.last.text + (d.last.reply ? '  →  ' + d.last.reply : '')
    : (d.last.error ? '错误：' + d.last.error : '尚无发送');

  const box = document.getElementById('events');
  if (!d.events.length) { box.className = 'empty'; box.textContent = '尚无事件'; return; }
  box.className = '';
  box.innerHTML = d.events.map((e) =>
    '<div class="row"><div class="time">' + e.at + '</div>' +
    '<div class="tag ' + e.kind + '">' + e.kind + '</div>' +
    '<div class="msg">' + e.message.replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</div></div>'
  ).join('');
}

document.getElementById('asr-save').addEventListener('click', async () => {
  const out = document.getElementById('asr-out');
  out.textContent = '保存中…';
  const payload = {
    backend: document.getElementById('asr-mode').value,
    api_base: document.getElementById('asr-base').value.trim(),
    api_model: document.getElementById('asr-model').value.trim(),
    lang: document.getElementById('asr-lang').value.trim(),
  };
  const key = document.getElementById('asr-key').value.trim();
  if (key) payload.api_key = key;  // empty field keeps the stored key
  try {
    const r = await fetch('/api/v1/asr-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    out.textContent = j.ok ? ('已保存，当前生效：' + j.asr.effective) : ('失败：' + j.error);
    if (j.ok) document.getElementById('asr-key').value = '';
  } catch (e) {
    out.textContent = '失败：' + e;
  }
  refresh();
});

document.getElementById('send').addEventListener('click', async () => {
  const btn = document.getElementById('send');
  const out = document.getElementById('out');
  btn.disabled = true;
  out.textContent = '发送中…';
  try {
    const r = await fetch('/api/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: document.getElementById('payload').value }),
    });
    const j = await r.json();
    out.textContent = j.ok ? ('已发送：' + (j.reply || 'OK')) : ('失败：' + (j.error || r.status));
  } catch (e) {
    out.textContent = '失败：' + e;
  }
  btn.disabled = false;
  refresh();
});

refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, status, html):
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_loopback(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1")

    def _guard(self) -> bool:
        if device_allowed(self.client_address[0]):
            # Any real request from the device proves it is awake and connected.
            if not self._is_loopback():
                with STATE_LOCK:
                    STATE["last_seen_ts"] = time.time()
            return True
        self._send(403, {"ok": False, "error": "device_not_paired"})
        return False

    def do_GET(self):
        path = self.path.split("?")[0]
        # The dashboard is for the human at this machine, not for the device or
        # anything else on the LAN: it shows transcribed speech.
        if path in ("/", "/dashboard"):
            if not self._is_loopback():
                self._send(403, {"ok": False, "error": "dashboard_loopback_only"})
                return
            self._send_html(200, DASHBOARD_HTML)
            return
        if path == "/api/v1/diag":
            if not self._is_loopback():
                self._send(403, {"ok": False, "error": "dashboard_loopback_only"})
                return
            self._send(200, diag_snapshot())
            return

        if not self._guard():
            return
        if path == "/api/v1/heartbeat":
            self._send(200, {"ok": True, "protocol": PROTOCOL})
            return
        if path != "/api/v1/status":
            self._send(404, {"ok": False, "error": "not_found"})
            return
        bump("status")
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

    def _record_error(self, title, detail):
        with STATE_LOCK:
            STATE["last_error"] = f"{title} · {detail}"
        bump("error")
        log_event("error", f"{title}（{detail}）")

    def do_POST(self):
        global LAST_REPLY
        path = self.path.split("?")[0]

        # ASR backend switching is a local-admin action: loopback clients only,
        # never the device or anything else on the LAN.
        if path == "/api/v1/asr-config":
            if not self._is_loopback():
                self._send(403, {"ok": False, "error": "dashboard_loopback_only"})
                return
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                patch = json.loads(raw.decode("utf-8") or "{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send(400, {"ok": False, "error": "bad_json"})
                return
            if not isinstance(patch, dict):
                self._send(400, {"ok": False, "error": "bad_json"})
                return
            saved = save_asr_config(patch)
            log_event(
                "asr",
                f"ASR 后端已设为 {saved['backend']}（实际使用 {effective_backend()}）",
            )
            self._send(200, {"ok": True, "asr": asr_summary()})
            return

        # One-click local ASR install. Body may carry venv_path / model_dir /
        # local_model so the ~600 MB can be placed on another drive; the work
        # itself happens on a worker thread and is polled via diag.asr.install.
        if path == "/api/v1/asr-install":
            if not self._is_loopback():
                self._send(403, {"ok": False, "error": "dashboard_loopback_only"})
                return
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send(400, {"ok": False, "error": "bad_json"})
                return
            if isinstance(body, dict) and body:
                save_asr_config({k: v for k, v in body.items() if isinstance(v, str)})
            with ASR_LOCK:
                venv_path = ASR["venv_path"]
                model_dir = ASR["model_dir"]
                model_name = ASR["local_model"]
            started = start_install(venv_path, model_dir, model_name)
            log_event("asr", f"开始安装本地 ASR（{model_name}）→ {venv_path}")
            self._send(
                200,
                {"ok": True, "started": started, "install": install_snapshot(), "asr": asr_summary()},
            )
            return

        if not self._guard():
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2 * 1024 * 1024:
            self._record_error("请求体过大", f"body_too_large {length} bytes")
            self._send(413, {"ok": False, "error": "body_too_large"})
            return
        raw = self.rfile.read(length) if length else b""

        if path == "/api/v1/send":
            try:
                text = json.loads(raw.decode("utf-8")).get("text", "")
            except Exception:
                self._record_error("发送内容不是合法 JSON", "bad_json")
                self._send(400, {"ok": False, "error": "bad_json"})
                return
            bump("send")
            with STATE_LOCK:
                STATE["last_text"] = text[:200]
            log_event("send", f"收到设备文本：{text[:60]}")

            dsh = dsh_request("/api/v1/send", {"text": text})
            if dsh is None:
                # Never fake a successful send when DSH is unreachable.
                self._record_error("DSH 不可达", "dsh_unavailable")
                self._send(503, {"ok": False, "error": "dsh_unavailable"})
                return
            LAST_REPLY = dsh.get("reply", "已发送到 DSH")
            with STATE_LOCK:
                STATE["last_reply"] = str(LAST_REPLY)[:200]
            log_event("send", f"DSH 回复：{LAST_REPLY}")
            self._send(200, dsh)
            return

        if path == "/api/v1/voice":
            bump("voice")
            # 16 kHz mono 16-bit PCM: 32 000 bytes per second after the 44-byte header.
            seconds = max(0.0, (len(raw) - 44) / 32000.0) if len(raw) > 44 else 0.0
            with STATE_LOCK:
                STATE["last_voice_bytes"] = len(raw)
                STATE["last_voice_seconds"] = round(seconds, 1)
                STATE["last_voice_text"] = None
                STATE["last_asr_ms"] = None
            log_event("voice", f"收到语音 {len(raw)} 字节（约 {seconds:.1f} 秒），开始识别")

            started = time.time()
            try:
                text = transcribe_wav(raw)
            except Exception as exc:
                self._record_error("语音识别失败", f"asr_failed: {exc}")
                self._send(500, {"ok": False, "error": f"asr_failed: {exc}"})
                return
            asr_ms = int((time.time() - started) * 1000)
            with STATE_LOCK:
                STATE["last_asr_ms"] = asr_ms
                STATE["last_voice_text"] = text or None
            if not text:
                log_event("error", f"没听清（{asr_ms} ms）")
                self._send(200, {"ok": False, "error": "empty_transcript"})
                return
            log_event("voice", f"识别完成 {asr_ms} ms：{text}")
            LAST_REPLY = f"你说: {text}"
            self._send(200, {"ok": True, "text": text})
            return

        self._send(404, {"ok": False, "error": "not_found"})

    def log_message(self, fmt, *args):
        # The overlay polls /api/v1/diag every few seconds; logging it drowns the
        # device traffic that actually matters when debugging.
        request = str(args[0]) if args else ""
        if "/api/v1/diag" in request:
            return
        print(f"[bridge] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    threading.Thread(target=discovery_loop, daemon=True).start()
    threading.Thread(target=scan_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log_event("service", f"HTTP 监听 0.0.0.0:{PORT}，UDP 发现 {DISCOVERY_PORT}")
    log_event("service", f"ASR 模型 {MODEL_NAME} / 语言 {LANGUAGE}")
    print(f"[bridge] HTTP listening on 0.0.0.0:{PORT}", flush=True)
    print(f"[bridge] ASR model={MODEL_NAME} lang={LANGUAGE} dir={MODEL_DIR}", flush=True)
    print(f"[bridge] 状态面板（仅本机）: http://127.0.0.1:{PORT}/", flush=True)
    server.serve_forever()
