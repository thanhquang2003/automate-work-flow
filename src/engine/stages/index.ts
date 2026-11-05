import { registerStage } from '../pipeline.js';
import { analysis } from './analysis.js';
import { breakdown } from './breakdown.js';
import { bugfix } from './bugfix.js';
import { change } from './change.js';
import { clarify } from './clarify.js';
import { codebaseScan } from './codebase-scan.js';
import { design } from './design.js';
import { develop } from './develop.js';
import { done } from './done.js';
import { intake } from './intake.js';
import { planning } from './planning.js';
import { test } from './test.js';

/** Registers every stage handler. */
export function registerAllStages(): void {
  registerStage('INTAKE', intake, { gate: false });
  registerStage('CODEBASE_SCAN', codebaseScan, { gate: true });
  registerStage('ANALYSIS', analysis, { gate: true });
  registerStage('CLARIFY', clarify, { gate: false });
  registerStage('BREAKDOWN', breakdown, { gate: true });
  registerStage('DESIGN', design, { gate: true });
  registerStage('PLANNING', planning, { gate: true });
  // Gate only after the last task (one task per job run, re-enqueued via goto which skips gates).
  registerStage('DEVELOP', develop, { gate: true });
  registerStage('TEST', test, { gate: false });
  registerStage('BUGFIX', bugfix, { gate: false });
  registerStage('DONE', done, { gate: false });
  // The pipeline owns the CHANGE gate (per-CR decisions or auto-accept, see Pipeline.afterChange).
  registerStage('CHANGE', change, { gate: false });
}
