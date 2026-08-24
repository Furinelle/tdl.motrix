const ARIA2_GID = /^[0-9a-f]{16}$/

export function isAria2Gid(value) {
  return typeof value === 'string' && ARIA2_GID.test(value)
}
