import { serveMcp } from '../utils/mcp-endpoint'

/**
 * The MCP endpoint at its alias path, for clients configured with it.
 *
 * @deprecated The endpoint is `/mcp`. This path is removed after 1.0; nothing
 * links to it or documents it.
 */
export default serveMcp
