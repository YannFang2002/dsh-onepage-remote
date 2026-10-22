// Browser half of onepage-hub.
//
// Loaded by the DSH web UI through window.__ModuleLoader__ (the same protocol
// dsh-dafeiyu uses), so this file is plain hand-written JS: no bundler, no npm
// install, `require('react')` resolves to the host's React.
//
// It contributes two surfaces, both inside DSH (no browser tab needed):
//   - shell.overlay: a draggable status pill + detail card
//   - the settings card slots: the same panel, reachable from the plugin list
// Data comes from same-origin /plugins/onepage-hub/* routes registered by
// index.js on the host's webServer, so there is no cross-origin fetch.
window.__ModuleLoader__.load({
  id: 'onepage-hub',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    const APP_NAME = 'OnePage Hub'
    const DIAG_PATH = '/plugins/onepage-hub/diag'
    const SEND_PATH = '/plugins/onepage-hub/send'
    const ASR_PATH = '/plugins/onepage-hub/asr'
    const INSTALL_PATH = '/plugins/onepage-hub/asr/install'
    const RESTART_PATH = '/plugins/onepage-hub/bridge/restart'
    const OVERLAY_ID = 'onepage-hub-overlay'
    const POSITION_KEY = 'onepage-hub:position'
    const COLOR_KEY = 'onepage-hub:color'
    // 'auto' keeps the semantic colour (green/amber/red). Anything else tints the
    // whole pill so it is easy to spot in a busy window; the status dot keeps its
    // semantic colour either way.
    const COLOR_PRESETS = ['auto', '#1677ff', '#00b42a', '#ff7d00', '#722ed1', '#eb2f96', '#f53f3f']

    const CARD_WIDTH = 336
    const EDGE = 8
    const PILL_HEIGHT = 32

    const FONT = '12px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
    const COLORS = {
      ok: '#00b42a',
      warn: '#ff7d00',
      bad: '#f53f3f',
      text: '#1d2129',
      muted: '#86909c',
      line: '#e5e6eb',
    }

    const styles = {
      root: {
        position: 'fixed',
        zIndex: 2147482000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        touchAction: 'none',
      },
      pill: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        borderRadius: 999,
        background: 'var(--surface-color, #fff)',
        border: `1px solid ${COLORS.line}`,
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.10)',
        font: FONT,
        color: COLORS.text,
        cursor: 'grab',
        userSelect: 'none',
        whiteSpace: 'nowrap',
      },
      dot: { width: 8, height: 8, borderRadius: '50%', flex: 'none' },
      card: {
        position: 'absolute',
        width: CARD_WIDTH,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: '60vh',
        overflowY: 'auto',
        padding: 14,
        borderRadius: 12,
        background: 'var(--surface-color, #fff)',
        border: `1px solid ${COLORS.line}`,
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.16)',
        font: FONT,
        color: COLORS.text,
        cursor: 'default',
      },
      inline: { maxWidth: 560 },
      row: { display: 'flex', gap: 8, padding: '3px 0' },
      key: { color: COLORS.muted, width: 62, flex: 'none' },
      value: { flex: 1, wordBreak: 'break-all' },
      section: { marginTop: 10, paddingTop: 8, borderTop: `1px dashed ${COLORS.line}` },
      label: { color: COLORS.muted, marginBottom: 4 },
      quote: {
        padding: '6px 8px',
        borderRadius: 8,
        background: 'rgba(0, 0, 0, 0.035)',
        wordBreak: 'break-word',
        maxHeight: 90,
        overflowY: 'auto',
      },
      buttons: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' },
      button: {
        padding: '5px 10px',
        borderRadius: 8,
        border: `1px solid ${COLORS.line}`,
        background: 'transparent',
        color: COLORS.text,
        font: FONT,
        cursor: 'pointer',
      },
      primary: {
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid #1677ff',
        background: '#1677ff',
        color: '#fff',
        font: FONT,
        cursor: 'pointer',
      },
      input: {
        width: '100%',
        padding: '5px 8px',
        borderRadius: 8,
        border: `1px solid ${COLORS.line}`,
        font: FONT,
        color: COLORS.text,
        background: 'transparent',
        boxSizing: 'border-box',
      },
      field: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 },
      event: { display: 'flex', gap: 6, color: COLORS.text },
      time: { color: COLORS.muted, flex: 'none' },
      hint: { marginTop: 8, color: COLORS.muted, fontSize: 11 },
      progress: { height: 4, borderRadius: 2, background: COLORS.line, marginTop: 6, overflow: 'hidden' },
      progressBar: { height: 4, background: '#1677ff', transition: 'width .4s' },
      log: {
        marginTop: 6,
        maxHeight: 72,
        overflowY: 'auto',
        color: COLORS.muted,
        fontSize: 11,
        fontFamily: 'ui-monospace, Consolas, monospace',
        whiteSpace: 'pre-wrap',
      },
      swatches: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 },
      swatch: {
        width: 22,
        height: 22,
        borderRadius: 6,
        border: '1px solid',
        background: 'transparent',
        font: FONT,
        fontSize: 10,
        color: COLORS.muted,
        cursor: 'pointer',
        padding: 0,
      },
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), Math.max(min, max))
    }

    function viewport() {
      if (typeof window === 'undefined') return { width: 1280, height: 800 }
      return { width: window.innerWidth, height: window.innerHeight }
    }

    function defaultPosition() {
      const { width, height } = viewport()
      return { left: Math.max(EDGE, width - CARD_WIDTH - 16), top: Math.max(EDGE, height - 140) }
    }

    function readPosition() {
      try {
        const raw = window.localStorage.getItem(POSITION_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (typeof parsed.left === 'number' && typeof parsed.top === 'number') {
            const { width, height } = viewport()
            return {
              left: clamp(parsed.left, EDGE, width - 60),
              top: clamp(parsed.top, EDGE, height - 40),
            }
          }
        }
      } catch {
        // storage disabled; use the default corner
      }
      return defaultPosition()
    }

    function deviceState(data) {
      if (data === null) return { color: COLORS.muted, text: '连接中…' }
      if (data.offline) return { color: COLORS.bad, text: '主机路由不可用' }
      const bridge = data.bridge
      if (!bridge || !bridge.ok) return { color: COLORS.bad, text: '桥未启动' }
      const device = bridge.device || {}
      if (!device.ip) return { color: COLORS.warn, text: '等待设备' }
      if (!device.online) {
        const ago = device.last_seen_ago
        return {
          color: COLORS.muted,
          text: ago == null ? `${device.ip} · 离线` : `${device.ip} · 离线 ${ago}s`,
        }
      }
      return { color: COLORS.ok, text: `${device.ip} · 在线` }
    }

    // Display colour lives outside React state so the floating pill and the
    // settings card stay in sync (both subscribe to the same store).
    const colorStore = {
      value: (() => {
        try {
          return window.localStorage.getItem(COLOR_KEY) || 'auto'
        } catch {
          return 'auto'
        }
      })(),
      listeners: new Set(),
      set(value) {
        this.value = value
        try {
          window.localStorage.setItem(COLOR_KEY, value)
        } catch {
          // storage disabled; colour just does not persist
        }
        for (const listener of this.listeners) listener(value)
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useColor() {
      const [value, setValue] = useState(colorStore.value)
      useEffect(() => colorStore.subscribe(setValue), [])
      return [value, (next) => colorStore.set(next)]
    }

    function useDiag(intervalMs) {
      const [data, setData] = useState(null)
      const load = useCallback(async () => {
        try {
          const res = await fetch(DIAG_PATH, { cache: 'no-store' })
          if (!res.ok) throw new Error(String(res.status))
          setData(await res.json())
        } catch {
          setData({ offline: true })
        }
      }, [])
      useEffect(() => {
        load()
        const timer = setInterval(() => {
          if (!document.hidden) load()
        }, intervalMs)
        return () => clearInterval(timer)
      }, [load, intervalMs])
      return { data, load }
    }

    function Row({ name, children }) {
      return React.createElement(
        'div',
        { style: styles.row },
        React.createElement('div', { style: styles.key }, name),
        React.createElement('div', { style: styles.value }, children),
      )
    }

    function Field({ label, value, onChange, placeholder, type }) {
      return React.createElement(
        'label',
        { style: styles.field },
        React.createElement('span', { style: { color: COLORS.muted } }, label),
        React.createElement('input', {
          style: styles.input,
          value,
          placeholder,
          type: type || 'text',
          onChange: (event) => onChange(event.target.value),
        }),
      )
    }

    // ASR controls: backend choice, and -- when local is selected -- a one-click
    // installer with editable paths (the venv + model are ~600 MB and often need
    // to live on another drive).
    function AsrPanel({ asr, reload }) {
      const [mode, setMode] = useState('')
      const [base, setBase] = useState('')
      const [model, setModel] = useState('')
      const [key, setKey] = useState('')
      const [venv, setVenv] = useState('')
      const [modelDir, setModelDir] = useState('')
      const [notice, setNotice] = useState('')
      const [touched, setTouched] = useState(false)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        if (!asr || touched) return
        setMode(asr.mode || 'auto')
        setBase(asr.api_base || '')
        setModel(asr.api_model || '')
        setVenv(asr.venv_path || '')
        setModelDir(asr.model_dir || '')
      }, [asr, touched])

      const post = async (path, payload) => {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        return res.json()
      }

      const save = async (patch) => {
        setBusy(true)
        setNotice('保存中…')
        try {
          const json = await post(ASR_PATH, patch)
          setNotice(json.ok ? `已保存，当前生效：${json.asr.effective}` : `失败：${json.error}`)
          setTouched(false)
          reload()
        } catch (error) {
          setNotice(`失败：${error}`)
        } finally {
          setBusy(false)
        }
      }

      const install = async () => {
        setBusy(true)
        setNotice('开始安装…（约 600 MB，几分钟）')
        try {
          const json = await post(INSTALL_PATH, {
            venv_path: venv,
            model_dir: modelDir,
            local_model: asr ? asr.local_model : 'small',
          })
          setNotice(json.ok ? '安装已启动，进度见下方' : `失败：${json.error}`)
          reload()
        } catch (error) {
          setNotice(`失败：${error}`)
        } finally {
          setBusy(false)
        }
      }

      const installState = asr && asr.install ? asr.install : null
      const running = installState && installState.state === 'running'
      const localMode = mode === 'local' || (mode === 'auto' && !(asr && asr.api_key_set))

      return React.createElement(
        'div',
        null,
        React.createElement('div', { style: styles.label }, '语音识别（ASR）'),
        React.createElement(
          'select',
          {
            style: styles.input,
            value: mode,
            onChange: (event) => {
              setMode(event.target.value)
              setTouched(true)
            },
          },
          React.createElement('option', { value: 'auto' }, '自动（有 Key 走 API，否则本地）'),
          React.createElement('option', { value: 'local' }, '本地 Whisper'),
          React.createElement('option', { value: 'api' }, '厂商 API（OpenAI 兼容）'),
        ),

        localMode
          ? React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              { style: { ...styles.row, marginTop: 6 } },
              React.createElement('div', { style: styles.key }, '本地'),
              React.createElement(
                'div',
                { style: styles.value },
                asr && asr.local_installed
                  ? (asr.model_present ? '已安装（模型就绪）' : '已安装（模型首次识别时下载）')
                  : '未安装',
              ),
            ),
            React.createElement(Field, {
              label: '虚拟环境目录',
              value: venv,
              placeholder: 'D:\\onepage\\venv',
              onChange: (value) => {
                setVenv(value)
                setTouched(true)
              },
            }),
            React.createElement(Field, {
              label: '模型目录',
              value: modelDir,
              placeholder: 'D:\\onepage\\models',
              onChange: (value) => {
                setModelDir(value)
                setTouched(true)
              },
            }),
            React.createElement(
              'div',
              { style: styles.buttons },
              React.createElement(
                'button',
                { style: styles.primary, disabled: busy || running, onClick: install },
                running ? '安装中…' : (asr && asr.local_installed ? '重新安装 / 下载模型' : '下载并安装'),
              ),
              React.createElement(
                'button',
                { style: styles.button, disabled: busy, onClick: () => save({ venv_path: venv, model_dir: modelDir }) },
                '仅保存路径',
              ),
            ),
            installState && installState.state !== 'idle'
              ? React.createElement(
                'div',
                { style: { marginTop: 6 } },
                React.createElement(
                  'div',
                  { style: { color: installState.state === 'error' ? COLORS.bad : COLORS.muted } },
                  `${installState.stage || installState.state}${installState.message ? ` · ${installState.message}` : ''}`,
                ),
                React.createElement(
                  'div',
                  { style: styles.progress },
                  React.createElement('div', {
                    style: { ...styles.progressBar, width: `${installState.progress || 0}%` },
                  }),
                ),
                React.createElement(
                  'div',
                  { style: styles.log },
                  (installState.log || []).slice(-6).join('\n'),
                ),
              )
              : null,
          )
          : React.createElement(
            'div',
            null,
            React.createElement(Field, {
              label: 'API 地址',
              value: base,
              placeholder: 'https://api.openai.com/v1',
              onChange: (value) => {
                setBase(value)
                setTouched(true)
              },
            }),
            React.createElement(Field, {
              label: 'API 模型',
              value: model,
              placeholder: 'whisper-1',
              onChange: (value) => {
                setModel(value)
                setTouched(true)
              },
            }),
            React.createElement(Field, {
              label: 'API Key（留空保持原值）',
              value: key,
              type: 'password',
              placeholder: asr && asr.api_key_set ? '已设置' : '未设置',
              onChange: (value) => {
                setKey(value)
                setTouched(true)
              },
            }),
            React.createElement(
              'div',
              { style: styles.buttons },
              React.createElement(
                'button',
                {
                  style: styles.primary,
                  disabled: busy,
                  onClick: () => {
                    const patch = { backend: mode, api_base: base, api_model: model }
                    if (key.trim()) patch.api_key = key.trim()
                    save(patch)
                  },
                },
                '保存 API 设置',
              ),
            ),
          ),

        !localMode
          ? React.createElement(
            'div',
            { style: styles.buttons },
            React.createElement(
              'button',
              { style: styles.button, disabled: busy, onClick: () => save({ backend: mode }) },
              '仅切换后端',
            ),
          )
          : null,
        localMode && touched
          ? React.createElement(
            'div',
            { style: styles.buttons },
            React.createElement(
              'button',
              { style: styles.button, disabled: busy, onClick: () => save({ backend: mode }) },
              '仅切换后端',
            ),
          )
          : null,
        notice ? React.createElement('div', { style: { marginTop: 6, color: COLORS.muted } }, notice) : null,
      )
    }

    // How the one-sentence reply is produced. "heuristic" is free and instant;
    // "llm" spends one extra chat call to actually rewrite it into a conclusion
    // (a plugin cannot make the model lead with a summary, only rewrite after).
    function SummaryPanel({ asr, reload }) {
      const [mode, setMode] = useState('')
      const [base, setBase] = useState('')
      const [model, setModel] = useState('')
      const [key, setKey] = useState('')
      const [notice, setNotice] = useState('')
      const [touched, setTouched] = useState(false)

      useEffect(() => {
        if (!asr || touched) return
        setMode(asr.summary_mode || 'heuristic')
        setBase(asr.summary_base || '')
        setModel(asr.summary_model || '')
      }, [asr, touched])

      const save = async () => {
        const patch = { summary_mode: mode, summary_base: base, summary_model: model }
        if (key.trim()) patch.summary_key = key.trim()
        try {
          const res = await fetch(ASR_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          const json = await res.json()
          setNotice(json.ok ? '已保存' : `失败：${json.error}`)
          setTouched(false)
          reload()
        } catch (error) {
          setNotice(`失败：${error}`)
        }
      }

      return React.createElement(
        'div',
        { style: styles.section },
        React.createElement('div', { style: styles.label }, '回复摘要'),
        React.createElement(
          'select',
          {
            style: styles.input,
            value: mode,
            onChange: (event) => {
              setMode(event.target.value)
              setTouched(true)
            },
          },
          React.createElement('option', { value: 'heuristic' }, '启发式（免费，挑一句）'),
          React.createElement('option', { value: 'llm' }, '模型总结（多一次调用）'),
        ),
        mode !== 'llm'
          ? null
          : React.createElement(
            'div',
            null,
            React.createElement(Field, {
              label: '模型 API 地址（空 = 沿用 ASR 的）',
              value: base,
              placeholder: 'https://api.deepseek.com/v1',
              onChange: (value) => {
                setBase(value)
                setTouched(true)
              },
            }),
            React.createElement(Field, {
              label: '模型名',
              value: model,
              placeholder: 'deepseek-chat',
              onChange: (value) => {
                setModel(value)
                setTouched(true)
              },
            }),
            React.createElement(Field, {
              label: 'API Key（空 = 沿用 ASR 的）',
              value: key,
              type: 'password',
              placeholder: asr && asr.summary_key_set ? '已设置' : '未设置',
              onChange: (value) => {
                setKey(value)
                setTouched(true)
              },
            }),
          ),
        React.createElement(
          'div',
          { style: styles.buttons },
          React.createElement('button', { style: styles.button, onClick: save }, '保存摘要设置'),
        ),
        notice ? React.createElement('div', { style: { marginTop: 6, color: COLORS.muted } }, notice) : null,
      )
    }

    function Panel({ data, reload, onClose, inline }) {
      const bridge = data && data.bridge ? data.bridge : null
      const asr = bridge && bridge.asr ? bridge.asr : null
      const last = bridge && bridge.last ? bridge.last : {}
      const events = bridge && bridge.events ? bridge.events.slice(0, 6) : []
      const device = bridge && bridge.device ? bridge.device : {}
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [color, setColor] = useColor()

      const sendTest = async () => {
        setBusy(true)
        setNotice('发送中…')
        try {
          const res = await fetch(SEND_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: `来自 ${APP_NAME} 状态面板的连通性测试` }),
          })
          const json = await res.json()
          setNotice(json.ok ? `已发送：${json.reply || 'OK'}` : `失败：${json.error || res.status}`)
        } catch (error) {
          setNotice(`失败：${error}`)
        } finally {
          setBusy(false)
          reload()
        }
      }

      // bridge/server.py is a separate process, so restarting just the bridge
      // applies bridge-side changes without restarting DSH. Host plugin changes
      // (index.js) still need an app restart.
      const restartBridge = async () => {
        setBusy(true)
        setNotice('正在重启桥接…')
        try {
          const res = await fetch(RESTART_PATH, { method: 'POST' })
          const json = await res.json()
          setNotice(json.ok ? '桥已重启' : `重启失败：${json.bridgeStatus || 'unknown'}`)
        } catch (error) {
          setNotice(`失败：${error}`)
        } finally {
          setBusy(false)
          reload()
        }
      }

      return React.createElement(
        'div',
        inline ? { style: styles.inline } : null,
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, APP_NAME),
        React.createElement(Row, { name: '桥接' }, bridge
          ? (bridge.ok
            ? `运行中 · 端口 ${bridge.service.port} · ${Math.round(bridge.service.uptime_sec / 60)} 分钟`
            : '未运行')
          : '未知'),
        React.createElement(Row, { name: '设备' },
          device.ip
            ? `${device.ip}${device.online ? ' · 在线' : ` · 离线${device.last_seen_ago != null ? ` ${device.last_seen_ago}s` : ''}`}`
            : '尚未发现'),
        React.createElement(Row, { name: 'DSH' },
          bridge && bridge.dsh && bridge.dsh.reachable
            ? [bridge.dsh.agent, bridge.dsh.repo, bridge.dsh.state].filter(Boolean).join(' · ')
            : '未连接（插件路由正常，session 未就绪）'),

        React.createElement(
          'div',
          { style: styles.section },
          React.createElement('div', { style: styles.label }, '显示颜色'),
          React.createElement(
            'div',
            { style: styles.swatches },
            ...COLOR_PRESETS.map((preset) => React.createElement(
              'button',
              {
                key: preset,
                title: preset === 'auto' ? '自动（按状态变色）' : preset,
                style: {
                  ...styles.swatch,
                  background: preset === 'auto' ? 'transparent' : preset,
                  borderColor: color === preset ? COLORS.text : COLORS.line,
                  color: COLORS.muted,
                },
                onClick: () => setColor(preset),
              },
              preset === 'auto' ? '自动' : '',
            )),
            React.createElement('input', {
              type: 'color',
              title: '自定义颜色',
              value: color === 'auto' ? '#1677ff' : color,
              onChange: (event) => setColor(event.target.value),
              style: { width: 26, height: 24, padding: 0, border: 'none', background: 'none', cursor: 'pointer' },
            }),
          ),
        ),

        React.createElement(
          'div',
          { style: styles.section },
          asr ? React.createElement(AsrPanel, { asr, reload }) : React.createElement('div', null, 'ASR 状态未知'),
        ),

        asr
          ? React.createElement(
            'div',
            { style: styles.section },
            React.createElement(SummaryPanel, { asr, reload }),
          )
          : null,

        React.createElement(
          'div',
          { style: styles.section },
          React.createElement('div', { style: styles.label }, '最近识别'),
          React.createElement('div', { style: styles.quote }, last.voice_text || '尚无语音。在设备上按住确认键说话。'),
          last.asr_ms != null
            ? React.createElement(
              'div',
              { style: { color: COLORS.muted, marginTop: 4 } },
              `${last.asr_ms} ms${last.voice_bytes ? ` · ${(last.voice_bytes / 1024).toFixed(0)} KB` : ''}${last.voice_seconds ? ` · ${last.voice_seconds.toFixed(1)} s` : ''}`,
            )
            : null,
        ),

        React.createElement(
          'div',
          { style: styles.section },
          React.createElement('div', { style: styles.label }, '最近发送'),
          React.createElement('div', { style: styles.quote }, last.text || '尚无发送'),
          last.reply
            ? React.createElement('div', { style: { color: COLORS.muted, marginTop: 4 } }, `↳ ${last.reply}`)
            : null,
        ),

        events.length > 0
          ? React.createElement(
            'div',
            { style: styles.section },
            React.createElement('div', { style: styles.label }, '活动'),
            ...events.map((event, index) => React.createElement(
              'div',
              { key: index, style: styles.event },
              React.createElement('span', { style: styles.time }, event.at),
              React.createElement('span', { style: { color: COLORS.muted } }, event.kind),
              React.createElement('span', { style: styles.value }, event.message),
            )),
          )
          : null,

        React.createElement(
          'div',
          { style: styles.buttons },
          React.createElement('button', { style: styles.button, onClick: reload }, '刷新'),
          React.createElement('button', { style: styles.button, disabled: busy, onClick: sendTest }, '发送测试'),
          React.createElement('button', { style: styles.button, disabled: busy, onClick: restartBridge }, '重启桥'),
          onClose ? React.createElement('button', { style: styles.button, onClick: onClose }, '收起') : null,
        ),
        notice ? React.createElement('div', { style: { marginTop: 8, color: COLORS.muted } }, notice) : null,
      )
    }

    function Overlay() {
      const { data, load } = useDiag(3000)
      const [open, setOpen] = useState(false)
      const [pos, setPos] = useState(readPosition)
      const drag = useRef(null)

      useEffect(() => {
        const onResize = () => {
          const { width, height } = viewport()
          setPos((current) => ({
            left: clamp(current.left, EDGE, width - 60),
            top: clamp(current.top, EDGE, height - 40),
          }))
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      const persist = useCallback((next) => {
        try {
          window.localStorage.setItem(POSITION_KEY, JSON.stringify(next))
        } catch {
          // storage disabled; position just does not survive a reload
        }
      }, [])

      const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return
        drag.current = { dx: event.clientX - pos.left, dy: event.clientY - pos.top, moved: false }
        if (event.currentTarget.setPointerCapture) {
          event.currentTarget.setPointerCapture(event.pointerId)
        }
      }

      const onPointerMove = (event) => {
        const state = drag.current
        if (!state) return
        const { width, height } = viewport()
        const left = clamp(event.clientX - state.dx, EDGE, width - 60)
        const top = clamp(event.clientY - state.dy, EDGE, height - 40)
        if (Math.abs(left - pos.left) + Math.abs(top - pos.top) > 2) {
          state.moved = true
          event.currentTarget.style.cursor = 'grabbing'
        }
        setPos({ left, top })
      }

      const onPointerUp = (event) => {
        const state = drag.current
        drag.current = null
        event.currentTarget.style.cursor = 'grab'
        if (event.currentTarget.releasePointerCapture) {
          try {
            event.currentTarget.releasePointerCapture(event.pointerId)
          } catch {
            // already released
          }
        }
        if (!state) return
        if (state.moved) {
          persist(pos)
        } else {
          setOpen((value) => !value)
        }
      }

      const resetPosition = () => {
        const next = defaultPosition()
        setPos(next)
        persist(next)
      }

      const status = deviceState(data)
      const [tint] = useColor()
      const tinted = tint !== 'auto'
      const pillStyle = tinted
        ? { ...styles.pill, background: tint, borderColor: tint, color: '#fff' }
        : styles.pill
      const pill = React.createElement(
        'div',
        {
          style: pillStyle,
          title: `${APP_NAME} · 点击展开 / 拖动移动 / 双击复位`,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onDoubleClick: resetPosition,
        },
        React.createElement('span', {
          style: {
            ...styles.dot,
            background: status.color,
            // A white ring keeps the semantic dot readable on a coloured pill.
            boxShadow: tinted ? '0 0 0 2px rgba(255,255,255,0.9)' : 'none',
          },
        }),
        React.createElement('span', null, APP_NAME),
        React.createElement(
          'span',
          { style: { color: tinted ? 'rgba(255,255,255,0.85)' : COLORS.muted } },
          status.text,
        ),
      )

      if (!open) {
        return React.createElement('div', { style: { ...styles.root, left: pos.left, top: pos.top } }, pill)
      }

      const { width, height } = viewport()
      const flipX = pos.left + CARD_WIDTH > width - EDGE
      const flipY = pos.top + PILL_HEIGHT + 320 > height
      const cardStyle = {
        ...styles.card,
        ...(flipX ? { right: 0 } : { left: 0 }),
        ...(flipY ? { bottom: PILL_HEIGHT + 6 } : { top: PILL_HEIGHT + 6 }),
      }

      return React.createElement(
        'div',
        { style: { ...styles.root, left: pos.left, top: pos.top } },
        pill,
        React.createElement(
          'div',
          { style: cardStyle },
          React.createElement(Panel, { data, reload: load, onClose: () => setOpen(false) }),
        ),
      )
    }

    // Settings surface: the same panel, opened from the plugin list instead of
    // the floating pill. Registered against every settings slot DSH has exposed
    // so far; slots that do not exist simply never fire.
    function SettingsCard() {
      const { data, load } = useDiag(5000)
      return React.createElement(
        'div',
        { style: { padding: 12 } },
        React.createElement(Panel, { data, reload: load, inline: true }),
      )
    }

    function apply(ctx) {
      try {
        ctx.slots.inject('shell.overlay', () => {
          ctx.slots.register(
            { name: 'shell.overlay', key: OVERLAY_ID, id: OVERLAY_ID, order: 900 },
            () => React.createElement(Overlay, null),
          )
        })
      } catch (error) {
        console.error('[onepage-hub] failed to register overlay:', error)
      }

      for (const slot of ['settings.plugin.item', 'settings.plugins.tab', 'plugins.bundle.config']) {
        try {
          ctx.slots.inject(slot, () => {
            ctx.slots.register(
              { name: slot, key: 'onepage-hub', id: 'onepage-hub', order: 30 },
              () => React.createElement(SettingsCard, null),
            )
          })
        } catch (error) {
          console.error(`[onepage-hub] failed to register ${slot}:`, error)
        }
      }
    }

    module.exports = { name: 'onepage-hub', inject: ['slots'], apply }
    return module.exports
  },
})
