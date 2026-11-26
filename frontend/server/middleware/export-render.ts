import { defineEventHandler } from 'h3'
import { markExportRender } from '../utils/export-render'

/** Recognizes the page export's own render of the read page. */
export default defineEventHandler((event) => {
  markExportRender(event)
})
