import { spawn } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface SpawnHandle {
  pid: number;
  kill: () => void;
  sendInput: (text: string) => void;
}

/**
 * Spawn a long-running process, pipe stdout+stderr to a log file.
 * If waitForPattern is set, the returned promise resolves only after that pattern
 * appears in the output (or rejects on timeout / non-zero exit).
 */
export function spawnLogged(
  cmd: string,
  args: string[],
  cwd: string,
  logPath: string,
  opts?: { waitForPattern?: RegExp; timeoutMs?: number },
): Promise<SpawnHandle> {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(logPath), { recursive: true });
    const log = createWriteStream(logPath, { flags: 'a' });

    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    const handle: SpawnHandle = {
      pid: child.pid ?? 0,
      kill: () => { try { child.kill('SIGTERM'); } catch (_) {} },
      sendInput: (s) => { try { child.stdin?.write(s); } catch (_) {} },
    };

    child.stdout?.on('data', (b: Buffer) => log.write(b));
    child.stderr?.on('data', (b: Buffer) => log.write(b));
    child.on('close', () => log.end());
    child.on('error', (e) => { log.end(); reject(e); });

    if (!opts?.waitForPattern) {
      resolve(handle);
      return;
    }

    const pat = opts.waitForPattern;
    const ms = opts.timeoutMs ?? 300_000;
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error(`Timeout ${ms}ms waiting for ${pat}`));
      }
    }, ms);

    const check = (b: Buffer) => {
      if (done) return;
      if (pat.test(b.toString())) {
        done = true;
        clearTimeout(timer);
        resolve(handle);
      }
    };

    child.stdout?.on('data', check);
    child.stderr?.on('data', check);

    child.on('close', (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        if (code === 0) resolve(handle);
        else reject(new Error(`Process exited (code ${code}) before ${pat}`));
      }
    });
  });
}
