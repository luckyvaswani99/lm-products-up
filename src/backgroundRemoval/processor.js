import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../logger.js';
import {
  BACKGROUND_REMOVAL_CONCURRENCY,
  BACKGROUND_REMOVAL_MODEL,
  BACKGROUND_REMOVAL_THREADS,
  backgroundRemovalModelDir,
  backgroundRemovalModelPath,
  loadBackgroundRemovalSettings,
} from './settings.js';

const workerScript = fileURLToPath(new URL('./worker.py', import.meta.url));
const requestTimeoutMs = 5 * 60 * 1000;
const idleTimeoutMs = 60 * 1000;
let worker = null;
let stdoutBuffer = '';
let stderrBuffer = '';
let requestSequence = 0;
let idleTimer = null;
let renderQueue = Promise.resolve();
// Set once the worker proves it cannot start at all, so every later photo is
// refused with that reason instead of repeating the whole failed startup.
let startupFailure = null;
const pending = new Map();

function localPythonCandidates() {
  const configured = String(process.env.BACKGROUND_REMOVAL_PYTHON || '').trim();
  return [
    configured || null,
    path.join(config.root, '.venv-background-removal', 'Scripts', 'python.exe'),
    path.join(config.root, '.venv-background-removal', 'bin', 'python'),
  ].filter(Boolean);
}

export function resolveBackgroundRemovalPython() {
  return localPythonCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

export function assertBackgroundRemovalAvailable() {
  const pythonPath = resolveBackgroundRemovalPython();
  if (!pythonPath) {
    throw new Error(
      'Background removal is not installed. Create .venv-background-removal and install requirements-background-removal.txt first.',
    );
  }
  return pythonPath;
}

export function getBackgroundRemovalState() {
  const settings = loadBackgroundRemovalSettings();
  const pythonPath = resolveBackgroundRemovalPython();
  const modelCached = fs.existsSync(backgroundRemovalModelPath);
  return {
    settings,
    engine: {
      provider: 'rembg CPU / ONNX Runtime',
      model: BACKGROUND_REMOVAL_MODEL,
      concurrency: BACKGROUND_REMOVAL_CONCURRENCY,
      threads: BACKGROUND_REMOVAL_THREADS,
      environmentReady: !!pythonPath,
      modelCached,
      modelBytes: modelCached ? fs.statSync(backgroundRemovalModelPath).size : 0,
      firstRunDownloadsModel: !modelCached,
    },
  };
}

export function getBackgroundRemovalRuntime() {
  const settings = loadBackgroundRemovalSettings();
  if (!settings.enabled) return null;
  return {
    settings,
    pythonPath: assertBackgroundRemovalAvailable(),
    modelDir: backgroundRemovalModelDir,
  };
}

export function shouldRemoveBackground(runtime, imageIndex) {
  if (!runtime) return false;
  return runtime.settings.applyTo === 'all' || imageIndex === 0;
}

function rejectPending(error) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
}

function stopWorker() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!worker) return;
  const active = worker;
  worker = null;
  active.kill();
}

function scheduleIdleStop() {
  clearTimeout(idleTimer);
  if (pending.size) return;
  idleTimer = setTimeout(() => {
    stopWorker();
    log.info('  background-removal worker stopped after 60 seconds idle');
  }, idleTimeoutMs);
  idleTimer.unref?.();
}

function handleWorkerLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === 'ready') {
    log.info(`  background-removal worker ready (${message.model}, CPU)`);
    return;
  }
  if (message.type === 'fatal') {
    const where = message.modelHome ? ` (model folder: ${message.modelHome})` : '';
    // Name the interpreter AND its version: a venv built with an unsupported
    // Python is the difference between onnxruntime loading and failing with
    // "DLL load failed ... initialization routine failed" on a machine whose
    // CPU and packages are both fine.
    const version = message.pythonVersion ? ` ${message.pythonVersion}` : '';
    const which = message.python ? ` (python${version}: ${message.python})` : '';
    const supported =
      message.pythonVersion && !/^3\.(11|12|13)\./.test(message.pythonVersion)
        ? ` Background removal is verified on Python 3.11-3.13; this venv is on ${message.pythonVersion}.`
        : '';
    // A broken environment does not fix itself between photos. Remember it, so
    // one clear reason is reported instead of the same failure once per image —
    // a run produced five identical "exited with code 1" lines in 45 seconds.
    startupFailure =
      `${message.error}${where}${which}. ` +
      `${supported} ` +
      'Fix the environment, or turn Background Removal off in the app to upload without it.';
    rejectPending(new Error(`rembg CPU worker could not start: ${startupFailure}`));
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.ok) request.resolve(message);
  else request.reject(new Error(message.error || 'rembg worker failed'));
  scheduleIdleStop();
}

function startWorker(runtime) {
  if (worker) return worker;
  fs.mkdirSync(runtime.modelDir, { recursive: true });
  stdoutBuffer = '';
  stderrBuffer = '';
  const child = spawn(runtime.pythonPath, ['-u', workerScript], {
    cwd: config.root,
    windowsHide: true,
    env: {
      ...process.env,
      U2NET_HOME: runtime.modelDir,
      BACKGROUND_REMOVAL_MODEL,
      OMP_NUM_THREADS: String(BACKGROUND_REMOVAL_THREADS),
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker = child;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      handleWorkerLine(stdoutBuffer.slice(0, newline));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuffer = `${stderrBuffer}${chunk}`.slice(-6000);
  });
  child.once('error', (error) => {
    if (worker === child) worker = null;
    rejectPending(new Error(`Could not start rembg CPU worker: ${error.message}`));
  });
  child.once('exit', () => {
    if (worker === child) worker = null;
  });
  // 'close', not 'exit': exit can fire while stderr still has buffered data, so
  // rejecting there threw away the Python traceback and left only "rembg CPU
  // worker exited with code 1" with no reason at all.
  child.once('close', (code) => {
    if (worker === child) worker = null;
    if (!pending.size) return;
    const detail = stderrBuffer.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ');
    const hint =
      !detail && !fs.existsSync(backgroundRemovalModelPath)
        ? `. The ${BACKGROUND_REMOVAL_MODEL} model is not in ${backgroundRemovalModelDir} yet, ` +
          'so the first run downloads it — check this machine can reach the network, ' +
          `or copy ${BACKGROUND_REMOVAL_MODEL}.onnx into that folder`
        : '';
    rejectPending(
      new Error(`rembg CPU worker exited with code ${code}${detail ? `: ${detail}` : ''}${hint}`),
    );
  });
  return child;
}

function requestRemoval(runtime, inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    if (startupFailure) {
      reject(new Error(`background removal is unavailable: ${startupFailure}`));
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = null;
    const child = startWorker(runtime);
    const id = ++requestSequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      stopWorker();
      reject(new Error('rembg CPU processing timed out after 5 minutes'));
    }, requestTimeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, input: path.resolve(inputPath), output: path.resolve(outputPath) })}\n`, (error) => {
      if (!error) return;
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`Could not send image to rembg worker: ${error.message}`));
    });
  });
}

function enqueue(work) {
  const next = renderQueue.then(work, work);
  renderQueue = next.catch(() => {});
  return next;
}

/** Remove the background into a temporary PNG; the source file is never modified. */
export function applyBackgroundRemoval(imagePath, productId, runtime) {
  return enqueue(async () => {
    const safeId = String(productId || 'product').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 90);
    const outputPath = path.join(config.dataDir, `.upload-${safeId}-background-${Date.now()}-${requestSequence + 1}.png`);
    try {
      await requestRemoval(runtime, imagePath, outputPath);
      if (!fs.existsSync(outputPath)) throw new Error('rembg worker did not create an output image');
      return { filePath: outputPath, temporary: true, backgroundRemoved: true };
    } catch (error) {
      fs.rmSync(outputPath, { force: true });
      throw error;
    }
  });
}

process.once('exit', stopWorker);
