// Worker thread of the skills estimate (src/econ/skills-estimate.ts): runs the loading audit away from the server's event loop and reports two numbers.
import { parentPort, workerData } from 'node:worker_threads';
import { auditLoading } from '../core/loading.ts';

const a = auditLoading((workerData as { root: string }).root);
parentPort?.postMessage({ claude: a.totals.claude.now, codex: a.totals.codex.now });
