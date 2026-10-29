/** Pure defer-membership retention helpers shared by delivery maintenance. */

/** Removes deferred-recheck entries whose owning pending intent no longer exists; returns how many were removed. */
export function pruneOrphanedDeferrals(
  deferred: Map<string, number>,
  pending: readonly { readonly id: string }[],
): number {
  const live = new Set(pending.map(item => item.id))
  let removed = 0
  for (const id of deferred.keys()) {
    if (live.has(id)) continue
    deferred.delete(id)
    removed += 1
  }
  return removed
}
