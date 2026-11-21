/*
 * Muse 资源解析器 v1.0 —— 自己写的，不用大家都在用的那份
 *
 * 用途：Quantumult X 的 resource_parser_url，解析机场订阅。
 * QX 调用时提供：$resource.link（订阅链接）、$resource.content（订阅原文）、
 * $resource.tag（订阅备注）、$resource.info（流量信息头）。
 * 解析器只能读内容、调 $done，调不了网络，也存不了东西。
 *
 * 支持的订阅原文：
 *   1. base64 订阅（整段 base64，解出来是分享链接）
 *   2. 分享链接：ss / vmess / vless / trojan / hysteria2 / anytls
 *   3. Clash YAML（proxies: 列表）
 *   4. Quantumult X 原生格式（直接整理）
 * 分流规则、重写规则、完整 .conf 原样不动，直接返回。
 *
 * 订阅链接 # 后面可以带参数（用 & 连接）：
 *   in=香港+台湾    只保留名字里带这些词的节点
 *   out=倍率        名字里带这些词的节点不要
 *   emoji=0         不加地区旗帜（默认加）
 *   sort=0          不按地区排序（默认按 香港/台湾/日本/狮城/韩国/美国 排）
 * 例子：https://example.com/sub#in=香港+台湾&out=倍率&emoji=1
 *
 * 本身做的整理（不用加参数也会做）：
 *   - 同名节点只留第一个
 *   - 名字前面没有旗帜的，按地区补一个（🇭🇰🇹🇼🇯🇵🇸🇬🇰🇷🇺🇸……）
 *   - hysteria2 / vless 强制 udp-relay=true（UDP 能通，谷歌镜头那类 QUIC 流量才走得动）
 *   - 按地区排序，方便在策略组里找
 * 出任何问题都原样返回，绝不会把订阅弄空。
 */

