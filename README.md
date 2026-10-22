# onepage-hub

OnePage 墨水屏 Agent 遥控器的 DSH 主机侧：一个 DSH 插件 + 一个本地 ASR/发现桥。

```text
DSH 桌面端
└─ onepage-hub 插件（127.0.0.1:8766–8770）
    └─ spawn Python 桥（0.0.0.0:8765–8770）
         ├─ /api/v1/status   状态转发到 DSH session
         ├─ /api/v1/send     把文字 followup 进当前 DSH session
         ├─ /api/v1/voice    faster-whisper 本地识别
         └─ UDP 8767          设备发现（HELLO → HOST）
```

## 安装

```powershell
dsh plugin --profile desktop add "C:\path\onepage-hub-0.1.2.tgz"
```

重启 DSH 桌面端后插件生效。插件会自己在 8765–8770 找空端口启动桥，不需要单独运行脚本。

## Python 环境

只有**本地 ASR** 需要这套环境（API 后端不需要）。插件用 DSH 自带的 Python
启动桥（按 `ONEPAGE_BRIDGE_PYTHON` → DSH 运行时 → PATH 的顺序解析），
依赖装在独立 venv：

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

## 状态面板（新增）

插件启动后会在 DSH 日志里打印一行：

```text
[onepage-remote] 状态面板: http://127.0.0.1:8765/
```

打开它就是主机侧的实时状态页（每 1.5 秒自刷新），内容：

| 区块 | 显示什么 |
|---|---|
| 服务 | 桥端口、已运行时长 |
| 设备 | 最近一次 HELLO 的设备 IP、配对台数 |
| DSH 连接 | 插件是否可达、当前 Agent / 仓库 / 状态 |
| 最近识别 | ASR 耗时、音频大小与时长 |
| 近期语音 / 消息 | 最后一次识别的文字、最后一次发出的文本与 DSH 回复 |
| 活动时间线 | 发现、语音、发送、错误的时间顺序事件 |
| ASR 后端 | 当前生效的是本地还是厂商 API，可直接切换 |

- 访问 `http://127.0.0.1:8766/` 也行：插件会 302 到桥的面板；桥没起来时显示一张说明页
  （含 pid、端口、日志路径），不会再是「一片空白」。
- 面板**只允许本机回环访问**（LAN 访问返回 403），因为它会显示识别出来的语音文本。
- 页面底部可以**直接发一条测试文本**走完整链路（浏览器 → 桥 → 插件 → DSH session）。

## ASR 后端：本地还是厂商 API

两种都支持，可随时切换，不需要改 DSH 启动参数。

| 后端 | 说明 | 代价 |
|---|---|---|
| `local` | `faster-whisper` 在本机 CPU 上跑 | 首次下载模型（small ≈ 480 MB），每次识别吃 CPU |
| `api` | 任意 **OpenAI 兼容**的 `/audio/transcriptions` | 音频离开本机，需要 Key，按量计费 |
| `auto`（默认） | 有 Key 走 API，没 Key 走本地 | — |

切换方式（三种，优先级从低到高）：

1. 状态面板里选后端 → 保存（写入 `~/.onepage-agent/asr.json`）
2. 直接编辑 `%USERPROFILE%\.onepage-agent\asr.json`
3. 环境变量（覆盖文件，适合临时试）：

```powershell
$env:ONEPAGE_ASR       = 'api'                                   # auto | local | api
$env:ONEPAGE_ASR_API_BASE = 'https://api.openai.com/v1'          # 或 SiliconFlow / Groq 等兼容端点
$env:ONEPAGE_ASR_API_KEY  = 'sk-...'
$env:ONEPAGE_ASR_MODEL    = 'whisper-1'
$env:WHISPER_LANG         = 'zh'
```

> 本地后端才需要下面的 venv 与模型；纯 API 模式可以不装 `faster-whisper`，
> 面板上会显示「未安装 faster-whisper」但不影响使用。
> 面板不会显示已保存的 Key，只显示是否已设置；留空保存表示保持原值。

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
