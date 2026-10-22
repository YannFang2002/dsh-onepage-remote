// Browser half of onepage-hub.
//
// Loaded by the DSH web UI through window.__ModuleLoader__ (the same protocol
// dsh-dafeiyu uses), so this file is plain hand-written JS: no bundler, no npm
// install, `require('react')` resolves to the host's React.
//
// It contributes ONE thing: a status pill injected into the 'shell.overlay'
// slot -- the same slot the desktop pet lives in. The pill is draggable (the
// position is remembered), always readable without opening anything, and
// expands into a card with the details that used to be invisible (bridge state,
// paired device, last transcript, last send). Data comes from same-origin
// /plugins/onepage-hub/* routes registered by index.js on the host's
// webServer, so there is no cross-origin fetch.
window.__ModuleLoader__.load({
  id: 'onepage-hub',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    const DIAG_PATH = '/plugins/onepage-hub/diag'
    const SEND_PATH = '/plugins/onepage-hub/send'
    const OVERLAY_ID = 'onepage-hub-overlay'
    const POSITION_KEY = 'onepage-hub:position'

    const CARD_WIDTH = 332
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
        maxHeight: '58vh',
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
      event: { display: 'flex', gap: 6, color: COLORS.text },
      time: { color: COLORS.muted, flex: 'none' },
      hint: { marginTop: 8, color: COLORS.muted, fontSize: 11 },
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
      return {
        left: Math.max(EDGE, width - CARD_WIDTH - 16),
        top: Math.max(EDGE, height - 140),
      }
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
        // storage disabled (private mode); fall through to the default
      }
      return defaultPosition()
    }

    function statusOf(data) {
      if (data === null) return { color: COLORS.muted, text: '连接中…' }
      if (data.offline) return { color: COLORS.bad, text: '主机路由不可用' }
      const bridge = data.bridge
      if (!bridge || !bridge.ok) return { color: COLORS.bad, text: '桥未启动' }
      const ip = bridge.device && bridge.device.ip
      if (!ip) return { color: COLORS.warn, text: '等待设备' }
      const dsh = bridge.dsh && bridge.dsh.reachable
      if (!dsh) return { color: COLORS.warn, text: `${ip} · DSH 未连` }
      return { color: COLORS.ok, text: `${ip}` }
    }

    function Row({ name, children }) {
      return React.createElement(
        'div',
        { style: styles.row },
        React.createElement('div', { style: styles.key }, name),
        React.createElement('div', { style: styles.value }, children),
      )
    }

    function Overlay() {
      const [open, setOpen] = useState(false)
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [pos, setPos] = useState(readPosition)
      const drag = useRef(null)

      // A saved position can end up outside the window after a resize.
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
          // storage disabled; the position simply does not survive a reload
        }
      }, [])

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
        }, 3000)
        return () => clearInterval(timer)
      }, [load])

      useEffect(() => {
        if (open) load()
      }, [open, load])

      const sendTest = useCallback(async () => {
        setBusy(true)
        setNotice('发送中…')
        try {
          const res = await fetch(SEND_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: '来自 DSH 状态面板的连通性测试' }),
          })
          const json = await res.json()
          setNotice(json.ok ? `已发送：${json.reply || 'OK'}` : `失败：${json.error || res.status}`)
        } catch (error) {
          setNotice(`失败：${error}`)
        } finally {
          setBusy(false)
          load()
        }
      }, [load])

      // --- dragging -----------------------------------------------------------
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
            // pointer already released
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

      const status = statusOf(data)
      const bridge = data && data.bridge ? data.bridge : null
      const asr = bridge && bridge.asr ? bridge.asr : null
      const last = bridge && bridge.last ? bridge.last : {}
      const events = bridge && bridge.events ? bridge.events.slice(0, 6) : []

      const pill = React.createElement(
        'div',
        {
          style: styles.pill,
          title: 'OnePage Agent Remote · 点击展开 / 拖动移动 / 双击复位',
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onDoubleClick: resetPosition,
        },
        React.createElement('span', { style: { ...styles.dot, background: status.color } }),
        React.createElement('span', null, 'OnePage'),
        React.createElement('span', { style: { color: COLORS.muted } }, status.text),
      )

      if (!open) {
        return React.createElement('div', { style: { ...styles.root, left: pos.left, top: pos.top } }, pill)
      }

      // Keep the card on screen: flip horizontally near the right edge and open
      // upwards near the bottom.
      const { width, height } = viewport()
      const flipX = pos.left + CARD_WIDTH > width - EDGE
      const flipY = pos.top + PILL_HEIGHT + 320 > height
      const cardStyle = {
        ...styles.card,
        ...(flipX ? { right: 0 } : { left: 0 }),
        ...(flipY ? { bottom: PILL_HEIGHT + 6 } : { top: PILL_HEIGHT + 6 }),
      }

      const card = React.createElement(
        'div',
        { style: cardStyle },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'OnePage Agent Remote'),
        React.createElement(Row, { name: '桥接' }, bridge
          ? (bridge.ok ? `运行中 · 端口 ${bridge.service.port} · ${Math.round(bridge.service.uptime_sec / 60)} 分钟` : '未运行')
          : '未知'),
        React.createElement(Row, { name: '设备' },
          bridge && bridge.device && bridge.device.ip
            ? `${bridge.device.ip}${bridge.device.last_hello_at ? ` · ${bridge.device.last_hello_at}` : ''}`
            : '尚未发现'),
        React.createElement(Row, { name: 'DSH' },
          bridge && bridge.dsh && bridge.dsh.reachable
            ? [bridge.dsh.agent, bridge.dsh.repo, bridge.dsh.state].filter(Boolean).join(' · ')
            : '未连接（插件路由正常，session 未就绪）'),
        React.createElement(Row, { name: 'ASR' },
          asr
            ? (asr.effective === 'api'
              ? `厂商 API · ${asr.api_model}${asr.api_key_set ? '' : '（缺 Key）'}`
              : `本地 Whisper · ${asr.local_model}${asr.local_installed ? '' : '（未安装）'}`)
            : '—'),

        React.createElement(
          'div',
          { style: styles.section },
          React.createElement('div', { style: styles.label }, '最近识别'),
          React.createElement('div', { style: styles.quote },
            last.voice_text || '尚无语音。在设备上按住确认键说话。'),
          last.asr_ms != null
            ? React.createElement('div', { style: { color: COLORS.muted, marginTop: 4 } },
              `${last.asr_ms} ms${last.voice_bytes ? ` · ${(last.voice_bytes / 1024).toFixed(0)} KB` : ''}${last.voice_seconds ? ` · ${last.voice_seconds.toFixed(1)} s` : ''}`)
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
          React.createElement('button', { style: styles.button, onClick: load }, '刷新'),
          React.createElement('button', { style: styles.button, disabled: busy, onClick: sendTest }, '发送测试'),
          bridge && bridge.ok
            ? React.createElement('button', {
              style: styles.button,
              onClick: () => window.open(`http://127.0.0.1:${bridge.service.port}/`, '_blank', 'noopener'),
            }, '完整面板')
            : null,
          React.createElement('button', { style: styles.button, onClick: resetPosition }, '复位'),
          React.createElement('button', { style: styles.button, onClick: () => setOpen(false) }, '收起'),
        ),
        notice ? React.createElement('div', { style: { marginTop: 8, color: COLORS.muted } }, notice) : null,
        React.createElement('div', { style: styles.hint }, '拖动胶囊可移动位置，双击复位'),
      )

      return React.createElement(
        'div',
        { style: { ...styles.root, left: pos.left, top: pos.top } },
        pill,
        card,
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
    }

    module.exports = { name: 'onepage-hub', inject: ['slots'], apply }
    return module.exports
  },
})
