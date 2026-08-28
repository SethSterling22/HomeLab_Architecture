#!/usr/bin/env python3
"""
monitoring/shelly-gen4-exporter/udp-log-listener.py

Minimal UDP listener + timestamped logger for the Shelly's debug log
stream (enabled via Sys.SetConfig's debug.udp.addr -- see
monitoring/README.md or the diagnosis notes for the curl command).

Avoids two things that tripped up `nc`/`ts` on this box: netcat has two
incompatible flavors (BSD `nc -ul <port>` vs traditional `nc -ul -p
<port>`), and `ts` (moreutils) isn't installed by default. This is stdlib
only, same convention as the rest of this repo's scripts.

Usage:
    ./udp-log-listener.py [port] [logfile]

Examples:
    ./udp-log-listener.py                     # port 5555, ./shelly-debug.log
    ./udp-log-listener.py 5555 shelly-debug.log

Leave it running (it's a plain foreground loop -- use tmux/screen/nohup if
you want it to survive a disconnect) until the next relay-cycle event
happens, then read the logfile for what the device itself reported at
that timestamp. Ctrl+C to stop. Remember to turn the debug stream back
off on the device afterward (set debug.udp.addr back to null) so it
doesn't keep flooding UDP packets forever.
"""

import socket
import sys
import time

def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5555
    logfile = sys.argv[2] if len(sys.argv) > 2 else "shelly-debug.log"

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", port))
    print(f"Listening for Shelly debug logs on UDP :{port}, writing to {logfile} (Ctrl+C to stop)")

    with open(logfile, "a", buffering=1) as f:
        while True:
            try:
                data, addr = sock.recvfrom(65536)
            except KeyboardInterrupt:
                print("\nStopped.")
                break
            line = data.decode("utf-8", errors="replace").rstrip("\n")
            stamped = f"{time.strftime('%Y-%m-%d %H:%M:%S')} [{addr[0]}] {line}"
            print(stamped)
            f.write(stamped + "\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
