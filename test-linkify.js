/**
 * Test script: same linkify logic as main.js linkifyPlainText.
 * Run: node test-linkify.js
 */

const safeHref = (u) => u.replace(/"/g, '&quot;');
const linkTag = /<a\s[^>]*>.*?<\/a>/g;

function linkifyPlainOnly(text) {
  if (!text) return text;
  return text
    .replace(/(?<![\/">])(www\.[^\s<>"']+)/g, (_, url) =>
      `<a href="${safeHref('https://' + url)}" target="_blank" rel="noopener">${url}</a>`)
    .replace(/\b([a-zA-Z0-9][-a-zA-Z0-9_]*\.github\.io(?:\/[^\s<>"']*)?)/g, (_, url) =>
      `<a href="${safeHref('https://' + url)}" target="_blank" rel="noopener">${url}</a>`)
    .replace(/\b(localhost(?::\d+)?(?:\/[^\s<>"']*)?)/gi, (_, u) =>
      `<a href="${safeHref('https://' + u)}" target="_blank" rel="noopener">${u}</a>`)
    .replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?(?:\/[^\s<>"']*)?)/g, (_, u) =>
      `<a href="${safeHref('https://' + u)}" target="_blank" rel="noopener">${u}</a>`)
    .replace(/\b((?:[a-zA-Z0-9][-a-zA-Z0-9_]*\.)+[a-zA-Z0-9][-a-zA-Z0-9_]*(?::\d+)?(?:\/?[^\s<>"']*)?)\b/g, (_, url) => {
      const tldMatch = url.match(/\.(com|org|net|io|co|edu|gov|dev|app|ai|site|xyz|test|local|internal)(?:\/|:\d+|\?|#|$)/i);
      if (!tldMatch) return url;
      if (url === 'github.io') return url;
      return `<a href="${safeHref('https://' + url)}" target="_blank" rel="noopener">${url}</a>`;
    });
}

function linkifyOne(text) {
  if (!text) return text;
  const withScheme = text.replace(/(https?:\/\/[^\s<>"']+)/g, (_, url) =>
    `<a href="${safeHref(url)}" target="_blank" rel="noopener">${url}</a>`);
  const parts = withScheme.split(linkTag);
  const links = withScheme.match(linkTag) || [];
  let out = linkifyPlainOnly(parts[0]);
  for (let i = 0; i < links.length; i++) {
    out += links[i] + linkifyPlainOnly(parts[i + 1]);
  }
  return out;
}

function linkifyPlainText(segment) {
  if (!segment || /^<a\s|^<\/a>/.test(segment)) return segment;
  const parts = segment.split(linkTag);
  const links = segment.match(linkTag) || [];
  let out = linkifyOne(parts[0]);
  for (let i = 0; i < links.length; i++) {
    out += links[i] + linkifyOne(parts[i + 1]);
  }
  return out;
}

const urls = `
http://example.com
https://example.com
example.com
EXAMPLE.com
example-site.com
example_site.com
http://example-site.com/path
https://example.com/path/to/page
example.com/test
example.com/a/b/c
http://example.com?q=1
https://example.com?x=1&y=2
example.com/search?q=test
example.com/page#section
https://example.com/page?id=10#top
http://test.example.com
https://sub.domain.example.com
example.domain.com
example.domain.test.com
this.is.an.example.com
this.is.an.ex.ample.com
a.b.c.d.e.com
a.b.c.d.e.f.com
http://a.b.c.d.com
https://a.b.c.d.e.com
a.b.c.d.e.f.g.com
alpha.beta.gamma.delta.com
site.long.subdomain.example.com
test.TEST.com
MiXeDCase.Domain.com
example123.com
abc-123.com
abc_123.com
test-domain_1.com
example.com:8080
http://example.com:3000
https://example.com:5001/api
localhost
localhost:3000
http://localhost:8080
https://localhost/test
127.0.0.1
http://127.0.0.1
https://127.0.0.1:8080
127.0.0.1:5000/api
192.168.0.1
http://192.168.1.10
https://192.168.1.10:8443/login
10.0.0.1
10.0.0.5:9000
172.16.0.2
http://172.16.0.2/test
example.com?a=1
example.com?a=1&b=2
example.com?a=1&b=2&c=3
example.com/path?query=abc
example.com/path?query=abc&sort=desc
example.com/path?query=abc#fragment
example.com/#home
example.com/#about
example.com/#section-3
http://example.com/#top
https://example.com/page#part2
data.example.com
files.example.com
cdn.example.com
img.example.com
static.example.com
very.long.sub.domain.example.com
deep.layer.one.two.three.example.com
a.b.c.d.e.f.g.h.example.com
example.co
example.org
example.net
example.io
example.dev
example.ai
example.app
example.site
example.xyz
http://example.io/test
https://example.dev/api/v1
example.net/download/file
example.org/wiki/Page
docs.example.com/v1/index.html
api.example.com/v2/users
api.example.com/v2/users?id=22
api.example.com/v2/users?id=22&sort=name
api.example.com/v2/users?id=22#info
shop.example.com
shop.example.com/cart
shop.example.com/cart?item=10
shop.example.com/cart?item=10&qty=2
shop.example.com/checkout#payment
blog.example.com
blog.example.com/post-1
blog.example.com/post-1#comments
blog.example.com/post-1?share=true
user.example.com
user.example.com/profile
user.example.com/profile?id=123
user.example.com/profile?id=123#activity
service.api.example.com
service.api.example.com/v1
service.api.example.com/v1/users
service.api.example.com/v1/users?limit=10
service.api.example.com/v1/users?limit=10&page=2
test-server.local
dev-server.local
prod-server.local
http://dev-server.local
https://prod-server.local/admin
server.internal
server.internal:7000
intranet.company.local
fileserver.office.local
media-server.local/stream
node1.cluster.local
node2.cluster.local
node3.cluster.local
alpha.beta.local
a1.b2.c3.local
my-app.example.com
my_app.example.com
my-app_v2.example.com
test123.example.com
build-server.example.com
download.example.com/file.zip
download.example.com/file_v2.zip
mirror.example.com/linux.iso
mirror.example.com/linux.iso#checksum
cdn1.assets.example.com
cdn2.assets.example.com
cdn3.assets.example.com
assets.example.com/js/app.js
assets.example.com/css/style.css
assets.example.com/img/logo.png
api1.service.example.com
api2.service.example.com
api3.service.example.com
api.service.example.com/v1/data
api.service.example.com/v1/data?id=9
api.service.example.com/v1/data?id=9&format=json
api.service.example.com/v1/data?id=9#meta
portal.company.com
portal.company.com/login
portal.company.com/login?redirect=home
portal.company.com/dashboard#stats
mail.company.com
smtp.company.com
imap.company.com
ftp.company.com
http://ftp.company.com/files
https://mail.company.com/inbox
news.site.com
news.site.com/world
news.site.com/world?day=mon
news.site.com/world?day=mon#top
video.site.com/watch
video.site.com/watch?v=abc123
video.site.com/watch?v=abc123&t=20
video.site.com/watch?v=abc123#comments
maps.service.com
maps.service.com/location
maps.service.com/location?lat=10&lng=20
maps.service.com/location?lat=10&lng=20#pin
forum.example.com
forum.example.com/thread/123
forum.example.com/thread/123?page=2
forum.example.com/thread/123?page=2#reply5
docs.project.io
docs.project.io/start
docs.project.io/start?lang=en
docs.project.io/start?lang=en#install
alpha.test.dev
beta.test.dev
gamma.test.dev
delta.test.dev
epsilon.test.dev
zeta.test.dev
theta.test.dev
omega.test.dev
`.trim().split('\n').map(s => s.trim()).filter(Boolean);

let fail = 0;
const issues = [];

urls.forEach((url) => {
  const result = linkifyPlainText(url);
  const hrefMatch = result.match(/<a\s+href="([^"]+)"/);
  const href = hrefMatch ? hrefMatch[1].replace(/&quot;/g, '"') : null;
  const isSingleLink = /^<a\s+href="[^"]+"\s+target="_blank"\s+rel="noopener">[^<]*<\/a>$/.test(result);
  const expectedHref = url.startsWith('http') ? url : (href ? 'https://' + url : null);
  let ok = true;
  let msg = '';
  if (!href) {
    ok = false;
    msg = 'not linkified';
  } else if (!isSingleLink) {
    ok = false;
    msg = 'multiple links or extra text';
  } else if (expectedHref && href !== expectedHref) {
    ok = false;
    msg = `wrong href: ${href}`;
  }
  if (!ok) {
    fail++;
    issues.push({ url, msg, result: result.slice(0, 100) });
  }
});

console.log(`Total: ${urls.length}, Failed: ${fail}\n`);
if (issues.length) {
  console.log('Issues:');
  issues.forEach(({ url, msg, result }) => console.log(`  ${url}\n    -> ${msg}\n    result: ${result}...`));
}
