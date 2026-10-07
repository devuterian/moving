/**
 * Remembers the last opened video in IndexedDB so reopening the site brings
 * it straight back. Everything stays on this device. Failures (quota, private
 * mode) are swallowed: this is a convenience, not a requirement.
 */

const DB_NAME = 'scrubber'
const STORE = 'lastVideo'
const KEY = 'current'

type Saved = { blob: Blob; name: string; type: string; lastModified: number }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error)
    })
  } finally {
    db.close()
  }
}

export async function saveLastVideo(file: File) {
  try {
    // Ask the browser not to evict it under storage pressure (best effort).
    void navigator.storage?.persist?.()
    const saved: Saved = {
      blob: file,
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
    }
    await run('readwrite', (s) => s.put(saved, KEY))
  } catch (err) {
    console.warn('Could not remember this video', err)
  }
}

export async function loadLastVideo(): Promise<File | null> {
  try {
    const saved = await run<Saved | undefined>('readonly', (s) => s.get(KEY))
    if (!saved?.blob) return null
    return new File([saved.blob], saved.name, { type: saved.type, lastModified: saved.lastModified })
  } catch {
    return null
  }
}
