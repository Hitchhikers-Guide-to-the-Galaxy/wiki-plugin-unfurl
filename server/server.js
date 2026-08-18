// wiki-plugin-unfurl — a link-preview Outpost service. ESM.
//
// GET /system/unfurl.json?url=… → a normalised static card
//   { url, title, description, provider, author, type, image, favicon, source }
//
// This is the server half that used to live inside wiki-plugin-hitchhiker.
// It carries the two heavy extractor libraries (open-graph-scraper and
// @extractus/oembed-extractor, ~14 MB of heap when loaded), so it is meant to
// be installed on ONE well-resourced host — an Outpost — and called by
// wiki-plugin-hitchhiker on every other farm, which carries no libraries at
// all. A farm that cannot reach an Outpost returns the minimal card; nothing
// depends on this being present.
//
// oEmbed metadata first, OpenGraph/Twitter/JSON-LD fallback. Metadata only —
// never the oEmbed HTML embed. The thumbnail is fetched server-side and
// inlined as a data: URI so the card makes zero client→provider requests.
//
// SSRF: public http/https only; private, loopback and link-local ranges and
// *.localhost/.local/.internal refused before any fetch. The OpenGraph and
// image fetches walk redirects by hand and re-check every hop (safeFetch); the
// oEmbed endpoint hop remains the library's own — see fromOembed. Do not
// expose this on a public IP without an API key in front of it (see the Farm
// Gate convention): it is, by design, a service that fetches what it is told to.
//
// Imports are lazy so a host that installs this but never unfurls still pays
// nothing at start-up.

import dns from 'node:dns/promises'
import net from 'node:net'

// The two extractor libraries are imported on first use, not at start-up.
// Together they load about 14 MB of heap — eighty per cent of the memory of
// every plugin server on the farm combined — and this server is resident in
// the shared process on every site of the host, whether or not anything ever
// asks for a link preview. Lazy import means a host that never unfurls never
// pays. Each import is awaited once and cached, so the second request costs
// nothing; a failed import is not cached, so a transient error does not stick.
let ogsP = null
const ogs = (...a) => (ogsP ||= import('open-graph-scraper').then(m => m.default, e => { ogsP = null; throw e })).then(f => f(...a))
let oembedP = null
const oembedExtract = (...a) =>
  (oembedP ||= import('@extractus/oembed-extractor').then(m => m.extract, e => { oembedP = null; throw e })).then(f => f(...a))

const CACHE = new Map()
const TTL = 1000 * 60 * 30 // 30 minutes
const FETCH_MS = 8000
const MAX_IMAGE_BYTES = 300 * 1024

// ── SSRF guard ────────────────────────────────────────────────────────────────
const isPrivateIp = ip => {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a >= 224
    )
  }
  const s = ip.toLowerCase()
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')
}

const assertPublicUrl = async raw => {
  const u = new URL(raw) // throws on bad url
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol not allowed')
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error('internal host blocked')
  // Literal-IP hosts are range-checked directly; names are resolved first.
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true })
  for (const { address } of addrs) if (isPrivateIp(address)) throw new Error('private address blocked')
  return u
}

// ── a fetch that re-checks every hop ─────────────────────────────────────────
// redirect:'follow' would let a public host 302 us onto 127.0.0.1 after the
// guard has already passed the starting URL. So follow by hand: manual
// redirects, assertPublicUrl on each Location, and a small hop cap.
const MAX_HOPS = 4
const safeFetch = async (raw, init = {}) => {
  let url = raw
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await assertPublicUrl(url)
    const r = await fetch(url, { ...init, redirect: 'manual' })
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location')
      if (!loc) return r
      url = new URL(loc, url).href
      continue
    }
    return r
  }
  throw new Error('too many redirects')
}

export const __safeFetchForTest = (...a) => safeFetch(...a)

