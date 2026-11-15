"""File exchange between the Mac and the Windows VM (no VMware Tools / shared folders needed).

Serves fixtures/vm_exchange/ as a page with download links and an upload form.
Binds ONLY to VMware's virtual-network bridge addresses (bridge100/bridge101 on this Mac),
so it is reachable from the VM but not from the LAN or the internet.

    python3 -I bin/vm_exchange.py            # auto-detects the VMware bridge IPs
    In Windows (Edge): http://192.168.176.1:8932/  (or the other printed address)

Uploads go to fixtures/vm_exchange/from_vm/ and never overwrite an existing file.
"""
import email.parser, email.policy, html, http.server, os, re, subprocess, sys, threading, urllib.parse
from datetime import datetime

ROOT = os.path.join(os.environ.get('PROJECT_ROOT', os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'fixtures', 'vm_exchange')
UPLOAD_DIR = os.path.join(ROOT, 'from_vm')
PORT = int(os.environ.get('D300_EXCHANGE_PORT', '8932'))
MAX_UPLOAD = 200 * 1024 * 1024  # 200 MB
ALLOWED_EXT = {'.tdd', '.xml', '.xlsx', '.csv', '.txt', '.png', '.jpg', '.jpeg', '.pdf', '.log'}


def vmware_bridge_ips():
    """IPv4 addresses of bridge1xx interfaces (VMware Fusion's NAT / host-only networks)."""
    out = subprocess.run(['ifconfig'], capture_output=True, text=True).stdout
    ips, cur = [], None
    for line in out.splitlines():
        m = re.match(r'^(\S+):', line)
        if m:
            cur = m.group(1)
        m = re.search(r'inet (\d+\.\d+\.\d+\.\d+)', line)
        if m and cur and re.fullmatch(r'bridge1\d\d', cur):
            ips.append(m.group(1))
    return ips


def safe_name(name):
    name = os.path.basename(name.replace('\\', '/')).strip()
    name = re.sub(r'[^\w.\- ()]+', '_', name)
    if not name or name.startswith('.'):
        raise ValueError('bad file name')
    if os.path.splitext(name)[1].lower() not in ALLOWED_EXT:
        raise ValueError(f'file type not allowed ({", ".join(sorted(ALLOWED_EXT))})')
    return name


def unique_path(directory, name):
    base, ext = os.path.splitext(name)
    path, n = os.path.join(directory, name), 1
    while os.path.exists(path):
        path = os.path.join(directory, f'{base} ({n}){ext}')
        n += 1
    return path


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype='text/html; charset=utf-8'):
        data = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def page(self, msg=''):
        rows = []
        for dirpath, _, files in sorted(os.walk(ROOT)):
            for f in sorted(files):
                if f.startswith('.'):
                    continue
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
                size = os.path.getsize(full)
                when = datetime.fromtimestamp(os.path.getmtime(full)).strftime('%Y-%m-%d %H:%M')
                rows.append(f'<tr><td><a href="/files/{urllib.parse.quote(rel)}">{html.escape(rel)}</a></td>'
                            f'<td>{size / 1e6:.2f} MB</td><td>{when}</td></tr>')
        return f'''<!doctype html><html><head><meta charset="utf-8"><title>D300 exchange</title>
<style>body{{font:15px Segoe UI,system-ui,sans-serif;margin:24px;max-width:900px}}td{{padding:4px 14px 4px 0}}
.msg{{padding:8px 12px;background:#e7f5e9;border-radius:6px}}.box{{border:1px solid #ccc;border-radius:8px;padding:14px;margin:16px 0}}</style></head>
<body><h1>Mac ⇄ VM file exchange</h1>{f'<p class="msg">{html.escape(msg)}</p>' if msg else ''}
<div class="box"><h2>Send files to the Mac</h2>
<form method="post" action="/upload" enctype="multipart/form-data">
<input type="file" name="file" multiple required> <button>Upload</button></form>
<p>Saved on the Mac in <code>fixtures/vm_exchange/from_vm/</code>. Existing files are never overwritten.</p></div>
<div class="box"><h2>Files on the Mac</h2><table>{''.join(rows) or '<tr><td>none</td></tr>'}</table></div></body></html>'''

    def do_GET(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if path == '/':
            return self._send(200, self.page())
        if path.startswith('/files/'):
            full = os.path.realpath(os.path.join(ROOT, path[len('/files/'):]))
            if not full.startswith(os.path.realpath(ROOT) + os.sep) or not os.path.isfile(full):
                return self._send(404, 'not found', 'text/plain')
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(os.path.getsize(full)))
            self.send_header('Content-Disposition', f'attachment; filename="{os.path.basename(full)}"')
            self.end_headers()
            with open(full, 'rb') as fh:
                while chunk := fh.read(1 << 20):
                    self.wfile.write(chunk)
            return
        self._send(404, 'not found', 'text/plain')

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != '/upload':
            return self._send(404, 'not found', 'text/plain')
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_UPLOAD:
            return self._send(413, self.page(f'Upload refused: size {length} bytes (max {MAX_UPLOAD // 2**20} MB).'))
        body = self.rfile.read(length)
        msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
            b'Content-Type: ' + self.headers['Content-Type'].encode() + b'\r\n\r\n' + body)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        saved, errors = [], []
        for part in msg.iter_parts():
            fname = part.get_filename()
            if not fname:
                continue
            try:
                dest = unique_path(UPLOAD_DIR, safe_name(fname))
                with open(dest, 'xb') as fh:
                    fh.write(part.get_payload(decode=True) or b'')
                saved.append(os.path.basename(dest))
                self.log_message('saved %s', dest)
            except (ValueError, OSError) as e:
                errors.append(f'{fname}: {e}')
        note = (f'Saved: {", ".join(saved)}. ' if saved else '') + (f'Not saved: {"; ".join(errors)}' if errors else '')
        self._send(200 if saved else 400, self.page(note or 'No file received.'))


def main():
    ips = sys.argv[1:] or vmware_bridge_ips()
    if not ips:
        sys.exit('No VMware bridge interface found (is the VM running?).')
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    servers = [http.server.ThreadingHTTPServer((ip, PORT), Handler) for ip in ips]
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print('VM exchange serving', ROOT, 'at', ', '.join(f'http://{ip}:{PORT}/' for ip in ips), flush=True)
    servers[0].serve_forever()


if __name__ == '__main__':
    main()
