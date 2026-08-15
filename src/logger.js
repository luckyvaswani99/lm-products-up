import { EventEmitter } from 'node:events';

const COLORS = {
  gray: '\x1b[90m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};

const stamp = () => new Date().toISOString().slice(11, 19);
const paint = (c, s) => `${COLORS[c] || ''}${s}${COLORS.reset}`;

/** Log lines are also emitted so the web UI can stream them (see server.js). */
export const logBus = new EventEmitter();
logBus.setMaxListeners(50);

function emit(level, args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  logBus.emit('line', { level, text, time: stamp() });
}

export const log = {
  info: (...a) => (console.log(paint('gray', stamp()), ...a), emit('info', a)),
  step: (...a) => (console.log(paint('cyan', `${stamp()} ▸`), ...a), emit('step', a)),
  ok: (...a) => (console.log(paint('green', `${stamp()} ✓`), ...a), emit('ok', a)),
  warn: (...a) => (console.warn(paint('yellow', `${stamp()} !`), ...a), emit('warn', a)),
  error: (...a) => (console.error(paint('red', `${stamp()} ✗`), ...a), emit('error', a)),
};
