import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
const WIKI = process.env.WIKI || (execSync('npm root -g').toString().trim() + '/wiki')
const express = createRequire(WIKI + '/index.js')('express')
const mb = () => process.memoryUsage().heapUsed / 1048576
const b0 = mb()
const { startServer } = await import(new URL('../server/server.js', import.meta.url).href)
const app = express(); startServer({ app, argv: { status: '/tmp/x/status', data: '/tmp/x' } })
const b1 = mb()
const srv = app.listen(0); const port = srv.address().port
let ok = 0, bad = 0; const t = (n, c) => { c ? ok++ : bad++; console.log((c ? '  ok   ' : '  FAIL ') + n) }
const get = u => fetch(`http://127.0.0.1:${port}${u}`).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }))

t('start-up heap is small (' + (b1 - b0).toFixed(1) + ' MB, was 14.4)', (b1 - b0) < 3)
let r = await get('/system/unfurl.json?url=https://example.com')
const b2 = mb()
t('unfurl still works: title "' + (r.j && r.j.title) + '"', r.s === 200 && r.j && r.j.title === 'Example Domain')
t('libraries loaded on first request (+' + (b2 - b1).toFixed(1) + ' MB now)', (b2 - b1) > 5)
r = await get('/system/unfurl.json?url=https://example.com')
const b3 = mb()
t('second request: cached import, no further growth (+' + (b3 - b2).toFixed(2) + ' MB)', (b3 - b2) < 1)
r = await get('/system/unfurl.json?url=http://127.0.0.1/secret')
t('SSRF guard still refuses loopback (fallback card, no fetched content)', r.s === 200 && r.j && r.j.title === '127.0.0.1' && r.j.description === '' && !r.j.image)
r = await get('/system/unfurl.json?url=http://10.0.0.1/')
t('… and private range', r.j && r.j.title === '10.0.0.1' && r.j.description === '')
// ── redirect SSRF: a *public-looking* origin that 302s to loopback ────────────
// We cannot stand up a truly public host in a test, so exercise safeFetch
// directly: it must refuse the hop, not the starting URL.
{
  const http = await import('node:http')
  const evil = http.createServer((q, s) => { s.writeHead(302, { Location: 'http://127.0.0.1:1/secret' }); s.end() })
  await new Promise(res => evil.listen(0, '127.0.0.1', res))
  const eport = evil.address().port
  // starting URL is loopback too, so assertPublicUrl refuses at hop 0 — good, but that
  // does not test the redirect. So call safeFetch with a guard-bypassing first hop:
  // temporarily point at the server via a name that resolves public? Not available offline.
  // Instead prove the mechanism: manual redirects are followed only through the guard.
  const mod = await import(new URL('../server/server.js', import.meta.url).href)
  const sf = mod.__safeFetchForTest
  let refused = false
  try { await sf(`http://127.0.0.1:${eport}/`, {}) } catch (e) { refused = /blocked|private|internal/.test(e.message) }
  t('safeFetch refuses a loopback hop (mechanism)', refused)
  // and a plain fetch with redirect:'follow' WOULD have followed — the thing we replaced
  const followed = await fetch(`http://127.0.0.1:${eport}/`, { redirect: 'manual' }).then(r => r.status)
  t('… where the raw server really does 302 to loopback', followed === 302)
  evil.close()
}
srv.close(); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0)
