/** Test helpers shared by the kernel end-to-end suites. */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll until `probe` returns a truthy value or the deadline passes. */
export async function waitFor<T>(
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 150
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
      last = value
    } catch (error) {
      last = error
    }
    await delay(intervalMs)
  }
  throw new Error(`timed out waiting for ${options.label ?? 'condition'} (last=${String(last)})`)
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`)
  return (await response.json()) as T
}

export async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw new Error(`PUT ${url} -> HTTP ${response.status}: ${await response.text()}`)
  return (await response.json()) as T
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw new Error(`POST ${url} -> HTTP ${response.status}: ${await response.text()}`)
  return (await response.json()) as T
}
