"""Real HTTPS/SW transfer tests, called by verify_browser.py.

The server deliberately stalls small fixture resources. SW source is the real
production file; no dependency or test hook is added to the shipped worker.
"""
import asyncio
from dataclasses import dataclass, field
import http.server
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]


@dataclass
class TransferFault:
    mode: str = 'normal'
    started: threading.Event = field(default_factory=threading.Event)
    release: threading.Event = field(default_factory=threading.Event)
    finished: threading.Event = field(default_factory=threading.Event)


async def wait_for(predicate, timeout=10):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if await predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError('timed out waiting for network fixture state')


async def run_network_timeout_checks(browser, check):
    source = (ROOT / 'service-worker.js').read_bytes()
    faults = []

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_):
            pass

        def handle(self):
            try:
                super().handle()
            except (BrokenPipeError, ConnectionResetError):
                pass  # Intentional AbortController/context cancellation.
            except ssl.SSLError as error:
                if error.reason != 'UNEXPECTED_EOF_WHILE_READING':
                    raise

        def send_body(self, body, mime):
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Deadline-Review', 'preserved')
            self.end_headers()
            self.wfile.write(body)

        def stall(self, fault, body, mime, before_headers):
            try:
                if before_headers:
                    fault.started.set()
                    fault.release.wait(15)
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                if not before_headers:
                    self.wfile.write(body[:8])
                    self.wfile.flush()
                    fault.started.set()
                    fault.release.wait(15)
                    self.wfile.write(body[8:])
                else:
                    self.wfile.write(body)
                self.wfile.flush()
            finally:
                fault.finished.set()

        def do_GET(self):
            path = urlparse(self.path).path
            fault = self.server.active_fault
            mode = fault.mode
            try:
                if path == '/deadline/service-worker.js':
                    self.send_body(source, 'text/javascript')
                elif path == '/deadline/assets/js/spv2-core.js':
                    if mode in ('headers', 'body'):
                        self.stall(fault, b'HEALTHY_BUT_LATE_NETWORK', 'text/javascript', mode == 'headers')
                    else:
                        body = b'PRECACHED_CORE' if mode == 'normal' else b'FAST_NETWORK'
                        self.send_body(body, 'text/javascript')
                elif path in ('/deadline/', '/deadline/index.html'):
                    if mode == 'navigation':
                        self.stall(fault, b'<!doctype html><body>HEALTHY_BUT_LATE_HTML</body>', 'text/html', False)
                    else:
                        self.send_body(b'<!doctype html><body>COMPLETE_CACHED_SHELL</body>', 'text/html')
                elif path == '/deadline/manifest.webmanifest':
                    self.send_body(b'{"name":"Deadline fixture","start_url":"./"}', 'application/manifest+json')
                elif path.startswith('/deadline/'):
                    # Other precache fixtures are never executed or displayed.
                    self.send_body(b'fixture', 'application/octet-stream')
                else:
                    self.send_response(204)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
            except (BrokenPipeError, ConnectionResetError, ssl.SSLEOFError):
                pass

    with tempfile.TemporaryDirectory(prefix='starrypass-deadline-') as temporary:
        directory = Path(temporary)
        cert, key = directory / 'cert.pem', directory / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-keyout', str(key), '-out', str(cert), '-subj', '/CN=localhost'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.daemon_threads = True
        server.active_fault = TransferFault()
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        root = f'https://127.0.0.1:{server.server_port}/deadline/'
        core = root + 'assets/js/spv2-core.js'
        prefix = 'spv2:/deadline/:'

        async def cached(page, url):
            return await page.evaluate("""async ({url,prefix}) => {
                const name=(await caches.keys()).find(n=>n.startsWith(prefix+'runtime-v'));
                if(!name)return null;
                const response=await caches.match(url,{cacheName:name});
                return response?await response.text():null;
            }""", {'url': url, 'prefix': prefix})

        try:
            for scenario in ('headers', 'body', 'navigation', 'no-cache'):
                fault = TransferFault()
                faults.append(fault)
                server.active_fault = fault
                context = await browser.new_context(ignore_https_errors=True)
                page = await context.new_page()
                navigation = None
                try:
                    await page.goto(root + 'index.html')
                    await page.evaluate("""async () => {
                        await navigator.serviceWorker.register('./service-worker.js');
                        await navigator.serviceWorker.ready;
                    }""")
                    await wait_for(lambda: page.evaluate('!!navigator.serviceWorker.controller'))
                    worker = context.service_workers[-1]
                    await worker.evaluate("""() => {
                        self.__deadlineAborts=0;self.__deadlinePending=0;self.__deadlineUnhandled=[];
                        const abort=AbortController.prototype.abort;
                        AbortController.prototype.abort=function(...args){
                            self.__deadlineAborts++;return abort.apply(this,args);
                        };
                        const waitUntil=ExtendableEvent.prototype.waitUntil;
                        ExtendableEvent.prototype.waitUntil=function(promise){
                            self.__deadlinePending++;
                            Promise.resolve(promise).then(()=>self.__deadlinePending--,()=>self.__deadlinePending--);
                            return waitUntil.call(this,promise);
                        };
                        self.addEventListener('unhandledrejection',event=>self.__deadlineUnhandled.push(String(event.reason)));
                    }""")
                    fault.mode = 'fast'
                    healthy = await page.evaluate("""async url => {
                        const response=await fetch(url);
                        return {status:response.status,type:response.type,url:response.url,
                            header:response.headers.get('X-Deadline-Review'),text:await response.text()};
                    }""", core)
                    check(healthy == {'status': 200, 'type': 'basic', 'url': core,
                                      'header': 'preserved', 'text': 'FAST_NETWORK'},
                          'deadline pre-read preserves real Response metadata and readable body')

                    async def warmed():
                        return await cached(page, core) == 'FAST_NETWORK'

                    await wait_for(warmed)
                    await wait_for(lambda: worker.evaluate('__deadlinePending===0'))
                    if scenario == 'no-cache':
                        await page.evaluate("""async prefix => {
                            for(const name of await caches.keys())if(name.startsWith(prefix))await caches.delete(name);
                        }""", prefix)
                    fault.mode = 'headers' if scenario == 'no-cache' else scenario
                    if scenario == 'navigation':
                        navigation = asyncio.create_task(page.goto(root + 'index.html?deadline=1', wait_until='load', timeout=12000))
                    else:
                        await page.evaluate("""url => {
                            const start=performance.now();self.__deadlineResult={pending:true};
                            fetch(url).then(async response=>{
                                const text=await response.text();
                                Object.assign(__deadlineResult,{pending:false,ok:true,type:response.type,url:response.url,
                                    text,elapsed:performance.now()-start});
                            }).catch(error=>Object.assign(__deadlineResult,{pending:false,ok:false,
                                error:String(error),elapsed:performance.now()-start}));
                        }""", core)
                    check(await asyncio.to_thread(fault.started.wait, 2), scenario + ' reaches the injected real server stall')
                    await asyncio.sleep(3.5)  # Real SW clock, not the page's virtual clock.
                    if navigation is not None:
                        check(navigation.done(), 'partial navigation completes through precache at deadline')
                        await navigation
                        check(await page.inner_text('body') == 'COMPLETE_CACHED_SHELL', 'navigation fallback is a complete cached HTML body')
                    else:
                        result = await page.evaluate('__deadlineResult')
                        check(not result['pending'] and 2500 <= result['elapsed'] < 5000, scenario + ' settles near the actual 3000ms deadline')
                        if scenario == 'no-cache':
                            check(not result['ok'] and 'Failed to fetch' in result['error'], 'no-cache deadline returns a real browser network error')
                        else:
                            check(result['ok'] and result['text'] == 'FAST_NETWORK' and result['type'] == 'basic'
                                  and result['url'] == core, scenario + ' returns an intact cached core response')
                    metrics = await worker.evaluate('({aborts:__deadlineAborts,pending:__deadlinePending,unhandled:__deadlineUnhandled})')
                    check(metrics['aborts'] == 1 and metrics['pending'] == 0, scenario + ' aborts transfer and settles actual waitUntil')
                    check(metrics['unhandled'] == [], scenario + ' creates no unhandled abort/race rejection')
                    fault.release.set()
                    transfer_finished = await asyncio.to_thread(fault.finished.wait, 3)
                    await wait_for(lambda: worker.evaluate('__deadlinePending===0'))
                    stored = await cached(page, root + 'index.html' if navigation else core)
                    expected = None if scenario in ('navigation', 'no-cache') else 'FAST_NETWORK'
                    check(transfer_finished and stored == expected, scenario + ' released late transfer cannot replace runtime cache')
                    print('PASS HTTPS transfer deadline:', scenario)
                finally:
                    fault.release.set()
                    if navigation is not None:
                        if not navigation.done():
                            navigation.cancel()
                        await asyncio.gather(navigation, return_exceptions=True)
                    await context.close()
        finally:
            for fault in faults:
                fault.release.set()
            server.shutdown()
            server.server_close()
            thread.join()
