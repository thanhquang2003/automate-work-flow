import { EventEmitter } from 'node:events';

/** Process-wide event bus. Emits 'event' {requestId,id,ts,level,message} and 'status' {requestId,stage,status}. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);
