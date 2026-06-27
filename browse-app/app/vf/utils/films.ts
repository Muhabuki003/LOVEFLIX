import {
  LOVEFLIX_ENABLED,
  type LoveflixVideo,
  formatVideoDate,
  videoForCellId,
} from '../../loveflix/loveflix'
import type { VoroforceCell } from '../types'

export type FilmData = Record<string, string | number>
export type FilmBatch = FilmData[]
export type FilmBatches = Map<number, FilmBatch>

export class Film {
  tmdbId: number
  imdbId?: string
  title: string
  tagline?: string
  overview?: string
  genres?: string[]
  year: number
  rating: number
  popularity: number
  poster: string
  backdrop: string
  // LoveFlix: present when a cell maps to a couple's video (Browse tab).
  loveflix?: LoveflixVideo

  constructor(data: FilmData) {
    this.tmdbId = Number(data.id)
    this.imdbId = data.imdb_id ? String(data.imdb_id) : undefined
    this.title = String(data.title)
    this.tagline = data.tagline ? String(data.tagline) : undefined
    this.overview = data.overview ? String(data.overview) : undefined
    this.genres = data.genres ? String(data.genres).split(', ') : undefined
    this.year = Number(data.release_year)
    this.rating = Number(data.vote_average) * 10
    this.popularity = Number(data.popularity)
    this.poster = String(data.poster_path)
    this.backdrop = String(data.backdrop_path)
  }

  static fromLoveflix(video: LoveflixVideo): Film {
    const year = Number((video.date || '').slice(0, 4)) || 0
    const film = new Film({
      id: 0,
      title: video.title,
      release_year: year,
      poster_path: video.thumbnail_url,
      backdrop_path: video.thumbnail_url,
      vote_average: 0,
      popularity: 0,
      // Reuse the upstream preview fields: category → genre badge, date label
      // → tagline line above the title.
      genres: video.category || '',
      tagline: formatVideoDate(video.date),
    })
    film.loveflix = video
    // Populate tags from video metadata instead of movie genres
    film.genres = []
    if (video.category) {
      film.genres.push(video.category)
    }
    const dur = video.duration_seconds || 0
    const mins = Math.floor(dur / 60)
    const secs = dur % 60
    const durStr = mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`
    film.genres.push(durStr)
    // Use tagline for date if available
    if (video.date) {
      film.tagline = video.date
    }
    return film
  }
}

const loadCellFilmBatch = async (batchIndex: number) => {
  const url = `${import.meta.env.VITE_FILM_INFO_BASE_URL}/${batchIndex}.json`
  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`)
    }
    return await response.json()
  } catch (error) {
    console.log('batchIndex', batchIndex)
    console.error('Error loading JSON:', error)
  }
}

export const getCellFilm = async (
  cell: VoroforceCell,
  filmBatches: FilmBatches,
) => {
  if (!cell) return

  // LoveFlix: resolve the cell to a couple's video by the same id the texture
  // loader uses (cell.id), so the detail panel always matches the thumbnail.
  if (LOVEFLIX_ENABLED) {
    const id = (cell.id ?? cell.index ?? 0) as number
    const video = videoForCellId(id)
    return video ? Film.fromLoveflix(video) : undefined
  }

  let filmBatch = filmBatches.get(cell.subgrid)
  if (!filmBatch) {
    filmBatch = await loadCellFilmBatch(cell.subgrid)
    filmBatches.set(cell.subgrid, filmBatch ?? [])
  }

  return filmBatch?.[cell.subgridIndex]
    ? new Film(filmBatch[cell.subgridIndex])
    : undefined
}
