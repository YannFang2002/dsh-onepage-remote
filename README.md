# dsh-onepage-remote

OnePage 墨水屏 Agent 遥控器的 DSH 主机侧：一个 DSH 插件 + 一个本地 ASR/发现桥。

```text
DSH 桌面端
└─ dsh-onepage-remote 插件（127.0.0.1:8766–8770）
    └─ spawn Python 桥（0.0.0.0:8765–8770）
         ├─ /api/v1/status   状态转发到 DSH session
         ├─ /api/v1/send     把文字 followup 进当前 DSH session
         ├─ /api/v1/voice    faster-whisper 本地识别
         └─ UDP 8767          设备发现（HELLO → HOST）
```

## 安装

```powershell
dsh plugin --profile desktop add "C:\path\dsh-onepage-remote-0.1.2.tgz"
```

重启 DSH 桌面端后插件生效。插件会自己在 8765–8770 找空端口启动桥，不需要单独运行脚本。

## Python 环境

插件用 DSH 自带的 Python 启动桥，依赖装在独立 venv：

```powershell
# 创建 venv（放在用户目录，避免进 Git）
python -m venv "$env:USERPROFILE\.onepage-agent\venv"
& "$env:USERPROFILE\.onepage-agent\venv\Scripts\python.exe" -m pip install faster-whisper av==12.3.0 opencc-python-reimplemented
```

模型默认在 `%USERPROFILE%\.onepage-agent\models`，首次识别会自动下载 `small`（约 480 MB）。也可以手动放好。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `ONEPAGE_BRIDGE_PYTHON` | DSH 自带 Python | 启动桥的解释器 |
| `ONEPAGE_BRIDGE_SITE` | `~/.onepage-agent/venv/Lib/site-packages` | faster-whisper 等依赖 |
| `ONEPAGE_MODEL_DIR` | `~/.onepage-agent/models` | Whisper 模型目录 |
| `ONEPAGE_BRIDGE_SCRIPT` | 包内 `bridge/server.py` | 调试时可覆盖桥脚本 |
| `ONEPAGE_DISCOVERY_PORT` | `8767` | UDP 发现端口 |

## 端口

- 插件：`127.0.0.1:8766–8770`
- 桥：`0.0.0.0:8765–8770`
- 发现：`UDP 8767`
- 设备通过 UDP 发现拿到桥的真实端口，不写死 8765

## 设备侧协议

```http
GET  /api/v1/status
POST /api/v1/send    {"text":"..."}
POST /api/v1/voice   audio/wav
```

发现：

```json
{"type":"hello","id":"onepage"}
→ {"type":"host","host":"192.168.66.124","port":8765}
```

## 安全说明

桥当前用 UDP HELLO 的来源 IP 做基础设备绑定；**还没有加密 token**。不要把 8765 暴露到公网。
