// DSH host plugin for the OnePage Agent Remote.
//
// Owns the whole host side:
//   - loopback HTTP on 8766..8770 (auto-picks the first free port)
//   - a supervised Python bridge on 8765..8770 (APR + LAN discovery)
//   - status / send / voice endpoints consumed by the device
//
// The bridge advertises its actual port over UDP 8767, so the device never
// hardcodes 8765.

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'onepage-hub'
export const inject = ['agents', 'sessions']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_PORTS = [8766, 8767, 8768, 8769, 8770]
const BRIDGE_PORTS = [8765, 8766, 8767, 8768, 8769, 8770]

// Host-side runtime state for the loopback status page.
//
// The device only ever sees an HTTP status code, and the host used to expose
// nothing but log lines buried in the DSH log -- so there was no way to tell
// whether the bridge was up, which port it took, or why the last request
// failed. GET / on the plugin's loopback port now answers that.
const runtime = {
  startedAt: Date.now(),
  pluginPort: null,
  bridgePort: null,
  bridgePid: null,
  bridgeStatus: 'not started',
  bridgeLog: path.join(os.tmpdir(), 'onepage-bridge.log'),
}

function statusPage() {
  const uptime = Math.round((Date.now() - runtime.startedAt) / 1000)
  const rows = [
    ['插件', `运行中 · 127.0.0.1:${runtime.pluginPort ?? '—'} · ${uptime} 秒`],
    ['桥接进程', `${runtime.bridgeStatus}${runtime.bridgePid ? ` · pid ${runtime.bridgePid}` : ''}`],
    ['桥接端口', runtime.bridgePort ? `127.0.0.1:${runtime.bridgePort}` : '未启动'],
    ['桥接日志', runtime.bridgeLog],
  ]
  const body = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>OnePage Agent Remote · 插件状态</title>
<style>
 body{margin:0;padding:24px;font:14px/1.7 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#f5f6f8;color:#1d2129}
 h1{font-size:17px;margin:0 0 14px}
 table{background:#fff;border:1px solid #e5e6eb;border-radius:10px;border-collapse:separate;border-spacing:0;width:100%;max-width:720px}
 th,td{padding:10px 14px;border-bottom:1px solid #f2f3f5;text-align:left;vertical-align:top}
 th{width:110px;color:#86909c;font-weight:500}
 tr:last-child th,tr:last-child td{border-bottom:0}
 p{max-width:720px;color:#4e5969}
 code{background:#f2f3f5;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>OnePage Agent Remote · 插件</h1>
<table>${body}</table>
<p>桥接进程没有在运行，所以设备暂时连不上。检查 DSH 日志里的
<code>[onepage-remote]</code>，或直接看桥接日志文件。</p>
</body></html>`
}

// The interpreter that runs bridge/server.py.
//
// This used to be hardcoded to the author's home directory, so on any other
// machine the plugin silently started "plugin-only" and the device could not
// connect at all. Resolve it at runtime instead: explicit override first, then
// the Python that DSH itself ships, then whatever `python` is on PATH.
function resolvePython() {
  const candidates = [
    process.env.ONEPAGE_BRIDGE_PYTHON,
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate === 'python') return candidate
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* unreadable candidate, try the next one */
    }
  }
  return 'python'
}

const DEFAULT_PYTHON = resolvePython()
const DEFAULT_SCRIPT = process.env.ONEPAGE_BRIDGE_SCRIPT ?? path.join(HERE, 'bridge', 'server.py')
const DEFAULT_SITE =
  process.env.ONEPAGE_BRIDGE_SITE ?? path.join(os.homedir(), '.onepage-agent', 'venv', 'Lib', 'site-packages')
const DEFAULT_MODEL_DIR =
  process.env.ONEPAGE_MODEL_DIR ?? path.join(os.homedir(), '.onepage-agent', 'models')

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function liveAgents(ctx) {
  const service = ctx.agents
  if (typeof service?.roots === 'function') return service.roots()
  if (typeof service?.list === 'function') return service.list()
  return []
}

function pickAgent(ctx, preferredId) {
  const agents = liveAgents(ctx)
  if (preferredId !== undefined) {
    const exact = agents.find((agent) => agent?.id === preferredId)
    if (exact !== undefined) return exact
  }
  return agents.find((agent) => agent?.status === 'running') ?? agents[agents.length - 1]
}

function repoOf(agent) {
  const cwd = agent?.session?.meta?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? path.basename(cwd) : ''
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

// --- same-origin routes for the in-DSH overlay (lib/client.js) --------------
//
// The overlay runs inside the DSH web page, so it must not fetch the bridge's
// loopback port directly (different origin, and the port moves). Instead these
// routes are registered on the host's own webServer under /plugins/<id>/ and
// proxy to the bridge, which keeps the browser talking to one origin.
const PLUGIN_PREFIX = '/plugins/onepage-hub'

function isLocalRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}
  return JSON.parse(raw)
}

async function bridgeFetch(path, init) {
  if (runtime.bridgePort === null || runtime.bridgeStatus !== 'running') return null
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.bridgePort}${path}`, {
      ...init,
      signal: AbortSignal.timeout(3000),
    })
    return await response.json()
  } catch {
    return null
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function proxyVoice(req) {
  const body = await readBody(req)
  const upstream = await fetch(process.env.ONEPAGE_ASR_URL ?? 'http://127.0.0.1:8765/api/v1/voice', {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await upstream.text()
  return { status: upstream.status, body: text }
}

function listenOn(server, ports, host) {
  return new Promise((resolve, reject) => {
    let index = 0
    const attempt = () => {
      if (index >= ports.length) {
        reject(new Error(`no free port in ${ports[0]}-${ports[ports.length - 1]}`))
        return
      }
      const port = ports[index++]
      const onError = () => {
        server.off('listening', onListening)
        attempt()
      }
      const onListening = () => {
        server.off('error', onError)
        resolve(port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }
    attempt()
  })
}

function isFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, host)
  })
}

function startBridge(ctx, bridgePort, pluginPort) {
  if (!fs.existsSync(DEFAULT_PYTHON) || !fs.existsSync(DEFAULT_SCRIPT)) {
    ctx.logger?.warn?.('[onepage-remote] bridge python/script not found; running plugin-only')
    return null
  }

  const logPath = path.join(os.tmpdir(), 'onepage-bridge.log')
  const logFd = fs.openSync(logPath, 'a')
  const code =
    `import sys,runpy; sys.path.insert(0, ${JSON.stringify(DEFAULT_SITE)}); ` +
    `sys.argv=['server.py','${bridgePort}']; ` +
    `runpy.run_path(${JSON.stringify(DEFAULT_SCRIPT)}, run_name='__main__')`

  const child = spawn(DEFAULT_PYTHON, ['-c', code], {
    cwd: path.dirname(DEFAULT_SCRIPT),
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      DSH_URL: `http://127.0.0.1:${pluginPort}`,
      ONEPAGE_MODEL_DIR: DEFAULT_MODEL_DIR,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  })

  process.env.ONEPAGE_ASR_URL = `http://127.0.0.1:${bridgePort}/api/v1/voice`

  runtime.bridgePort = bridgePort
  runtime.bridgePid = child.pid
  runtime.bridgeStatus = 'running'

  child.on('exit', (code, signal) => {
    runtime.bridgeStatus = `exited (code=${code}${signal ? `, signal=${signal}` : ''})`
    ctx.logger?.warn?.(`[onepage-remote] bridge exited code=${code} signal=${signal}`)
  })
  child.on('error', (error) => {
    runtime.bridgeStatus = `spawn failed: ${error}`
    ctx.logger?.warn?.(`[onepage-remote] bridge spawn failed: ${error}`)
  })

  ctx.logger?.info?.(`[onepage-remote] bridge on 8765-8770 -> ${bridgePort}, log ${logPath}`)
  ctx.logger?.info?.(`[onepage-remote] 状态面板: http://127.0.0.1:${bridgePort}/`)
  return { child, logFd }
}

export function apply(ctx) {
  let lastReply = ''
  let lastSessionId
  let bridge

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const text = textOf(event.data?.message?.content).replace(/\s+/g, ' ').trim()
    if (text.length === 0) return
    lastSessionId = session?.id
    lastReply = text.slice(0, 80)
  })

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname

      // Human-facing status page on the loopback port. Redirects to the bridge
      // dashboard (it has the device/ASR state), or explains why it is missing.
      if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
        if (runtime.bridgeStatus === 'running' && runtime.bridgePort !== null) {
          res.writeHead(302, { location: `http://127.0.0.1:${runtime.bridgePort}/` })
          res.end()
          return
        }
        const html = statusPage()
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(html),
        })
        res.end(html)
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/status') {
        const agent = pickAgent(ctx, lastSessionId)
        sendJson(res, 200, {
          ok: true,
          agent: 'DSH',
          repo: repoOf(agent),
          state: agent?.status ?? 'idle',
          lastReply,
          sessionId: agent?.id ?? null,
        })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/send') {
        const raw = await readBody(req)
        let text = ''
        try {
          text = JSON.parse(raw.toString('utf8')).text ?? ''
        } catch {
          sendJson(res, 400, { ok: false, error: 'bad_json' })
          return
        }
        if (typeof text !== 'string' || text.trim().length === 0) {
          sendJson(res, 400, { ok: false, error: 'empty_text' })
          return
        }
        const agent = pickAgent(ctx, lastSessionId)
        if (agent === undefined) {
          sendJson(res, 409, { ok: false, error: 'no_agent' })
          return
        }
        agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
        lastSessionId = agent.id
        sendJson(res, 200, { ok: true, reply: '已发送到 DSH', pending: true })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/voice') {
        try {
          const result = await proxyVoice(req)
          res.writeHead(result.status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(result.body),
          })
          res.end(result.body)
        } catch (error) {
          sendJson(res, 502, { ok: false, error: `asr_unavailable: ${error}` })
        }
        return
      }

      sendJson(res, 404, { ok: false, error: 'not_found' })
    } catch (error) {
      ctx.logger?.warn?.(`[onepage-remote] ${error}`)
      sendJson(res, 500, { ok: false, error: 'internal' })
    }
  })

  // A permanent listener, so a later EADDRINUSE / socket error never becomes an
  // unhandled 'error' event that would take the DSH host down.
  server.on('error', (error) => {
    ctx.logger?.warn?.(`[onepage-remote] ${error}`)
  })

  void (async () => {
    let pluginPort
    try {
      pluginPort = await listenOn(server, PLUGIN_PORTS, '127.0.0.1')
    } catch (error) {
      ctx.logger?.warn?.(`[onepage-remote] cannot bind plugin port: ${error}`)
      return
    }
    runtime.pluginPort = pluginPort
    ctx.logger?.info?.(`[onepage-remote] plugin listening on 127.0.0.1:${pluginPort}`)

    let bridgePort
    for (const port of BRIDGE_PORTS) {
      if (port === pluginPort) continue
      if (await isFree(port, '0.0.0.0')) {
        bridgePort = port
        break
      }
    }
    if (bridgePort === undefined) {
      ctx.logger?.warn?.('[onepage-remote] no free bridge port in 8765-8770')
      return
    }

    bridge = startBridge(ctx, bridgePort, pluginPort)
  })()

  ctx.effect(() => () => {
    try {
      server.close()
    } catch {
      // already closed
    }
    if (bridge !== null) {
      bridge.child.kill()
      try {
        fs.closeSync(bridge.logFd)
      } catch {
        // already closed
      }
      bridge = null
    }
  })

  // Routes consumed by the in-DSH overlay (lib/client.js). Registered on the
  // host webServer so the browser fetches them same-origin.
  const diagHandler = async (req, res) => {
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'local_only' })
      return
    }
    const bridgeDiag = await bridgeFetch('/api/v1/diag')
    sendJson(res, 200, {
      ok: true,
      plugin: {
        port: runtime.pluginPort,
        bridgePort: runtime.bridgePort,
        bridgeStatus: runtime.bridgeStatus,
        uptimeSec: Math.round((Date.now() - runtime.startedAt) / 1000),
      },
      bridge: bridgeDiag,
    })
  }

  const sendHandler = async (req, res) => {
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'local_only' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
      return
    }
    let text = ''
    try {
      text = (await readJsonBody(req)).text ?? ''
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad_json' })
      return
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      sendJson(res, 400, { ok: false, error: 'empty_text' })
      return
    }
    const agent = pickAgent(ctx, lastSessionId)
    if (agent === undefined) {
      sendJson(res, 409, { ok: false, error: 'no_agent' })
      return
    }
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    lastSessionId = agent.id
    lastReply = '已发送到 DSH'
    ctx.logger?.info?.(`[onepage-remote] overlay 发送: ${text.slice(0, 60)}`)
    sendJson(res, 200, { ok: true, reply: '已发送到 DSH', pending: true })
  }

  const asrHandler = async (req, res) => {
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'local_only' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const result = await bridgeFetch('/api/v1/asr-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    sendJson(res, 200, result ?? { ok: false, error: 'bridge_down' })
  }

  const disposeRoute = (register) => (typeof ctx.effect === 'function' ? ctx.effect(register) : register())

  try {
    ctx.inject?.(['webServer'], (httpCtx) => {
      disposeRoute(() => httpCtx.webServer.register({ kind: 'exact', path: `${PLUGIN_PREFIX}/diag`, handler: diagHandler }))
      disposeRoute(() => httpCtx.webServer.register({ kind: 'exact', path: `${PLUGIN_PREFIX}/send`, handler: sendHandler }))
      disposeRoute(() => httpCtx.webServer.register({ kind: 'exact', path: `${PLUGIN_PREFIX}/asr`, handler: asrHandler }))
      ctx.logger?.info?.(`[onepage-remote] overlay 路由已注册: ${PLUGIN_PREFIX}/{diag,send,asr}`)
    })
  } catch (error) {
    ctx.logger?.warn?.(`[onepage-remote] 无法注册 overlay 路由: ${error}`)
  }
}
