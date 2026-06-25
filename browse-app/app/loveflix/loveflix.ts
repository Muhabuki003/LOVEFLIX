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
// Cached by the main app (assets/loveflix.js) after sign-in: the couple
// creator's (admin's) auth user id, which is the tenant key every video is
// stored under. Same-origin, so the /browse/ sub-app shares it.
const CREATOR_KEY = 'loveflix_creator_id'

// Public Supabase project values (same as wrangler.toml / loveflix.js). Used
// only as a fallback to resolve the couple tenant when CREATOR_KEY isn't cached
// yet — e.g. an invited partner who landed straight on /browse/.
const SUPABASE_URL = 'https://jeblgjjutyzzdursjqnn.supabase.co'
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImplYmxnamp1dHl6emR1cnNqcW5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMzY0NjgsImV4cCI6MjA5MzcxMjQ2OH0.X9YVrfLJ4JSIBdXVkpYegeZ5kEqJzkmzQ1P0d3tFoko'

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

// Decode the `sub` (auth user id) from a Supabase JWT without verifying it.
const parseJwtUserId = (token: string): string | null => {
  try {
    const payload = token.split('.')[1]
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const parsed = JSON.parse(json) as { sub?: string }
    return parsed.sub ?? null
  } catch {
    return null
  }
}

// Resolve the couple tenant id (the admin/creator's user id). Videos are
// scoped by tenant, and /api/videos defaults the tenant to the *caller's* own
// id when no x-tenant-id is sent — which is empty for an invited partner. So we
// must forward the creator id, mirroring assets/loveflix.js `api()`.
const resolveTenantId = async (token: string | null): Promise<string | null> => {
  try {
    const cached = localStorage.getItem(CREATOR_KEY)
    if (cached) return cached
  } catch {}
  if (!token) return null

  const userId = parseJwtUserId(token)
  if (!userId) return null

  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/couple_members?user_id=eq.${encodeURIComponent(userId)}&select=couple_id,role&limit=1`,
      { headers },
    )
    if (!res.ok) return null
    const rows = (await res.json()) as Array<{ couple_id?: string; role?: string }>
    const row = rows?.[0]
    if (!row) return null
    // The admin is the tenant owner.
    if (row.role === 'admin') {
      try {
        localStorage.setItem(CREATOR_KEY, userId)
      } catch {}
      return userId
    }
    // Partner: look up the couple's admin user id.
    if (row.couple_id) {
      const res2 = await fetch(
        `${SUPABASE_URL}/rest/v1/couple_members?couple_id=eq.${encodeURIComponent(row.couple_id)}&role=eq.admin&select=user_id&limit=1`,
        { headers },
      )
      if (res2.ok) {
        const admins = (await res2.json()) as Array<{ user_id?: string }>
        const adminId = admins?.[0]?.user_id
        if (adminId) {
          try {
            localStorage.setItem(CREATOR_KEY, adminId)
          } catch {}
          return adminId
        }
      }
    }
  } catch {}
  return null
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
    const tenantId = await resolveTenantId(token)
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    // Forward the couple tenant so an invited partner sees the couple's videos
    // (not their own empty tenant).
    if (tenantId) headers['x-tenant-id'] = tenantId
    const res = await fetch('/api/videos', { headers, signal })
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
    return `${url.replace('/object/public/', '/render/image/public/')}${sep}width=512&quality=70`
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

// Format a stored date ("2026-06-25" or ISO) into a short human label.
export const formatVideoDate = (date: string): string => {
  if (!date) return ''
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return date
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

export type TileLabel = { title: string; meta: string }

// Text baked into each tile's thumbnail by the loader (keyed by layerIndex ===
// cell.id). Kept tiny: a title plus a "Category · Date" line.
export const labelForIndex = (index: number): TileLabel | undefined => {
  const v = videoForCellId(index)
  if (!v) return undefined
  const meta = [v.category, formatVideoDate(v.date)].filter(Boolean).join(' · ')
  return { title: v.title || 'Untitled', meta }
}
