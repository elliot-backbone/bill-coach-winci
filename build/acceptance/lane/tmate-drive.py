#!/usr/bin/env python3
"""Drive a lane's tmate session for the ONE interactive act: sign-in.

  tmate-drive.py signin  "<ssh line>" <profile-path>   → runs `claude auth login` in the sealed profile,
                                                          prints the login URL it sees (nothing else)
  tmate-drive.py code    "<ssh line>" <code>            → pastes the one-time code into the waiting prompt
  tmate-drive.py status  "<ssh line>" <profile-path>    → prints `claude auth status --json` (redacted)

The code is read from the argument and written to the pty only; it is never logged or echoed. The
captured terminal text is written to control/tmate-<ts>.log with the code line redacted.
"""
import os, pty, re, select, subprocess, sys, time

def drive(ssh_line, keys, wait_for, timeout=90, log_path=None, redact=None):
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp('ssh', ['ssh', '-tt', '-o', 'StrictHostKeyChecking=accept-new', *ssh_line.split()[1:]])
    buf = b''
    def read(t):
        nonlocal buf
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.5)
            if fd in r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk: break
                buf += chunk
    read(6)                      # tmate banner / shell prompt
    for k in keys:
        os.write(fd, k.encode() + b'\r')
        read(2)
    end = time.time() + timeout
    while time.time() < end:
        read(2)
        text = buf.decode('utf8', 'replace')
        if wait_for and re.search(wait_for, text):
            break
    text = buf.decode('utf8', 'replace')
    try:
        os.write(fd, b'\x1d')    # leave the pty; the tmate session stays alive on the runner
    except OSError:
        pass
    if log_path:
        clean = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', text)
        if redact:
            clean = clean.replace(redact, '<redacted>')
        with open(log_path, 'a') as f:
            f.write(f"\n=== {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} ===\n{clean}\n")
    return re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', text)

if __name__ == '__main__':
    cmd, ssh_line = sys.argv[1], sys.argv[2]
    log = os.environ.get('TMATE_LOG', 'tmate-drive.log')
    if cmd == 'signin':
        profile = sys.argv[3]
        text = drive(ssh_line, [f'$env:CLAUDE_CONFIG_DIR="{profile}"; claude auth login'], r'https?://\S+', timeout=60, log_path=log)
        urls = re.findall(r'https?://[^\s\x1b]+', text)
        print(urls[-1] if urls else 'NO URL SEEN — attach manually')
    elif cmd == 'code':
        code = sys.argv[3]
        text = drive(ssh_line, [code], r'(logged in|success|Login successful|signed in)', timeout=60, log_path=log, redact=code)
        print('ok' if re.search(r'(logged in|success|Login successful|signed in)', text, re.I) else 'not confirmed — check status')
    elif cmd == 'status':
        profile = sys.argv[3]
        text = drive(ssh_line, [f'$env:CLAUDE_CONFIG_DIR="{profile}"; claude auth status --json'], r'\}', timeout=30, log_path=log)
        m = re.search(r'\{.*\}', text, re.S)
        print(re.sub(r'"(token|accessToken|refreshToken|key|apiKey)"\s*:\s*"[^"]*"', r'"\1":"<redacted>"', m.group(0)) if m else text[-400:])
