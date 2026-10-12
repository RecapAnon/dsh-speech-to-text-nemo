/**
 * Minimal stand-in for DSH's `subprocess` service, for tests and the E2E script.
 * Implements only what NemoRecognizer uses: spawn() with stdout 'pipe' and collected stderr.
 */
import { spawn as spawnChild } from 'node:child_process';

export function createLocalSubprocess() {
  const children = new Set();
  return {
    children,
    spawn(spec) {
      const [command, ...args] = spec.argv;
      const child = spawnChild(command, args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      children.add(child);
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-(spec.stdio.stderr.maxBytes ?? 65536));
      });
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, signal) => {
          children.delete(child);
          resolve({ exitCode, signal });
        });
      });
      done.catch(() => {});
      return {
        pid: child.pid,
        stdin: undefined,
        stdout: child.stdout,
        stderr: undefined,
        control: undefined,
        collected: { stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) } },
        done,
        terminate() {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        },
        async waitForExit() {
          await done.catch(() => {});
          return true;
        },
      };
    },
  };
}
