"""One unauthenticated GET to the official captcha initializer; never send SMS.

Output contains response metadata and known block-page markers, never tickets,
cookies, account data or arbitrary response content.
"""
import json
import urllib.error
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

req = urllib.request.Request('https://passport.pwesports.cn/initcaptcha', headers={
    'Accept': 'application/json', 'User-Agent': 'WMPVP-Player-Lookup/1.0',
    'platform': 'APP', 'appversion': '3.1.0'})
try:
    response = urllib.request.build_opener(NoRedirect).open(req, timeout=20)
except urllib.error.HTTPError as error:
    response = error
except (urllib.error.URLError, TimeoutError) as error:
    print(json.dumps({'connection_error': type(error).__name__}))
    raise SystemExit(1)
with response:
    raw = response.read(32768).decode('utf-8', errors='replace')
    result = {'method': 'GET', 'status': response.status,
        'content_type': response.headers.get('Content-Type'),
        'allow': response.headers.get('Allow'),
        'markers': [marker for marker in ['errors.aliyun.com', 'aliyun_waf',
            'your request has been blocked', 'acw_sc__v2', 'safeline',
            'cf-chl-', 'captcha'] if marker in raw.lower()]}
    try:
        data = json.loads(raw)
        result['has_captcha_ticket'] = isinstance(data, dict) and bool(data.get('capTicket'))
    except ValueError:
        result['has_captcha_ticket'] = False
    print(json.dumps(result, ensure_ascii=True))
