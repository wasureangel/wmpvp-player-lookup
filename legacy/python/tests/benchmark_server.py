"""Deterministic loopback upstream for the browser benchmark (also accepts an older checkout)."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.respond()

    def do_POST(self):
        self.respond()

    def respond(self):
        time.sleep(0.12)
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        path = self.path
        if path.endswith('/user'):
            n = int(body['keyword'].split('-')[1])
            result = {'code':1, 'result':[{'steamId':str(76561198000000000+n),'pvpNickName':body['keyword'],'pvpScore':1800}]}
        elif path.endswith('/list'):
            sid = str(body['toSteamId'])
            result = {'statusCode':0, 'data':{'matchList':[
                {'matchId':f'{sid}-{i}' if i else 'shared', 'mode':'完美官匹Pro','team':1,'winTeam':1,
                 'endTime':'2026-01-10 09:00:00','kill':20,'death':10,'assist':5,'pwRating':1.2}
                for i in range(10)]}}
        elif path.endswith('/match'):
            result = {'statusCode':0,'data':{'players':[{'playerId':str(76561198000000000+i), 'adpr':80,
                       'we':12,'rws':10,'honor':'2'} for i in range(10)]}}
        elif path.endswith('/csgoSeasons'):
            result = {'statusCode':0,'data':[{'season':f'S{i}', 'endTime':'2020-01-01 00:00:00'} for i in range(25)]}
        elif path.endswith('/pvpDetailStats'):
            result = {'statusCode':0,'data':{'seasonId':body['csgoSeasonId'],'historyScores':[1900,2000]}}
        else:
            self.send_error(404)
            return
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass

    protocol_version = 'HTTP/1.1'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--port', type=int, default=8870)
    args = parser.parse_args()
    sys.path.insert(0, str(args.root.resolve()))
    import os
    import web_app as web
    mock = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    target = f'http://127.0.0.1:{mock.server_port}'
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    web.PORT = args.port
    web.ORIGIN = f'http://127.0.0.1:{args.port}'
    web.AUTH.update(token='fixture',steamId='76561198000000000')
    with tempfile.TemporaryDirectory() as db:
        os.environ['WMPVP_CACHE_PATH'] = str(Path(db) / 'bench.db')
        if hasattr(web, 'runtime'):
            import httpx
            from upstream import runtime
            async def setup(platform):
                async def route(request):
                    request.url = httpx.URL(target + request.url.path)
                platform.client.event_hooks['request'].append(route)
            runtime.run(setup)
        else:
            original = web.lookup.http_json
            def route(url, *args, **kwargs):
                return original(target + urlsplit(url).path, *args, **kwargs)
            web.lookup.http_json = route
        server = ThreadingHTTPServer(('127.0.0.1', args.port), web.Handler)
        try:
            print('ready', flush=True)
            server.serve_forever()
        finally:
            server.server_close()
            if hasattr(web, 'runtime'):
                web.runtime.close()
            mock.shutdown()

if __name__ == '__main__':
    main()
