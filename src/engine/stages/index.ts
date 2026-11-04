import { registerStage } from '../pipeline.js';
import { analysis } from './analysis.js';
import { breakdown } from './breakdown.js';
import { clarify } from './clarify.js';
import { codebaseScan } from './codebase-scan.js';
import { design } from './design.js';
import { intake } from './intake.js';

/** Registers every stage handler. Later stages are added by later tasks. */
export function registerAllStages(): void {
  registerStage('INTAKE', intake, { gate: false });
  registerStage('CODEBASE_SCAN', codebaseScan, { gate: true });
  registerStage('ANALYSIS', analysis, { gate: true });
  registerStage('CLARIFY', clarify, { gate: false });
  registerStage('BREAKDOWN', breakdown, { gate: true });
  registerStage('DESIGN', design, { gate: true });
}
