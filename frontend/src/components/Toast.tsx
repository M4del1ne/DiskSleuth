// Small notifications at the bottom of the window: toast('Copied') from anywhere, <Toaster /> renders them once in App.
import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck } from 'lucide-react'

type Kind = 'ok' | 'error'
interface Item { id: number; text: string; kind: Kind }

let seq = 0
const listeners = new Set<(i: Item) => void>()

export function toast(text: string, kind: Kind = 'ok') {
  const item = { id: ++seq, text, kind }
  listeners.forEach((f) => f(item))
}

export function Toaster() {
  const [items, setItems] = useState<Item[]>([])
  useEffect(() => {
    const add = (i: Item) => {
      setItems((xs) => [...xs.slice(-2), i])
      window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== i.id)), i.kind === 'error' ? 5000 : 1800)
    }
    listeners.add(add)
    return () => { listeners.delete(add) }
  }, [])
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((i) => (
        <div key={i.id} className={`toast ${i.kind}`}>
          {i.kind === 'ok' ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
          <span>{i.text}</span>
        </div>
      ))}
    </div>
  )
}
