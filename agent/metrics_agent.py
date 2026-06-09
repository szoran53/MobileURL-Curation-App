#!/usr/bin/env python3
"""
Farm Monitor Metrics Agent
Run on each compute node. Serves CPU/Memory/GPU stats as JSON.

Install:  pip install psutil
Run:      python3 metrics_agent.py
Autostart: see install_agent.sh
"""

import json
import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    import psutil
    PSUTIL_OK = True
except ImportError:
    PSUTIL_OK = False
    print("WARNING: psutil not installed. Run: pip install psutil")

PORT = int(os.environ.get('AGENT_PORT', '19999'))
BIND = os.environ.get('AGENT_BIND', '0.0.0.0')


def get_cpu():
    if not PSUTIL_OK:
        return {'overall': 0, 'per_core': [], 'count': 0, 'load_avg': [0, 0, 0]}

    per_core = psutil.cpu_percent(interval=0.2, percpu=True)
    overall = round(sum(per_core) / len(per_core), 1) if per_core else 0
    freq = psutil.cpu_freq()
    load = list(os.getloadavg()) if hasattr(os, 'getloadavg') else [0, 0, 0]

    temp = None
    try:
        sensors = psutil.sensors_temperatures()
        for key in ('coretemp', 'k10temp', 'cpu_thermal', 'acpitz', 'zenpower'):
            if key in sensors and sensors[key]:
                temp = round(sensors[key][0].current, 1)
                break
    except Exception:
        pass

    return {
        'overall': overall,
        'per_core': [round(v, 1) for v in per_core],
        'count': len(per_core),
        'freq_mhz': round(freq.current, 0) if freq else None,
        'load_avg': [round(v, 2) for v in load],
        'temp_c': temp,
    }


def get_memory():
    if not PSUTIL_OK:
        return {'total': 0, 'used': 0, 'free': 0, 'cached': 0,
                'percent': 0, 'swap_total': 0, 'swap_used': 0, 'swap_percent': 0}

    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    return {
        'total': mem.total,
        'used': mem.used,
        'free': mem.available,
        'cached': getattr(mem, 'cached', 0),
        'percent': round(mem.percent, 1),
        'swap_total': swap.total,
        'swap_used': swap.used,
        'swap_percent': round(swap.percent, 1),
    }


def get_gpus():
    try:
        result = subprocess.run(
            ['nvidia-smi',
             '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,'
             'temperature.gpu,power.draw,power.limit',
             '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return []

        gpus = []
        for line in result.stdout.strip().split('\n'):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(',')]
            if len(parts) < 8:
                continue

            def pf(s):
                try:
                    return float(s)
                except Exception:
                    return None

            gpus.append({
                'index': int(parts[0]),
                'name': parts[1],
                'util_pct': pf(parts[2]),
                'mem_used_mb': pf(parts[3]),
                'mem_total_mb': pf(parts[4]),
                'temp_c': pf(parts[5]),
                'power_w': pf(parts[6]),
                'power_limit_w': pf(parts[7]),
            })
        return gpus
    except FileNotFoundError:
        return []
    except subprocess.TimeoutExpired:
        return []
    except Exception:
        return []


def get_processes():
    if not PSUTIL_OK:
        return []

    procs = []
    for p in psutil.process_iter(['pid', 'name', 'cpu_percent',
                                   'memory_percent', 'username', 'status']):
        try:
            info = p.info
            if info.get('status') in ('zombie', 'dead'):
                continue
            procs.append({
                'pid': info['pid'],
                'name': (info.get('name') or '')[:24],
                'cpu': round(info.get('cpu_percent') or 0, 1),
                'mem': round(info.get('memory_percent') or 0, 2),
                'user': (info.get('username') or '')[:16],
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    procs.sort(key=lambda x: x['cpu'], reverse=True)
    return procs[:25]


def collect():
    return {
        'hostname': os.uname().nodename,
        'timestamp': time.time(),
        'cpu': get_cpu(),
        'memory': get_memory(),
        'gpus': get_gpus(),
        'processes': get_processes(),
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/metrics', '/'):
            data = json.dumps(collect()).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(data)
        elif self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'ok')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass  # suppress per-request logs


if __name__ == '__main__':
    print(f"Farm Monitor Agent starting on {BIND}:{PORT}")
    print(f"Hostname: {os.uname().nodename}")
    if not PSUTIL_OK:
        print("ERROR: install psutil first: pip install psutil")
    server = HTTPServer((BIND, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
