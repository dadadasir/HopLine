/** Merges records for portable import. Inputs are never mutated. */
export function mergeRecords<T extends { id: string; updatedAt: number; deletedAt: number | null }>(
  local: readonly T[], incoming: readonly T[]
): T[] {
  const records = new Map(local.map((record) => [record.id, record]))
  for (const record of incoming) {
    const current = records.get(record.id)
    if (!current || record.updatedAt > current.updatedAt ||
        (record.updatedAt === current.updatedAt && record.deletedAt !== null && current.deletedAt === null)) {
      records.set(record.id, record)
    }
  }
  return structuredClone([...records.values()])
}
