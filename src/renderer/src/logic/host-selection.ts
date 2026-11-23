export function selectHosts(order: string[], selected: string[], anchor: string | null, id: string, extend: boolean, toggle: boolean): string[] {
  if (extend && anchor && order.includes(anchor) && order.includes(id)) {
    const a = order.indexOf(anchor), b = order.indexOf(id), range = order.slice(Math.min(a, b), Math.max(a, b) + 1)
    return toggle ? [...new Set([...selected, ...range])] : range
  }
  if (toggle) return selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]
  return [id]
}

export function orderedSelection(order: string[], selected: string[]): string[] {
  const wanted = new Set(selected)
  return order.filter(id => wanted.has(id))
}
