/**
 * Small shared hooks: async data loading with error surfacing, and a URL query
 * string backed state used to keep the selected session in the address bar.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DependencyList } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiErrorMessage } from './api'

export interface AsyncData<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** Re-runs the loader. */
  reload: () => void
  /** Local mutation, e.g. merging a WebSocket push into a fetched list. */
  setData: (updater: T | ((prev: T | null) => T | null)) => void
}

/**
 * Loads data on mount and whenever `deps` or a manual `reload()` change.
 * Errors are captured into `error` (never thrown) so pages keep rendering.
 */
export function useAsyncData<T>(loader: () => Promise<T>, deps: DependencyList): AsyncData<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const loaderRef = useRef(loader)
  useEffect(() => {
    loaderRef.current = loader
  })

  useEffect(() => {
    let alive = true
    setLoading(true)
    loaderRef
      .current()
      .then((value) => {
        if (!alive) return
        setData(value)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(apiErrorMessage(err))
      })
      .finally(() => {
        if (!alive) return
        setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const reload = useCallback(() => setTick((value) => value + 1), [])
  const update = useCallback((updater: T | ((prev: T | null) => T | null)) => {
    setData((prev) => (typeof updater === 'function' ? (updater as (p: T | null) => T | null)(prev) : updater))
  }, [])

  return { data, loading, error, reload, setData: update }
}

/** Reads/writes a query string parameter while keeping the rest of the URL. */
export function useQueryParam(key: string): [string | null, (value: string | null) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get(key)
  const set = useCallback(
    (next: string | null) => {
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev)
          if (next === null || next === '') copy.delete(key)
          else copy.set(key, next)
          return copy
        },
        { replace: true },
      )
    },
    [key, setParams],
  )
  return [value, set]
}

/** Re-renders on an interval; used for relative timestamps and log clocks. */
export function useTicker(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}
