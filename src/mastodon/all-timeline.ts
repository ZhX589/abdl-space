const EXHAUSTED_NBW_CURSOR = '!'

type TimelineStatus = { id: string; created_at: string }

export function mergeAllTimelinePage<T extends TimelineStatus>(
  abdlStatuses: T[],
  nbwStatuses: T[],
  friendStatuses: T[],
  limit: number,
  currentAbdlMaxId: number | undefined,
  currentNBWCursor: string,
  currentFriendMaxId: number | undefined,
  nbwHasMore: boolean,
  nextNBWCursor: string,
): { statuses: T[]; nextAbdlMaxId: number; nextNBWCursor: string; nextFriendMaxId: number; hasMore: boolean } {
  const statuses = [...abdlStatuses, ...nbwStatuses, ...friendStatuses]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit)

  const returnedIds = new Set(statuses.map((status) => status.id))
  const returnedAbdl = abdlStatuses.filter((status) => returnedIds.has(status.id))
  const returnedNBW = nbwStatuses.filter((status) => returnedIds.has(status.id))
  const returnedFriend = friendStatuses.filter((status) => returnedIds.has(status.id))
  const lastAbdl = returnedAbdl[returnedAbdl.length - 1]
  const lastNBW = returnedNBW[returnedNBW.length - 1]
  const lastFriend = returnedFriend[returnedFriend.length - 1]

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

  // 交友宇宙源：与 ABDL 本站帖一致的 id 滑窗推进
  const toFriendId = (id: string) => parseInt(id.replace(/^fr_/, ''))
  let nextFriendMaxId: number
  if (returnedFriend.length < friendStatuses.length) {
    nextFriendMaxId = lastFriend ? toFriendId(lastFriend.id) : currentFriendMaxId || 0
  } else if (friendStatuses.length < limit) {
    nextFriendMaxId = -1
  } else {
    nextFriendMaxId = lastFriend ? toFriendId(lastFriend.id) : currentFriendMaxId || 0
  }

  return {
    statuses,
    nextAbdlMaxId,
    nextNBWCursor: nextCursor,
    nextFriendMaxId,
    hasMore: nextAbdlMaxId !== -1 || nextCursor !== EXHAUSTED_NBW_CURSOR || nextFriendMaxId !== -1,
  }
}
