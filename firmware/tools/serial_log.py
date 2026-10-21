"""端末のシリアルログを指定した秒数だけ読んで表示する（idf.py monitor が使えない非対話の環境向け）。
使い方: python tools/serial_log.py <port> <seconds> [--reset]
"""
import sys
import time

import serial

port, seconds = sys.argv[1], float(sys.argv[2])
reset = "--reset" in sys.argv
with serial.Serial(port, 115200, timeout=0.2) as s:
    if reset:
        # USB-Serial-JTAG の RTS でリセットする
        s.dtr = False
        s.rts = True
        time.sleep(0.1)
        s.rts = False
    end = time.time() + seconds
    buf = b""
    while time.time() < end:
        buf += s.read(4096)
        *lines, buf = buf.split(b"\n")
        for line in lines:
            print(line.decode("utf-8", "replace").rstrip(), flush=True)
    if buf:
        print(buf.decode("utf-8", "replace"))
