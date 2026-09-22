import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCorpus } from './corpus'
import { productionImpl } from './harness'

runCorpus(productionImpl, join(dirname(fileURLToPath(import.meta.url)), 'fixtures'))
