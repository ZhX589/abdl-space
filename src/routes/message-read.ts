export function resolveReadUpToId(readUpToId: number | undefined, latestReceivedId: number | null): number | null {
  return readUpToId ?? latestReceivedId
}
