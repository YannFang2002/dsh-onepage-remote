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

export const name = 'dsh-onepage-remote'
export const inject = ['agents', 'sessions']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_PORTS = [8766, 8767, 8768, 8769, 8770]
const BRIDGE_PORTS = [8765, 8766, 8767, 8768, 8769, 8770]

const DEFAULT_PYTHON =
  process.env.ONEPAGE_BRIDGE_PYTHON ??
  'C:/Users/yyoung/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe'
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

  child.on('exit', (code, signal) => {
    ctx.logger?.warn?.(`[onepage-remote] bridge exited code=${code} signal=${signal}`)
  })
  child.on('error', (error) => {
    ctx.logger?.warn?.(`[onepage-remote] bridge spawn failed: ${error}`)
  })

  ctx.logger?.info?.(`[onepage-remote] bridge on 8765-8770 -> ${bridgePort}, log ${logPath}`)
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
}
