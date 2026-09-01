import { RuntimeReporter } from './index.js';

export function startBuffering() {
  RuntimeReporter.startBuffering();
}

export function flushBuffer() {
  RuntimeReporter.flushBuffer();
}