(function () {
  'use strict';
  var finished = false;
  function doneOnce(obj) {
    if (finished) return;
    finished = true;
    try { $done(obj); } catch (e) {}
  }
  function log(msg) {
    try { console.log('[Muse解析器] ' + msg); } catch (e) {}
  }

  /* ---------------- UA 重试 ---------------- */
  // 有些机场按 User-Agent 下发内容：QX 默认 UA 拿到的是空内容或错误页，
  // 换 Shadowrocket 的 UA 才能拿到真正的订阅。QX 1.5.6+ 支持 $done({retry})
  // 让它用指定 UA 重新下载一次（最多重试 1 次）。
  var SHADOWROCKET_UA = 'Shadowrocket/3218 CFNetwork/3860.600.12 Darwin/25.5.0 iPhone18,1';
  function looksLikeRules(t) {
    return /^(host|domain|ip-cidr|ip6-cidr|geoip|user-agent|url-regex|host-suffix|host-keyword|host-wildcard|domain-suffix|domain-keyword|ip-asn|final|and|or|not)[,\s]/m.test(t);
  }
  function requestRetry(orig, ua) {
    // 已重试过就不再要求重试，避免死循环；原内容一起带上，老版本 QX 会忽略 retry 用 content
    if (ua) { doneOnce({ content: orig }); return; }
    log('内容无效，换 UA 重试一次');
    doneOnce({ retry: { user_agent: SHADOWROCKET_UA }, content: orig });
  }

  /* ---------------- 入口 ---------------- */
  function main() {
    var content = ($resource && $resource.content) || '';
    var link = ($resource && $resource.link) || '';
    var ua = ($resource && $resource.user_agent) || '';
    var params = parseParams(link);
    var orig = content;
    var trimmed = content.replace(/^\uFEFF/, '').trim();
    if (!trimmed) { requestRetry(orig, ua); return; }
    if (isConfContent(trimmed)) { doneOnce({ content: orig }); return; }
    if (looksLikeRules(trimmed)) { doneOnce({ content: orig }); return; }
    var lines = toNodeLines(trimmed);
    if (!lines || !lines.length) { requestRetry(orig, ua); return; }
    var out = transformLines(lines, params);
    if (!out.length) { doneOnce({ content: orig }); return; }
    log('解析完成：' + out.length + ' 个节点');
    doneOnce({ content: out.join('\n') });
  }

  /* ---------------- 参数 ---------------- */
  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }
  function parseQuery(qs) {
    var out = {};
    if (!qs) return out;
    var pairs = qs.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var idx = pairs[i].indexOf('=');
      if (idx < 0) continue;
      var k = safeDecode(pairs[i].slice(0, idx)).trim();
      var v = safeDecode(pairs[i].slice(idx + 1));
      if (k) out[k] = v;
    }
    return out;
  }
  function parseParams(link) {
    var p = { inList: null, outList: null, emoji: true, sort: true };
    var hash = (link.split('#')[1] || '');
    if (!hash) return p;
    var q = parseQuery(hash);
    if (q['in']) p.inList = splitKeywords(q['in']);
    if (q['out']) p.outList = splitKeywords(q['out']);
    if (q['emoji'] === '0' || q['emoji'] === 'false') p.emoji = false;
    if (q['sort'] === '0' || q['sort'] === 'false') p.sort = false;
    return p;
  }
  function splitKeywords(s) {
    var arr = s.split('+');
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var w = arr[i].trim();
      if (w) out.push(w);
    }
    return out.length ? out : null;
  }

  /* ---------------- base64 ---------------- */
  var B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64decode(str) {
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
    while (s.length % 4) s += '=';
    var bytes = [];
    for (var i = 0; i < s.length; i += 4) {
      var n = (B64CHARS.indexOf(s.charAt(i)) << 18) |
              (B64CHARS.indexOf(s.charAt(i + 1)) << 12) |
              ((B64CHARS.indexOf(s.charAt(i + 2)) & 63) << 6) |
              (B64CHARS.indexOf(s.charAt(i + 3)) & 63);
      bytes.push((n >> 16) & 255);
      if (s.charAt(i + 2) !== '=') bytes.push((n >> 8) & 255);
      if (s.charAt(i + 3) !== '=') bytes.push(n & 255);
    }
    return utf8BytesToString(bytes);
  }
  function utf8BytesToString(bytes) {
    var out = '', i = 0;
    while (i < bytes.length) {
      var c = bytes[i++];
      if (c < 128) out += String.fromCharCode(c);
      else if (c > 191 && c < 224) out += String.fromCharCode(((c & 31) << 6) | (bytes[i++] & 63));
      else if (c > 223 && c < 240) out += String.fromCharCode(((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      else out += String.fromCharCode(((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
    }
    return out;
  }

  /* ---------------- 地区 ---------------- */
  var REGIONS = [
    { flag: '🇭🇰', rank: 1, keys: ['香港', 'HK', 'Hong'] },
    { flag: '🇹🇼', rank: 2, keys: ['台湾', '台灣', 'TW', 'Taiwan'] },
    { flag: '🇯🇵', rank: 3, keys: ['日本', 'JP', 'Japan'] },
    { flag: '🇸🇬', rank: 4, keys: ['新加坡', '狮城', '獅城', 'SG', 'Singapore'] },
    { flag: '🇰🇷', rank: 5, keys: ['韩国', '韓國', 'KR', 'Korea'] },
    { flag: '🇺🇸', rank: 6, keys: ['美国', '美國', 'US', 'States'] },
    { flag: '🇬🇧', rank: 7, keys: ['英国', 'UK', 'London'] },
    { flag: '🇩🇪', rank: 7, keys: ['德国', 'DE', 'Germany'] },
    { flag: '🇫🇷', rank: 7, keys: ['法国', 'FR', 'France'] },
    { flag: '🇨🇦', rank: 7, keys: ['加拿大', 'CA', 'Canada'] },
    { flag: '🇦🇺', rank: 7, keys: ['澳大利亚', '澳洲', 'AU', 'Australia'] },
    { flag: '🇳🇱', rank: 7, keys: ['荷兰', 'NL', 'Netherlands'] },
    { flag: '🇮🇳', rank: 7, keys: ['印度', 'IN', 'India'] },
    { flag: '🇹🇷', rank: 7, keys: ['土耳其', 'TR', 'Turkey'] },
    { flag: '🇷🇺', rank: 7, keys: ['俄罗斯', 'RU', 'Russia'] },
    { flag: '🇧🇷', rank: 7, keys: ['巴西', 'BR', 'Brazil'] },
    { flag: '🇮🇩', rank: 7, keys: ['印尼', '印度尼西亚', 'ID', 'Indonesia'] },
    { flag: '🇹🇭', rank: 7, keys: ['泰国', 'TH', 'Thailand'] },
    { flag: '🇻🇳', rank: 7, keys: ['越南', 'VN', 'Vietnam'] },
    { flag: '🇵🇭', rank: 7, keys: ['菲律宾', 'PH', 'Philippines'] },
    { flag: '🇲🇾', rank: 7, keys: ['马来西亚', 'MY', 'Malaysia'] },
    { flag: '🇦🇪', rank: 7, keys: ['阿联酋', '迪拜', 'AE', 'Dubai'] },
    { flag: '🇪🇸', rank: 7, keys: ['西班牙', 'ES', 'Spain'] },
    { flag: '🇮🇹', rank: 7, keys: ['意大利', 'IT', 'Italy'] },
    { flag: '🇳🇿', rank: 7, keys: ['新西兰', 'NZ'] },
    { flag: '🇲🇽', rank: 7, keys: ['墨西哥', 'MX', 'Mexico'] },
    { flag: '🇨🇭', rank: 7, keys: ['瑞士', 'CH', 'Switzerland'] },
    { flag: '🇸🇪', rank: 7, keys: ['瑞典', 'SE', 'Sweden'] }
  ];
  function hasFlag(tag) {
    return /[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]/.test(tag);
  }
  function matchKey(tag, key) {
    if (/[\u4e00-\u9fff]/.test(key)) return tag.indexOf(key) >= 0;
    if (key.length <= 2) {
      var re = new RegExp('(^|[^A-Za-z])' + key + '([^A-Za-z]|$)');
      return re.test(tag);
    }
    return tag.indexOf(key) >= 0;
  }
  function regionOf(tag) {
    if (!tag) return { flag: null, rank: 99 };
    for (var i = 0; i < REGIONS.length; i++) {
      var r = REGIONS[i];
      if (tag.indexOf(r.flag) >= 0) return r;
    }
    for (var j = 0; j < REGIONS.length; j++) {
      var r2 = REGIONS[j];
      for (var k = 0; k < r2.keys.length; k++) {
        if (matchKey(tag, r2.keys[k])) return r2;
      }
    }
    return { flag: null, rank: 99 };
  }

  /* ---------------- 内容识别 ---------------- */
  function isConfContent(t) {
    if (/^\s*\[/m.test(t)) return true;
    if (/\[general\]|\[server_local\]|\[filter_local\]|\[rewrite_local\]|\[policy\]/.test(t)) return true;
    return false;
  }
  function isQxLine(line) {
    return /^(shadowsocks|vmess|vless|trojan|hysteria2|anytls|http|snell|tuic|wireguard|socks5)=/.test(line.trim());
  }
  function isShareLink(line) {
    var s = line.trim();
    return /^(ss|vmess|vless|trojan|hysteria2|anytls):\/\//.test(s);
  }

  /* ---------------- 转成节点行 ---------------- */
  function anyNodeLine(lines) {
    for (var i = 0; i < lines.length; i++) {
      if (isShareLink(lines[i]) || isQxLine(lines[i])) return true;
    }
    return false;
  }
  function toNodeLines(trimmed) {
    var text = trimmed;
    var rawLines = splitLines(text);
    // base64 包起来的订阅：先解出来（里面可能是分享链接、QX 行，也可能是 Clash）
    if (!anyNodeLine(rawLines)) {
      try {
        var decoded = b64decode(text.replace(/\s+/g, ''));
        if (decoded && decoded !== text) {
          var decLines = splitLines(decoded);
          if (anyNodeLine(decLines) || /^proxies:/m.test(decoded)) {
            text = decoded;
            rawLines = decLines;
          }
        }
      } catch (e) {}
    }
    if (/^proxies:/m.test(text)) {
      var proxies = parseClash(text);
      var lines = [];
      for (var i = 0; i < proxies.length; i++) {
        var qx = proxyToQx(proxies[i]);
        if (qx) lines.push(qx);
      }
      if (lines.length) return lines;
    }
    var out = [];
    for (var k = 0; k < rawLines.length; k++) {
      var line = rawLines[k].trim();
      if (!line || line.charAt(0) === '#') continue;
      if (isQxLine(line)) { out.push(line); continue; }
      if (isShareLink(line)) {
        var qx2 = convertShareLink(line);
        if (qx2) out.push(qx2);
      }
    }
    return out;
  }
  function splitLines(s) {
    var arr = s.split('\n');
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var line = arr[i].trim();
      if (line) out.push(line);
    }
    return out;
  }

  /* ---------------- 分享链接转换 ---------------- */
  function splitLink(link) {
    // 返回 {main, tag}：去掉 # 后面的名字
    var hashIdx = link.indexOf('#');
    var tag = hashIdx >= 0 ? safeDecode(link.slice(hashIdx + 1)) : '';
    var main = hashIdx >= 0 ? link.slice(0, hashIdx) : link;
    return { main: main, tag: tag };
  }
  function splitHostPort(hp) {
    var colon = hp.lastIndexOf(':');
    if (colon < 0) return { host: hp, port: '' };
    return { host: hp.slice(0, colon), port: hp.slice(colon + 1) };
  }
  function convertShareLink(line) {
    try {
      var scheme = line.slice(0, line.indexOf('://'));
      var sp = splitLink(line);
      var main = sp.main;
      var tag = sp.tag;
      if (scheme === 'ss') return convertSS(main, tag);
      if (scheme === 'vmess') return convertVmess(main, tag);
      if (scheme === 'vless') return convertVless(main, tag);
      if (scheme === 'trojan') return convertTrojan(main, tag);
      if (scheme === 'hysteria2') return convertHy2(main, tag);
      if (scheme === 'anytls') return convertAnytls(main, tag);
    } catch (e) {
      log('跳过一条转不出的链接：' + line.slice(0, 40));
    }
    return null;
  }
  function convertSS(main, tag) {
    var rest = main.slice(5);
    var qIdx = rest.indexOf('?');
    var query = {};
    if (qIdx >= 0) { query = parseQuery(rest.slice(qIdx + 1)); rest = rest.slice(0, qIdx); }
    var method = '', password = '', host = '', port = '';
    var atIdx = rest.lastIndexOf('@');
    if (atIdx >= 0) {
      var userinfo = b64decode(rest.slice(0, atIdx));
      var cIdx = userinfo.indexOf(':');
      if (cIdx < 0) return null;
      method = userinfo.slice(0, cIdx);
      password = userinfo.slice(cIdx + 1);
      var hp = splitHostPort(rest.slice(atIdx + 1));
      host = hp.host; port = hp.port;
    } else {
      var decoded = b64decode(rest);
      var at2 = decoded.lastIndexOf('@');
      if (at2 < 0) return null;
      var up = decoded.slice(0, at2);
      var c2 = up.indexOf(':');
      if (c2 < 0) return null;
      method = up.slice(0, c2);
      password = up.slice(c2 + 1);
      var hp2 = splitHostPort(decoded.slice(at2 + 1));
      host = hp2.host; port = hp2.port;
    }
    if (!host || !port || !method) return null;
    return buildSS({ host: host, port: port, method: method, password: password, tag: tag });
  }
  function convertVmess(main, tag) {
    var json = b64decode(main.slice(8));
    var o = JSON.parse(json);
    if (!o.add || !o.port || !o.id) return null;
    return buildVmess({
      host: o.add, port: String(o.port), uuid: o.id,
      net: o.net || 'tcp', type: o.type || 'none',
      hostHeader: o.host || '', path: o.path || '',
      tls: (o.tls === 'tls'), sni: o.sni || '',
      tag: tag || o.ps || ''
    });
  }
  function convertVless(main, tag) {
    var rest = main.slice(8);
    var qIdx = rest.indexOf('?');
    var query = {};
    if (qIdx >= 0) { query = parseQuery(rest.slice(qIdx + 1)); rest = rest.slice(0, qIdx); }
    var atIdx = rest.lastIndexOf('@');
    if (atIdx < 0) return null;
    var uuid = rest.slice(0, atIdx);
    var hp = splitHostPort(rest.slice(atIdx + 1));
    if (!hp.host || !hp.port || !uuid) return null;
    return buildVless({
      host: hp.host, port: hp.port, uuid: uuid,
      security: query.security || 'none', sni: query.sni || '',
      pbk: query.pbk || '', sid: query.sid || '', flow: query.flow || '',
      net: query.type || 'tcp', path: query.path || '', hostHeader: query.host || '',
      tag: tag
    });
  }
  function convertTrojan(main, tag) {
    var rest = main.slice(9);
    var qIdx = rest.indexOf('?');
    var query = {};
    if (qIdx >= 0) { query = parseQuery(rest.slice(qIdx + 1)); rest = rest.slice(0, qIdx); }
    var atIdx = rest.lastIndexOf('@');
    if (atIdx < 0) return null;
    var password = safeDecode(rest.slice(0, atIdx));
    var hp = splitHostPort(rest.slice(atIdx + 1));
    if (!hp.host || !hp.port || !password) return null;
    return buildTrojan({
      host: hp.host, port: hp.port, password: password,
      sni: query.sni || '', insecure: query.allowInsecure === '1' || query.insecure === '1',
      tag: tag
    });
  }
  function convertHy2(main, tag) {
    var rest = main.slice(12);
    var qIdx = rest.indexOf('?');
    var query = {};
    if (qIdx >= 0) { query = parseQuery(rest.slice(qIdx + 1)); rest = rest.slice(0, qIdx); }
    var atIdx = rest.lastIndexOf('@');
    if (atIdx < 0) return null;
    var password = safeDecode(rest.slice(0, atIdx));
    var hp = splitHostPort(rest.slice(atIdx + 1));
    if (!hp.host || !hp.port || !password) return null;
    return buildHy2({
      host: hp.host, port: hp.port, password: password,
      sni: query.sni || '', insecure: query.insecure === '1',
      obfs: query.obfs || '', obfsPassword: query['obfs-password'] || '',
      ports: query.mport || '', tag: tag
    });
  }
  function convertAnytls(main, tag) {
    var rest = main.slice(9);
    var qIdx = rest.indexOf('?');
    var query = {};
    if (qIdx >= 0) { query = parseQuery(rest.slice(qIdx + 1)); rest = rest.slice(0, qIdx); }
    var atIdx = rest.lastIndexOf('@');
    if (atIdx < 0) return null;
    var password = safeDecode(rest.slice(0, atIdx));
    var hp = splitHostPort(rest.slice(atIdx + 1));
    if (!hp.host || !hp.port || !password) return null;
    return buildAnytls({
      host: hp.host, port: hp.port, password: password,
      sni: query.sni || '', insecure: query.insecure === '1',
      tag: tag
    });
  }

  /* ---------------- QX 行生成器 ---------------- */
  function qxLine(type, addr, params, tag) {
    var parts = [type + '=' + addr];
    for (var i = 0; i < params.length; i++) {
      if (params[i]) parts.push(params[i]);
    }
    if (tag) parts.push('tag=' + tag);
    return parts.join(', ');
  }
  function buildSS(o) {
    return qxLine('shadowsocks', o.host + ':' + o.port,
      ['method=' + (o.method || 'aes-256-gcm'), 'password=' + o.password], o.tag);
  }
  function buildVmess(o) {
    var params = ['method=chacha20-poly1305', 'password=' + o.uuid];
    if (o.net === 'ws') {
      params.push('obfs=' + (o.tls ? 'wss' : 'ws'));
      params.push('obfs-host=' + (o.hostHeader || o.host));
      params.push('obfs-uri=' + (o.path || '/'));
    } else if (o.net === 'tcp' && o.type === 'http') {
      params.push('obfs=http');
      params.push('obfs-host=' + (o.hostHeader || o.host));
      params.push('obfs-uri=' + (o.path || '/'));
    }
    params.push('fast-open=false', 'udp-relay=false');
    return qxLine('vmess', o.host + ':' + o.port, params, o.tag);
  }
  function buildVless(o) {
    var params = ['method=none', 'password=' + o.uuid];
    if (o.security === 'reality') {
      params.push('obfs=over-tls');
      if (o.sni) params.push('obfs-host=' + o.sni);
      if (o.pbk) params.push('reality-base64-pubkey=' + o.pbk);
      if (o.sid) params.push('reality-hex-shortid=' + o.sid);
      if (o.flow) params.push('vless-flow=' + o.flow);
    } else if (o.security === 'tls') {
      params.push('obfs=over-tls');
      if (o.sni) params.push('obfs-host=' + o.sni);
    }
    if (o.net === 'ws') {
      params.push('obfs=' + (o.security === 'tls' || o.security === 'reality' ? 'wss' : 'ws'));
      params.push('obfs-host=' + (o.hostHeader || o.sni || o.host));
      params.push('obfs-uri=' + (o.path || '/'));
    }
    params.push('udp-relay=true');
    return qxLine('vless', o.host + ':' + o.port, params, o.tag);
  }
  function buildTrojan(o) {
    var params = ['password=' + o.password, 'over-tls=true'];
    if (o.sni) params.push('tls-host=' + o.sni);
    params.push('tls-verification=' + (o.insecure ? 'false' : 'true'));
    params.push('fast-open=false', 'udp-relay=false');
    return qxLine('trojan', o.host + ':' + o.port, params, o.tag);
  }
  function buildHy2(o) {
    var params = ['password=' + o.password];
    if (o.obfs === 'salamander' && o.obfsPassword) params.push('salamander-password=' + o.obfsPassword);
    if (o.sni) params.push('tls-host=' + o.sni);
    params.push('tls-verification=' + (o.insecure ? 'false' : 'true'));
    params.push('udp-relay=true');
    if (o.ports) params.push('port-hopping=' + o.ports);
    return qxLine('hysteria2', o.host + ':' + o.port, params, o.tag);
  }
  function buildAnytls(o) {
    var params = ['password=' + o.password, 'over-tls=true'];
    if (o.sni) params.push('tls-host=' + o.sni);
    params.push('tls-alpn=08687474702f312e31');
    params.push('tls-verification=' + (o.insecure ? 'false' : 'true'));
    params.push('fast-open=false', 'udp-relay=true');
    return qxLine('anytls', o.host + ':' + o.port, params, o.tag);
  }

  /* ---------------- Clash YAML ---------------- */
  function stripQuotes(s) {
    s = (s || '').trim();
    if ((s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') ||
        (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")) {
      s = s.slice(1, -1);
    }
    return s;
  }
  function parseClash(content) {
    var lines = content.split('\n');
    var proxies = [];
    var cur = null;
    var inProxies = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^proxies:\s*$/.test(line)) { inProxies = true; continue; }
      if (!inProxies) continue;
      var item = line.match(/^(\s*)- (.*)$/);
      if (item) {
        if (cur) proxies.push(cur);
        cur = { _indent: item[1].length };
        var first = item[2];
        var kv = first.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (kv) cur[kv[1]] = stripQuotes(kv[2]);
        continue;
      }
      if (cur) {
        var kv2 = line.match(/^(\s+)([A-Za-z0-9_-]+):\s*(.*)$/);
        if (kv2 && kv2[1].length > cur._indent) {
          if (kv2[2] === 'ws-headers' || kv2[2] === 'headers') continue;
          if (/^Host:/.test(kv2[3])) { cur['ws-host'] = stripQuotes(kv2[3].slice(5)); continue; }
          cur[kv2[2]] = stripQuotes(kv2[3]);
        } else if (/^\S/.test(line)) {
          inProxies = false;
          proxies.push(cur);
          cur = null;
        }
      }
    }
    if (cur) proxies.push(cur);
    return proxies;
  }
  function proxyToQx(p) {
    try {
      var type = (p.type || '').toLowerCase();
      var host = p.server || '';
      var port = String(p.port || '');
      if (!host || !port) return null;
      var tag = p.name || '';
      if (type === 'ss') {
        return buildSS({ host: host, port: port, method: p.cipher || 'aes-256-gcm', password: p.password || '', tag: tag });
      }
      if (type === 'vmess') {
        return buildVmess({
          host: host, port: port, uuid: p.uuid || '',
          net: p.network || 'tcp', type: 'none',
          hostHeader: p['ws-headers-Host'] || p['ws-host'] || '',
          path: p['ws-path'] || '', tls: (p.tls === true || p.tls === 'true'),
          sni: p.servername || p.sni || '', tag: tag
        });
      }
      if (type === 'vless') {
        return buildVless({
          host: host, port: port, uuid: p.uuid || '',
          security: (p.tls === true || p.tls === 'true') ? 'tls' : 'none',
          sni: p.servername || p.sni || '', pbk: p['reality-opts'] ? '' : (p.publicKey || p.pbk || ''),
          sid: p['short-id'] || p.sid || '', flow: p.flow || '',
          net: p.network || 'tcp', path: p['ws-path'] || '',
          hostHeader: p['ws-headers-Host'] || p['ws-host'] || '', tag: tag
        });
      }
      if (type === 'trojan') {
        return buildTrojan({
          host: host, port: port, password: p.password || '',
          sni: p.sni || p.servername || '',
          insecure: (p['skip-cert-verify'] === true || p['skip-cert-verify'] === 'true'),
          tag: tag
        });
      }
      if (type === 'hysteria2') {
        return buildHy2({
          host: host, port: port, password: p.password || '',
          sni: p.sni || '', insecure: (p['skip-cert-verify'] === true || p['skip-cert-verify'] === 'true'),
          obfs: p.obfs || '', obfsPassword: p['obfs-password'] || '',
          ports: p.ports || p.mport || '', tag: tag
        });
      }
      if (type === 'anytls') {
        return buildAnytls({
          host: host, port: port, password: p.password || '',
          sni: p.sni || '', insecure: (p['skip-cert-verify'] === true || p['skip-cert-verify'] === 'true'),
          tag: tag
        });
      }
    } catch (e) {}
    return null;
  }

  /* ---------------- 整理 ---------------- */
  function splitQxLine(line) {
    var s = line.trim();
    var eq = s.indexOf('=');
    var type = s.slice(0, eq);
    var rest = s.slice(eq + 1);
    // 很多面板生成的是不带空格的逗号分隔：type=host:port,method=...,tag=...
    // 只按 ", " 切会把整行当成一个参数，重建时就会多出一个 tag，QX 直接拒收
    var segs = rest.split(',');
    var addr = (segs[0] || '').trim();
    var params = [];
    for (var i = 1; i < segs.length; i++) {
      var kv = segs[i].trim();
      var ei = kv.indexOf('=');
      if (ei < 0) continue;
      params.push({ k: kv.slice(0, ei).trim(), v: kv.slice(ei + 1).trim() });
    }
    return { type: type, addr: addr, params: params };
  }
  function buildQxLineFromParts(p) {
    var parts = [p.type + '=' + p.addr];
    for (var i = 0; i < p.params.length; i++) parts.push(p.params[i].k + '=' + p.params[i].v);
    return parts.join(', ');
  }
  function getParam(p, key) {
    for (var i = 0; i < p.params.length; i++) {
      if (p.params[i].k === key) return p.params[i].v;
    }
    return '';
  }
  function setParam(p, key, value) {
    for (var i = 0; i < p.params.length; i++) {
      if (p.params[i].k === key) { p.params[i].v = value; return; }
    }
    var tagIdx = -1;
    for (var j = 0; j < p.params.length; j++) {
      if (p.params[j].k === 'tag') { tagIdx = j; break; }
    }
    var item = { k: key, v: value };
    if (tagIdx >= 0) p.params.splice(tagIdx, 0, item);
    else p.params.push(item);
  }
  function transformLines(lines, params) {
    var seen = {};
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var p = splitQxLine(lines[i]);
      if (!p.addr) continue;
      var tag = getParam(p, 'tag') || '';
      if (params.inList) {
        var keep = false;
        for (var a = 0; a < params.inList.length; a++) {
          if (tag.indexOf(params.inList[a]) >= 0) { keep = true; break; }
        }
        if (!keep) continue;
      }
      if (params.outList) {
        var drop = false;
        for (var b = 0; b < params.outList.length; b++) {
          if (tag.indexOf(params.outList[b]) >= 0) { drop = true; break; }
        }
        if (drop) continue;
      }
      if (params.emoji && tag && !hasFlag(tag)) {
        var r = regionOf(tag);
        if (r.flag) setParam(p, 'tag', r.flag + tag);
      }
      if (p.type === 'hysteria2' || p.type === 'vless') setParam(p, 'udp-relay', 'true');
      var line = buildQxLineFromParts(p);
      var finalTag = getParam(p, 'tag') || line;
      if (finalTag && seen[finalTag]) continue;
      if (finalTag) seen[finalTag] = true;
      out.push(line);
    }
    if (params.sort) {
      out.sort(function (x, y) {
        var tx = getTagOfLine(x), ty = getTagOfLine(y);
        var rx = regionOf(tx).rank, ry = regionOf(ty).rank;
        if (rx !== ry) return rx - ry;
        return tx < ty ? -1 : (tx > ty ? 1 : 0);
      });
    }
    return out;
  }
  function getTagOfLine(line) {
    var m = line.match(/,\s*tag=(.+?)\s*$/);
    return m ? m[1] : '';
  }

  try {
    main();
  } catch (e) {
    log('出错，原样返回：' + (e && e.message));
    doneOnce({ content: ($resource && $resource.content) || '' });
  }
})();
