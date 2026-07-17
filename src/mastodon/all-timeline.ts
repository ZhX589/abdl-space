const EXHAUSTED_NBW_CURSOR = '!'

type TimelineStatus = { id: string; created_at: string }

export function mergeAllTimelinePage<T extends TimelineStatus>(
  abdlStatuses: T[],
  nbwStatuses: T[],
  limit: number,
  currentAbdlMaxId: number | undefined,
  currentNBWCursor: string,
  nbwHasMore: boolean,
  nextNBWCursor: string,
): { statuses: T[]; nextAbdlMaxId: number; nextNBWCursor: string; hasMore: boolean } {
  const statuses = [...abdlStatuses, ...nbwStatuses]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit)

  const returnedIds = new Set(statuses.map((status) => status.id))
  const returnedAbdl = abdlStatuses.filter((status) => returnedIds.has(status.id))
  const returnedNBW = nbwStatuses.filter((status) => returnedIds.has(status.id))
  const lastAbdl = returnedAbdl[returnedAbdl.length - 1]
  const lastNBW = returnedNBW[returnedNBW.length - 1]

  let nextAbdlMaxId: number
  if (returnedAbdl.length < abdlStatuses.length) {
    nextAbdlMaxId = lastAbdl ? parseInt(lastAbdl.id.replace(/^p_/, '')) : currentAbdlMaxId || 0
  } else if (abdlStatuses.length < limit) {
    nextAbdlMaxId = -1
  } else {
    nextAbdlMaxId = lastAbdl ? parseInt(lastAbdl.id.replace(/^p_/, '')) : currentAbdlMaxId || 0
  }

  let nextCursor: string
  if (returnedNBW.length < nbwStatuses.length) {
    if (lastNBW) {
      const tid = lastNBW.id.replace(/^nbw_/, '')
      nextCursor = `${Math.floor(new Date(lastNBW.created_at).getTime() / 1000)}_${tid}`
    } else {
      nextCursor = currentNBWCursor
    }
  } else if (nbwHasMore && nextNBWCursor && nextNBWCursor !== currentNBWCursor) {
    nextCursor = nextNBWCursor
  } else {
    nextCursor = EXHAUSTED_NBW_CURSOR
  }

  return {
    statuses,
    nextAbdlMaxId,
    nextNBWCursor: nextCursor,
    hasMore: nextAbdlMaxId !== -1 || nextCursor !== EXHAUSTED_NBW_CURSOR,
  }
}
