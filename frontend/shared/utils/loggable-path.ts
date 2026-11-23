/**
 * A request path as the server log may print it: a one-time login path keeps
 * its account id and loses its timestamp and hash, which sign the account in.
 */
export function loggablePath(path: string): string {
  return path.replace(/(\/user\/reset\/\d+)\/.*/i, '$1/…')
}