// ── thumbnail → data URI (no client→provider request when the card renders) ───
const inlineImage = async imgUrl => {
  if (!imgUrl) return ''
  try {
    const r = await safeFetch(imgUrl, { signal: AbortSignal.timeout(FETCH_MS) })
    if (!r.ok) return ''
    const type = r.headers.get('content-type') || ''
    if (!/^image\//i.test(type)) return ''
    const len = Number(r.headers.get('content-length') || 0)
    if (len && len > MAX_IMAGE_BYTES) return ''
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > MAX_IMAGE_BYTES) return ''
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

// ── extractors ────────────────────────────────────────────────────────────────
const fromOembed = async url => {
  try {
    // Residual: the extractor discovers an oEmbed endpoint from the page and
    // fetches it with its own client. The starting URL is checked by the route,
    // the thumbnail it returns is re-checked by inlineImage, but the endpoint
    // hop itself is the library's. Acceptable on a host that only unfurls
    // public URLs; not acceptable as the only guard. Hence the redirect-checked
    // path for OpenGraph and the image, which are the two fetches we control.
    const d = await oembedExtract(url, {}, { signal: AbortSignal.timeout(FETCH_MS) })
    if (!d) return null
    return {
      title: d.title || d.author_name || '',
      description: '',
      provider: d.provider_name || '',
      author: d.author_name || '',
      type: d.type || 'rich',
      thumb: d.thumbnail_url || '',
      source: 'oembed',
    }
  } catch {
    return null // not an oEmbed provider (or fetch failed) → fall back
  }
}

const fromOpenGraph = async url => {
  try {
    // Walk redirects ourselves so every hop is checked, then hand the library
    // the final URL with redirects off. It cannot be led anywhere we did not look.
    const probe = await safeFetch(url, { method: 'GET', signal: AbortSignal.timeout(FETCH_MS) })
    const finalUrl = probe.url || url
    const r = await ogs({ url: finalUrl, fetchOptions: { signal: AbortSignal.timeout(FETCH_MS), redirect: 'manual' } })
    if (!r || r.error || !r.result) return null
    const x = r.result
    const img =
      (Array.isArray(x.ogImage) && x.ogImage[0] && x.ogImage[0].url) ||
      (Array.isArray(x.twitterImage) && x.twitterImage[0] && x.twitterImage[0].url) ||
      ''
    return {
      title: x.ogTitle || x.twitterTitle || x.dcTitle || '',
      description: x.ogDescription || x.twitterDescription || '',
      provider: x.ogSiteName || '',
      author: x.author || '',
      type: x.ogType || 'website',
      thumb: img,
      favicon: x.favicon || '',
      source: 'opengraph',
    }
  } catch {
    return null
  }
}

// ── route ─────────────────────────────────────────────────────────────────────
export const startServer = ({ app, argv }) => {
  console.log('[wiki-plugin-unfurl] registering GET /system/unfurl.json')

  const cors = res => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  }

  app.options('/system/unfurl.json', (req, res) => {
    cors(res)
    res.sendStatus(204)
  })

  app.get('/system/unfurl.json', async (req, res) => {
    cors(res)
    const url = String(req.query.url || '')
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {}

    const hit = CACHE.get(url)
    if (hit && Date.now() - hit.t < TTL) return res.json(hit.v)

    let card
    try {
      await assertPublicUrl(url)
      const meta = (await fromOembed(url)) || (await fromOpenGraph(url)) || {}
      const image = await inlineImage(meta.thumb)
      card = {
        url,
        title: meta.title || host || url,
        description: meta.description || '',
        provider: meta.provider || host || '',
        author: meta.author || '',
        type: meta.type || 'link',
        image,
        favicon: meta.favicon || '',
        source: meta.source || 'fallback',
      }
    } catch (e) {
      // Graceful degradation (bad/blocked/offline URL) — always return a card.
      card = {
        url,
        title: host || url,
        description: '',
        provider: host,
        author: '',
        type: 'link',
        image: '',
        favicon: '',
        source: 'error',
        error: String((e && e.message) || e),
      }
    }
    CACHE.set(url, { t: Date.now(), v: card })
    res.json(card)
  })
}
