// LoveFlix integration for the Voroforce Browse gallery.
//
// This module is the single bridge between the upstream "nothing-to-watch"
// engine and LoveFlix. It:
//   - loads the signed-in couple's videos from the LoveFlix API (D1-backed),
//   - exposes index-keyed lookups so each Voronoi cell renders a real video
//     thumbnail (texture) and resolves to the matching video (metadata),
//   - filling the cell count with duplicates via modulo as the engine expects.
//
// Auth: LoveFlix stores a Supabase access token in localStorage under
// 'loveflix_token'. The Browse sub-app is served same-origin (/browse/), so it
// shares that token and calls /api/videos with a Bearer header.

export const LOVEFLIX_ENABLED =
  import.meta.env.VITE_LOVEFLIX_BROWSE_ENABLED === '1'

const TOKEN_KEY = 'loveflix_token'

export type LoveflixVideo = {
  id: string
  title: string
  thumbnail_url: string
  video_url: string
  date: string
  duration_seconds: number
  category: string
  is_favorite: boolean
}

let videos: LoveflixVideo[] = []
let loadPromise: Promise<LoveflixVideo[]> | null = null
let loadError: Error | null = null

export const getToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

const mapVideo = (v: Record<string, unknown>): LoveflixVideo => ({
  id: String(v.id ?? ''),
  title: String(v.title ?? 'Untitled'),
  thumbnail_url: typeof v.thumbnail_url === 'string' ? v.thumbnail_url : '',
  video_url: typeof v.video_url === 'string' ? v.video_url : '',
  date: typeof v.date === 'string' ? v.date : '',
  duration_seconds: Number(v.duration_seconds ?? 0) || 0,
  category: typeof v.category === 'string' ? v.category : '',
  is_favorite: Boolean(v.is_favorite),
})

export const loadLoveflixVideos = (
  signal?: AbortSignal,
): Promise<LoveflixVideo[]> => {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const token = getToken()
    const res = await fetch('/api/videos', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    })
    if (!res.ok) throw new Error(`/api/videos ${res.status}`)
    const data = (await res.json()) as { videos?: Record<string, unknown>[] }
    videos = (data.videos ?? [])
      .map(mapVideo)
      // Only show videos that actually have a thumbnail to render as a cell.
      .filter((v) => v.thumbnail_url)
    return videos
  })().catch((e) => {
    loadError = e as Error
    videos = []
    throw e
  })
  return loadPromise
}

export const getLoveflixVideos = (): LoveflixVideo[] => videos
export const getLoveflixError = (): Error | null => loadError
export const hasLoveflixVideos = (): boolean => videos.length > 0

const mod = (i: number, n: number): number => ((i % n) + n) % n

// Append a lightweight Supabase image transform when the thumbnail is served
// from Supabase Storage (cells are small — no need for full-res). R2 public
// URLs and others are returned untouched to avoid breaking unknown CDNs.
const withThumbTransform = (url: string): string => {
  if (url.includes('/storage/v1/object/public/')) {
    const sep = url.includes('?') ? '&' : '?'
    return `${url.replace('/object/public/', '/render/image/public/')}${sep}width=220&quality=60`
  }
  return url
}

// Route the thumbnail through a same-origin proxy so the WebGL loader's
// cross-origin fetch isn't blocked by CORS or the page's COEP (require-corp).
const proxied = (url: string): string =>
  `/api/thumb?u=${encodeURIComponent(url)}`

// Texture lookup: the loader calls this with layerIndex === cell.id.
export const thumbUrlForIndex = (index: number): string => {
  if (!videos.length) return ''
  return proxied(withThumbTransform(videos[mod(index, videos.length)].thumbnail_url))
}

// Metadata lookup for a focused/selected cell. Texture and metadata both key
// off cell.id so the panel always matches the thumbnail on screen.
export const videoForCellId = (id: number): LoveflixVideo | undefined => {
  if (!videos.length) return undefined
  return videos[mod(id, videos.length)]
}
