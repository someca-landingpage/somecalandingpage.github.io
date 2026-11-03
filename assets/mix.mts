import { GoogleGenAI } from '@google/genai'
import { getStore } from '@netlify/blobs'
import type { Config, Context } from '@netlify/functions'

/* Prodotti Someca: per ognuno un'idea visiva da far generare all'AI */
const IDEE = [
  { prodotto: 'Finestre e infissi (PVC / alluminio)', titolo: 'Finestre in PVC', scena: 'a bright modern Italian living room with large white PVC tilt-and-turn windows, Mediterranean light' },
  { prodotto: 'Finestre e infissi (PVC / alluminio)', titolo: 'Infissi in alluminio', scena: 'minimal anthracite aluminium sliding windows opening onto a terrace overlooking the Vesuvius at sunset' },
  { prodotto: 'Finestre per tetti', titolo: 'Finestre per tetti', scena: 'a cozy attic bedroom with wooden beams and two roof windows letting in soft daylight' },
  { prodotto: 'Porte blindate', titolo: 'Porte blindate', scena: 'an elegant security front door with walnut wood panel and brushed steel handle in a refined apartment landing' },
  { prodotto: 'Porte da interno', titolo: 'Porte da interno', scena: 'a contemporary hallway with flush white lacquered interior doors and oak floor' },
  { prodotto: 'Portoni residenziali o industriali', titolo: 'Portoni sezionali', scena: 'a modern villa with a sleek grey sectional garage door and stone driveway' },
  { prodotto: 'Avvolgibili e tapparelle', titolo: 'Avvolgibili e tapparelle', scena: 'the facade of a southern Italian house with aluminium roller shutters half lowered in summer light' },
  { prodotto: 'Gazebi, pergole e tende', titolo: 'Pergole bioclimatiche', scena: 'a bioclimatic aluminium pergola with adjustable louvers on a garden terrace with lemon trees' },
]
const MAX_PER_IDEA = 3 /* varianti AI conservate per ogni prodotto */

const store = () => getStore({ name: 'mix-ai', consistency: 'strong' })

async function genera(idx: number, store: ReturnType<typeof getStore>) {
  const idea = IDEE[idx]
  const ai = new GoogleGenAI({
    apiKey: process.env.NETLIFY_AI_GATEWAY_KEY,
    httpOptions: { baseUrl: process.env.NETLIFY_AI_GATEWAY_URL?.replace(/\/$/, '') },
  })
  const res = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image',
    contents: `Photorealistic architectural interior/exterior photograph, ${idea.scena}. Natural light, high-end catalogue style, no text, no logos, no people, landscape 4:3.`,
  })
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
  if (!part?.inlineData?.data) return null
  const key = `img/${idx}-${Date.now()}`
  const bytes = Uint8Array.from(atob(part.inlineData.data), (c) => c.charCodeAt(0))
  await store.set(key, bytes, {
    metadata: { tipo: part.inlineData.mimeType || 'image/png', idx },
  })
  return key
}

const mescola = <T,>(a: T[]) => a.map((v) => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1])

export default async (req: Request, context: Context) => {
  const s = store()
  const url = new URL(req.url)

  /* Serve una singola immagine generata */
  const k = url.searchParams.get('img')
  if (k) {
    if (!k.startsWith('img/')) return new Response('Non trovata', { status: 404 })
    const r = await s.getWithMetadata(k, { type: 'arrayBuffer' })
    if (!r) return new Response('Non trovata', { status: 404 })
    return new Response(r.data, {
      headers: { 'Content-Type': String(r.metadata.tipo || 'image/png'), 'Cache-Control': 'public, max-age=31536000, immutable' },
    })
  }

  /* Elenco delle immagini AI disponibili, raggruppate per prodotto */
  const { blobs } = await s.list({ prefix: 'img/' })
  const perIdea = new Map<number, string[]>()
  for (const b of blobs) {
    const idx = Number(b.key.slice(4).split('-')[0])
    if (!perIdea.has(idx)) perIdea.set(idx, [])
    perIdea.get(idx)!.push(b.key)
  }

  /* Ad ogni apertura, se mancano varianti, ne genera una nuova (in background) */
  const mancanti = IDEE.map((_, i) => i).filter((i) => (perIdea.get(i)?.length || 0) < MAX_PER_IDEA)
  if (mancanti.length) {
    const scelta = mancanti[Math.floor(Math.random() * mancanti.length)]
    const lavoro = genera(scelta, s).catch((e) => console.error('Generazione AI non riuscita', e))
    /* se non c'è ancora nessuna immagine, aspetta la prima così il mix non è vuoto */
    if (blobs.length === 0) await lavoro
    else context.waitUntil(lavoro)
  }

  const finali = (await s.list({ prefix: 'img/' })).blobs.map((b) => b.key)
  const ai = mescola(finali).slice(0, 4).map((key) => {
    const idea = IDEE[Number(key.slice(4).split('-')[0])] || IDEE[0]
    return { src: `/api/mix?img=${encodeURIComponent(key)}`, titolo: idea.titolo, prodotto: idea.prodotto }
  })

  return Response.json({ ai }, { headers: { 'Cache-Control': 'no-store' } })
}

export const config: Config = { path: '/api/mix' }
