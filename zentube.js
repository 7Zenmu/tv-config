/*ZTV:12*/
/*
 * ZenTube — a TizenBrew module for Samsung TVs.
 * Loads TizenTube (ad blocking, SponsorBlock, remote-friendly settings) and adds a
 * "subscriptions only" rule: outside of Search, every video from a channel you are not
 * subscribed to is removed — Home, Subscriptions page shelves, the related videos under
 * the player, autoplay, everywhere.
 *
 * How it knows your subscriptions: the TV app's sidebar data lists your subscribed channels,
 * and the Subscriptions feed only contains them. ZenTube reads both as they load and keeps
 * the list on the TV (localStorage). Nothing is sent anywhere.
 *
 * Plain ES5 on purpose: older Samsung TVs run an old browser engine.
 */
(function () {
  'use strict';
  if (window.__zenTubeLoaded) return;
  window.__zenTubeLoaded = true;

  // ───────────────────────── SETTINGS (edit these) ─────────────────────────
  var CONFIG = {
    allowInSearch: true,        // search results are left untouched
    allowOnChannelPages: true,  // a channel's own page shows its videos (you went there on purpose)
    allowInLibrary: true,       // your history, Watch Later and saved playlists are left untouched
    // false = keep YouTube's "what's next" data, so the end-of-video screen with recommendations appears.
    // Whether it auto-plays is then YouTube's own Autoplay switch (Settings in the YouTube sidebar).
    // true = remove that data: single videos just close when they end (no end screen).
    disableAutoplayNext: false,
    hideShortsTab: true,
    hideShorts: false,          // false = Shorts follow the same rule as videos (only your channels); true = no Shorts at all
    showStatus: false,          // true = show the debug status box for 3 minutes after start
    hideSidebarTabs: ['FEtopics_gaming', 'FEtopics_live', 'FEtopics_movies', 'FEtopics_music',
      'FEtopics_news', 'FEtopics_podcasts', 'FEtopics_sports', 'FEtopics_more'],
    loadTizenTube: true,
    // TizenTube is locked to an exact version. When a newer one exists, a prompt on the TV
    // asks before switching. Nothing new runs until you choose "Update" with the remote.
    tizenTubeVersion: '1.15.2',
    askAboutTizenTubeUpdates: true
  };
  var TT_PKG = '@foxreis/tizentube';
  var TT_APPROVED_KEY = 'zentube-tizentube-approved-version';
  var TT_SKIP_KEY = 'zentube-tizentube-skipped-version';

  // TizenTube settings applied once on first run (you can still change them in TizenTube's menu).
  var TIZENTUBE_ZEN_DEFAULTS = {
    enablePreviews: false,                // no auto-playing previews when a thumbnail is focused
    enableHideEndScreenCards: true,
    hideRelatedVideosPlayer: false,       // keep "related", ZenTube filters it to your subscriptions
    disabledSidebarContents: ['FEtopics_gaming', 'FEtopics_live', 'FEtopics_movies', 'FEtopics_music',
      'FEtopics_news', 'FEtopics_podcasts', 'FEtopics_sports', 'FEtopics_more']
  };
  // ──────────────────────────────────────────────────────────────────────────

  var SUBS_KEY = 'zentube-subscriptions-v1';
  var DEFAULTS_FLAG = 'zentube-defaults-applied-v2';
  var CHANNEL_RE = /^UC[\w-]{22}$/;

  // ── temporary diagnostics box (shown for the first 90 s after YouTube opens) ──
  var ZT_BUILD = 'v12';
  var diag = { start: Date.now(), tt: 'starting', parses: 0, processed: 0, removed: 0, kept: 0, other: {}, browse: [], subsFetch: 'not tried', err: '' };
  function noteOther(it) {
    if (!it || typeof it !== 'object' || isArray(it)) return;
    for (var k in it) {
      if (!it.hasOwnProperty(k)) continue;
      if (/(Renderer|ViewModel)$/.test(k) && !/shelf|section|grid|list|header|continuation|guide|button|menu|spacer|chip|tab|line|metadata|thumbnail|overlay|badge|icon|text/i.test(k)) diag.other[k] = (diag.other[k] || 0) + 1;
      return;
    }
  }
  function loaderInfo() {
    var L = window.__zenLoader;
    if (!L) return 'none';
    return 'ran ' + L.ran + ', eval ' + (L.evalOk ? 'ok' : 'BLOCKED') + ', online latest ' + (L.fetched || '…') + (L.err ? ', ' + L.err : '');
  }
  var diagEl = null;
  function drawDiag() {
    try {
      var root = document.documentElement;
      if (!root) return;
      if (Date.now() - diag.start > 180000) { if (diagEl && diagEl.parentNode) diagEl.parentNode.removeChild(diagEl); return; }
      if (!diagEl) {
        diagEl = document.createElement('div');
        var st = diagEl.style;
        st.position = 'fixed'; st.left = '20px'; st.bottom = '20px'; st.zIndex = '2147483647';
        st.background = 'rgba(0,0,0,0.85)'; st.color = '#fff'; st.font = '22px/1.35 Arial, sans-serif';
        st.padding = '14px 20px'; st.borderRadius = '12px'; st.maxWidth = '1000px'; st.whiteSpace = 'pre-line';
        st.pointerEvents = 'none';
      }
      var host = document.body || root;
      if (diagEl.parentNode !== host) host.appendChild(diagEl);
      var others = [];
      for (var k in diag.other) if (diag.other.hasOwnProperty(k)) others.push(k + ' ' + diag.other[k]);
      others.sort(function (a, b) { return parseInt(b.split(' ')[1], 10) - parseInt(a.split(' ')[1], 10); });
      diagEl.textContent = 'ZenTube ' + ZT_BUILD + ' running\n' +
        'TizenTube: ' + diag.tt + '\n' +
        'Subscriptions known: ' + subs.count + ' ids, ' + subs.nameCount + ' names (fetch: ' + diag.subsFetch + ')\n' +
        'Data seen: ' + diag.parses + ' · checked: ' + diag.processed + '\n' +
        'Videos kept: ' + diag.kept + ' · removed: ' + diag.removed + '\n' +
        'Pages: ' + (diag.browse.join(', ') || '-') + '\n' +
        'Other items: ' + (others.slice(0, 5).join(', ') || '-') + '\n' +
        'Loader: ' + loaderInfo() + '\n' +
        'Sub list at: ' + (diag.subPath || '-') + '\n' +
        'A removed video: ' + (diag.sample || '-') +
        (diag.err ? '\nError: ' + diag.err : '');
    } catch (e) { }
  }
  if (CONFIG.showStatus) setInterval(drawDiag, 1000);
  var dumpEl = null;
  if (CONFIG.showStatus) setInterval(function () {
    try {
      if (Date.now() - diag.start > 300000) { if (dumpEl && dumpEl.parentNode) dumpEl.parentNode.removeChild(dumpEl); return; }
      if (!diag.chanDump && !diag.vidDump) return;
      if (!dumpEl) {
        dumpEl = document.createElement('div');
        var st = dumpEl.style;
        st.position = 'fixed'; st.right = '10px'; st.top = '10px'; st.zIndex = '2147483647'; st.width = '940px';
        st.background = 'rgba(0,0,0,0.9)'; st.color = '#fff'; st.font = '17px/1.25 Arial, sans-serif';
        st.padding = '10px 14px'; st.whiteSpace = 'pre-wrap'; st.wordBreak = 'break-all'; st.pointerEvents = 'none';
      }
      var host = document.body || document.documentElement;
      if (dumpEl.parentNode !== host) host.appendChild(dumpEl);
      dumpEl.textContent = 'CHANNEL-LIST ITEM:\n' + (diag.chanDump || '(not seen yet: open Subscriptions)') + '\n\nA VIDEO ITEM:\n' + (diag.vidDump || '-');
    } catch (e) { }
  }, 1500);
  function diagSummary() {
    return 'ZenTube ' + ZT_BUILD + ' running\n' +
      'TizenTube: ' + diag.tt + '\n' +
      'Subscriptions known: ' + subs.count + ' ids, ' + subs.nameCount + ' names (fetch: ' + diag.subsFetch + ')\n' +
      'Data seen: ' + diag.parses + ', checked: ' + diag.processed + '\n' +
      'Videos kept: ' + diag.kept + ', removed: ' + diag.removed + '\n' +
      'Pages: ' + (diag.browse.join(', ') || '-') + '\n' +
      'Loader: ' + loaderInfo() + '\n' +
      'Sub list at: ' + (diag.subPath || '-') + '\n' +
      'A removed video: ' + (diag.sample || '-') +
      (diag.err ? '\nError: ' + diag.err : '');
  }
  // Temporary: one pop-up 25 s after start with the same status (press OK to close).


  function log() { try { console.log.apply(console, ['[ZenTube]'].concat([].slice.call(arguments))); } catch (e) { } }
  function get(o, path) {
    var p = path.split('.');
    for (var i = 0; i < p.length; i++) { if (o == null) return undefined; o = o[p[i]]; }
    return o;
  }
  function isArray(o) { return Object.prototype.toString.call(o) === '[object Array]'; }
  function normName(n) { return String(n || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function textOf(t) {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (t.simpleText) return t.simpleText;
    if (t.content) return t.content;
    if (t.runs) { var s = ''; for (var i = 0; i < t.runs.length; i++) s += t.runs[i].text || ''; return s; }
    return '';
  }

  // ── subscription list ──
  var subs = { ids: {}, names: {}, count: 0, nameCount: 0 };
  (function loadSubs() {
    try {
      var s = JSON.parse(window.localStorage.getItem(SUBS_KEY));
      if (s && s.ids) { subs.ids = s.ids; subs.names = s.names || {}; for (var k in subs.ids) if (subs.ids.hasOwnProperty(k)) subs.count++; }
      for (var n in subs.names) if (subs.names.hasOwnProperty(n)) subs.nameCount++;
    } catch (e) { }
  })();
  var saveTimer = null;
  function saveSubs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { window.localStorage.setItem(SUBS_KEY, JSON.stringify({ ids: subs.ids, names: subs.names })); } catch (e) { }
    }, 500);
  }
  function addSub(id, name) {
    var hasId = !!(id && CHANNEL_RE.test(id));
    if (hasId && !subs.ids[id]) { subs.ids[id] = 1; subs.count++; saveSubs(); }
    if (name) {
      var n = normName(name);
      if (n && !subs.names[n]) subs.nameCount++;
      if (n && subs.names[n] !== (hasId ? id : (subs.names[n] || 'name'))) { subs.names[n] = hasId ? id : 'name'; saveSubs(); }
    }
  }
  function removeSub(id, name) {
    if (id && subs.ids[id]) { delete subs.ids[id]; subs.count--; }
    var nn = normName(name);
    for (var n in subs.names) {
      if (subs.names.hasOwnProperty(n) && ((id && subs.names[n] === id) || (nn && n === nn))) { delete subs.names[n]; subs.nameCount--; }
    }
    saveSubs();
  }
  // Replace the whole name list (used when the full channel list from the Subscriptions page is read).
  function replaceNames(list) {
    var names = {}, c = 0;
    for (var i = 0; i < list.length; i++) {
      var n = normName(list[i]);
      if (n && !names[n]) { names[n] = subs.names[n] && subs.names[n] !== 'name' ? subs.names[n] : 'name'; c++; }
    }
    subs.names = names; subs.nameCount = c;
    saveSubs();
  }

  // Sidebar ("guide") data: subscribed channels appear as guide entries pointing at UC… ids.
  function learnFromGuide(o, depth) {
    if (!o || typeof o !== 'object' || depth > 25) return;
    if (o.guideEntryRenderer) {
      var g = o.guideEntryRenderer;
      var id = get(g, 'navigationEndpoint.browseEndpoint.browseId');
      if (id && CHANNEL_RE.test(id)) addSub(id, textOf(g.formattedTitle) || textOf(g.title));
    }
    for (var k in o) if (o.hasOwnProperty(k) && typeof o[k] === 'object') learnFromGuide(o[k], depth + 1);
  }

  // Channel page header tells us whether we're subscribed (keeps the list current after (un)subscribing).
  function learnFromChannelPage(r, browseId) {
    if (!browseId || !CHANNEL_RE.test(browseId)) return;
    var found = null;
    (function walk(o, d) {
      if (found !== null || !o || typeof o !== 'object' || d > 20) return;
      if (o.subscribeButtonRenderer && typeof o.subscribeButtonRenderer.subscribed === 'boolean'
        && (!o.subscribeButtonRenderer.channelId || o.subscribeButtonRenderer.channelId === browseId)) {
        found = o.subscribeButtonRenderer.subscribed; return;
      }
      for (var k in o) if (o.hasOwnProperty(k)) walk(o[k], d + 1);
    })(r, 0);
    if (found === true) addSub(browseId, textOf(get(r, 'contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.header.channelHeaderRenderer.title')));
    if (found === false) removeSub(browseId, textOf(get(r, 'contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.header.channelHeaderRenderer.title')));
  }

  // ── what channel(s) is a video tile from? ──
  function channelIdsIn(o, out, depth) {
    if (!o || typeof o !== 'object' || depth > 20) return out;
    for (var k in o) {
      if (!o.hasOwnProperty(k)) continue;
      var v = o[k];
      if (typeof v === 'string') { if ((k === 'browseId' || k === 'channelId' || k === 'externalChannelId') && CHANNEL_RE.test(v)) out.push(v); }
      else if (v && typeof v === 'object') channelIdsIn(v, out, depth + 1);
    }
    return out;
  }
  function channelNameOf(item) {
    if (item.tileRenderer) {
      var its = get(item, 'tileRenderer.metadata.tileMetadataRenderer.lines.0.lineRenderer.items') || [];
      for (var i = 0; i < its.length; i++) {
        var t = textOf(get(its[i], 'lineItemRenderer.text'));
        if (t && t.replace(/\s/g, '')) return t;
      }
      return '';
    }
    if (item.lockupViewModel) {
      return textOf(get(item, 'lockupViewModel.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows.0.metadataParts.0.text'));
    }
    return '';
  }
  function isVideoItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.tileRenderer) {
      var t = item.tileRenderer;
      return !!(get(t, 'onSelectCommand.watchEndpoint') || get(t, 'onSelectCommand.reelWatchEndpoint') || t.contentType === 'TILE_CONTENT_TYPE_VIDEO');
    }
    if (item.lockupViewModel) {
      var c = item.lockupViewModel.contentType;
      return c === 'LOCKUP_CONTENT_TYPE_VIDEO' || c === 'LOCKUP_CONTENT_TYPE_SHORT' || !!get(item, 'lockupViewModel.rendererContext.commandContext.onTap.innertubeCommand.watchEndpoint');
    }
    return false;
  }
  var currentBrowseId = null;
  function isShortItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.tileRenderer) {
      var t = item.tileRenderer;
      return !!get(t, 'onSelectCommand.reelWatchEndpoint') || /SHORTS/.test(String(t.contentType || '')) || /SHORTS/.test(String(t.tvhtml5ShelfRendererType || ''));
    }
    if (item.lockupViewModel) return item.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_SHORT';
    return !!(item.reelItemRenderer || item.shortsLockupViewModel);
  }
  function isFromSubscription(item) {
    var ids = channelIdsIn(item, [], 0);
    for (var i = 0; i < ids.length; i++) if (subs.ids[ids[i]]) return true;
    var raw = channelNameOf(item);
    // Collaborations show as "A and B", "A y B", "A & B", "A, B"…: any subscribed part counts.
    var parts = String(raw || '').split(/\s+(?:and|y|e|et|und|&)\s+|,\s*/i);
    for (var p = 0; p < parts.length; p++) { var pn = normName(parts[p]); if (pn && subs.names[pn]) return true; }
    var n = normName(raw);
    return !!(n && subs.names[n]);
  }

  // Remove every video tile not from a subscribed channel, anywhere inside the response.
  function filterTree(o, depth) {
    if (!o || typeof o !== 'object' || depth > 40) return 0;
    var removed = 0;
    if (isArray(o)) {
      if (o.__zenKeepAll) return 0;
      for (var i = o.length - 1; i >= 0; i--) {
        var it = o[i];
        if (isShortItem(it)) {
          var keepShort = !CONFIG.hideShorts && (isFromSubscription(it) || (currentBrowseId === 'FEsubscriptions' && !channelNameOf(it)));
          if (!keepShort) { o.splice(i, 1); removed++; diag.removed++; continue; }
          diag.kept++;
          continue;
        }
        if (isVideoItem(it)) {
          if (!isFromSubscription(it)) {
            if (!diag.sample) diag.sample = 'ids ' + uniq(channelIdsIn(it, [], 0)).length + ', channel "' + channelNameOf(it) + '"';
            if (!diag.vidDump) diag.vidDump = dumpItem(it);
            o.splice(i, 1); removed++; diag.removed++; continue;
          }
          diag.kept++;
        } else noteOther(it);
        removed += filterTree(it, depth + 1);
        if (isEmptyShelf(it)) o.splice(i, 1);
      }
      return removed;
    }
    for (var k in o) if (o.hasOwnProperty(k)) removed += filterTree(o[k], depth + 1);
    return removed;
  }

  function markSubscriptionGrids(r) {
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 30) return;
      if (o.gridRenderer && isArray(o.gridRenderer.items)) o.gridRenderer.items.__zenKeepAll = true;
      if (isArray(get(o, 'gridContinuation.items'))) o.gridContinuation.items.__zenKeepAll = true;
      for (var k in o) if (o.hasOwnProperty(k) && o[k] && typeof o[k] === 'object') walk(o[k], d + 1);
    })(r, 0);
  }
  // "Explore more topics": a row of search suggestions. Remove the whole row.
  function isSearchTile(it) {
    var t = it && (it.tileRenderer || it.lockupViewModel);
    if (!t) return false;
    return !!(get(t, 'onSelectCommand.searchEndpoint') || get(t, 'rendererContext.commandContext.onTap.innertubeCommand.searchEndpoint'));
  }
  function removeExploreTopics(r) {
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 30) return;
      if (isArray(o)) {
        for (var i = o.length - 1; i >= 0; i--) {
          var items = get(o[i], 'shelfRenderer.content.horizontalListRenderer.items');
          if (isArray(items) && items.length) {
            var allSearch = true;
            for (var j = 0; j < items.length; j++) if (!isSearchTile(items[j])) { allSearch = false; break; }
            if (allSearch) { o.splice(i, 1); continue; }
          }
          walk(o[i], d + 1);
        }
        return;
      }
      for (var k in o) if (o.hasOwnProperty(k) && o[k] && typeof o[k] === 'object') walk(o[k], d + 1);
    })(r, 0);
  }
  // A row whose videos were all removed (or a Shorts row): drop it instead of showing grey placeholders.
  function isEmptyShelf(it) {
    if (!it || typeof it !== 'object') return false;
    var sh = it.shelfRenderer;
    if (!sh) return false;
    if (CONFIG.hideShorts && /SHORTS/.test(String(sh.tvhtml5ShelfRendererType || ''))) return true;
    var items = get(sh, 'content.horizontalListRenderer.items') || get(sh, 'content.gridRenderer.items');
    return isArray(items) && items.length === 0;
  }

  // ── which responses are exempt ──
  function browseIdOf(r) {
    var stp = get(r, 'responseContext.serviceTrackingParams');
    if (!stp || !stp.length) return null;
    for (var i = 0; i < stp.length; i++) {
      var ps = stp[i].params || [];
      for (var j = 0; j < ps.length; j++) if (ps[j].key === 'browse_id') return ps[j].value;
    }
    return null;
  }
  function onSearchScreen() { return /[#\/]search/i.test(window.location.hash || ''); }
  function isSearchResponse(r) { return r.estimatedResults !== undefined || !!get(r, 'contents.sectionListRenderer.searchHeader') || onSearchScreen(); }
  function isLibraryBrowse(id) { return !!id && (id === 'FElibrary' || id === 'FEhistory' || id === 'FEplaylist_aggregation' || /^VL/.test(id)); }
  function looksLikeGuide(r) {
    if (!r.items || !isArray(r.items)) return false;
    for (var i = 0; i < r.items.length; i++) if (r.items[i] && (r.items[i].guideSectionRenderer || r.items[i].guideSubscriptionsSectionRenderer)) return true;
    return false;
  }

  function hideGuideEntries(r) {
    for (var i = 0; i < r.items.length; i++) {
      var sec = r.items[i] && r.items[i].guideSectionRenderer;
      if (!sec || !isArray(sec.items)) continue;
      for (var j = sec.items.length - 1; j >= 0; j--) {
        var g = sec.items[j] && sec.items[j].guideEntryRenderer;
        if (!g) continue;
        var id = get(g, 'navigationEndpoint.browseEndpoint.browseId') || '';
        var icon = String(get(g, 'icon.iconType') || '');
        var isShorts = /shorts/i.test(id) || /SHORTS/.test(icon) || !!get(g, 'navigationEndpoint.reelWatchEndpoint');
        if (CONFIG.hideSidebarTabs.indexOf(id) >= 0 || (CONFIG.hideShortsTab && isShorts)) sec.items.splice(j, 1);
      }
    }
  }

  function zenProcess(r) {
    if (!r || typeof r !== 'object' || isArray(r)) return;
    if (looksLikeGuide(r)) { learnFromGuide(r, 0); hideGuideEntries(r); return; }
    if (!r.contents && !r.continuationContents && !r.onResponseReceivedActions) return;

    var bid = browseIdOf(r);
    if (bid) currentBrowseId = bid;
    else if (!r.continuationContents && !r.onResponseReceivedActions) currentBrowseId = null;
    diag.processed++;
    if (bid && diag.browse.indexOf(bid) < 0) { diag.browse.push(bid); if (diag.browse.length > 4) diag.browse.shift(); }
    if (bid === 'FEsubscriptions') {
      // Items in the chronological feed are from your subscriptions; YouTube's recommendation
      // shelves on this page still get filtered below.
      learnFromSubscriptionsFeed(r);
    }
    if (bid && CHANNEL_RE.test(bid)) {
      learnFromChannelPage(r, bid);
      if (CONFIG.allowOnChannelPages) return;
    }
    if (CONFIG.allowInSearch && isSearchResponse(r)) return;
    if (CONFIG.allowInLibrary && isLibraryBrowse(bid)) return;

    // Watch page: a playlist or mix you chose keeps autoplaying and its queue is left as is.
    // A single video gets no autoplay-next.
    var sc = get(r, 'contents.singleColumnWatchNextResults');
    var queue = null;
    if (sc) {
      var inPlaylist = !!sc.playlist || /[?&]list=/.test(window.location.href);
      if (CONFIG.disableAutoplayNext && !inPlaylist && sc.autoplay) delete sc.autoplay;
      if (inPlaylist) { queue = { playlist: sc.playlist, autoplay: sc.autoplay }; delete sc.playlist; delete sc.autoplay; }
    }
    removeExploreTopics(r);
    // The Subscriptions page only lists your channels' videos: never filter it (no gaps, nothing lost).
    var onSubsPage = currentBrowseId === 'FEsubscriptions' || /FEsubscriptions/.test(window.location.hash || '');
    if (onSubsPage && !get(r, 'contents.singleColumnWatchNextResults')) return;
    var n = filterTree(r, 0);
    if (queue) {
      if (queue.playlist !== undefined) sc.playlist = queue.playlist;
      if (queue.autoplay !== undefined) sc.autoplay = queue.autoplay;
    }
    if (n) log('removed', n, 'videos from channels you are not subscribed to');
  }

  // The TV Subscriptions page lists every subscribed channel as a tab on the left.
  function learnFromSubscriptionTabs(r) {
    var found = 0;
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 25) return;
      if (o.tabRenderer) {
        var t = o.tabRenderer;
        var id = get(t, 'endpoint.browseEndpoint.browseId') || get(t, 'navigationEndpoint.browseEndpoint.browseId');
        if (id && CHANNEL_RE.test(id)) { addSub(id, textOf(t.title)); found++; }
      }
      for (var k in o) if (o.hasOwnProperty(k) && typeof o[k] === 'object') walk(o[k], d + 1);
    })(r, 0);
    return found;
  }

  // Grid of the Subscriptions feed (not the shelves YouTube mixes in) = subscribed channels.
  // Any channel id on the Subscriptions page that is NOT inside a video tile belongs to the
  // channel list on the left (your subscriptions). Its title gives the channel name.
  function learnFromChannelList(r) {
    var found = 0;
    (function walk(o, path, d) {
      if (!o || typeof o !== 'object' || d > 30) return;
      if (isVideoItem(o)) return;
      var item = o.tileRenderer || o.lockupViewModel || o.tabRenderer || o.guideEntryRenderer || o.gridChannelRenderer || o.channelRenderer;
      if (item && !diag.chanDump) diag.chanDump = dumpItem(o);
      if (item) {
        var title = textOf(get(item, 'metadata.tileMetadataRenderer.title')) || textOf(item.title) ||
          textOf(get(item, 'metadata.lockupMetadataViewModel.title')) || textOf(item.formattedTitle);
        if (title && !/^(all|todo|todos|tous|alle|tutti|すべて)$/i.test(title.trim())) {
          var before = subs.nameCount;
          addSub(null, title);
          if (subs.nameCount > before) found++;
          if (!diag.subPath) diag.subPath = path + ' → ' + title;
        }
        var ids = uniq(channelIdsIn(item, [], 0));
        if (ids.length === 1) {
          var name = textOf(get(item, 'metadata.tileMetadataRenderer.title')) || textOf(item.title) ||
            textOf(get(item, 'metadata.lockupMetadataViewModel.title')) || textOf(item.formattedTitle);
          if (!subs.ids[ids[0]]) found++;
          addSub(ids[0], name);
          if (!diag.subPath) diag.subPath = path + ' → ' + (name || '(no name)');
        }
        return;
      }
      for (var k in o) if (o.hasOwnProperty(k) && o[k] && typeof o[k] === 'object') walk(o[k], path + '.' + (isArray(o) ? '[]' : k), d + 1);
    })(r, '', 0);
    return found;
  }
  // Debug: flat list of the text fields inside one item, to see YouTube's layout on this TV.
  function dumpItem(it) {
    var out = [];
    (function walk(o, path, d) {
      if (out.length >= 26 || !o || d > 16) return;
      for (var k in o) {
        if (!o.hasOwnProperty(k) || out.length >= 26) continue;
        if (/tracking|accessibility|thumbnail|loggingDirectives|visibility|serializedParams|style$/i.test(k)) continue;
        var v = o[k], p = path ? path + '.' + (isArray(o) ? k : k) : k;
        if (typeof v === 'string') { if (!/^https?:/.test(v)) out.push(p.replace(/Renderer/g, 'R').replace(/ViewModel/g, 'VM') + ' = ' + v.slice(0, 40)); }
        else if (v && typeof v === 'object') walk(v, p, d + 1);
      }
    })(it, '', 0);
    return out.join('\n');
  }
  function uniq(a) { var o = [], seen = {}; for (var i = 0; i < a.length; i++) if (!seen[a[i]]) { seen[a[i]] = 1; o.push(a[i]); } return o; }

  // The left column of the Subscriptions page = every channel you're subscribed to, as tabs.
  function fullChannelList(r) {
    var sections = get(r, 'contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections');
    if (!isArray(sections)) return null;
    var names = [];
    for (var i = 0; i < sections.length; i++) {
      var tabs = get(sections[i], 'tvSecondaryNavSectionRenderer.tabs');
      if (!isArray(tabs)) continue;
      for (var j = 0; j < tabs.length; j++) {
        var t = tabs[j] && tabs[j].tabRenderer;
        if (!t) continue;
        if (get(t, 'endpoint.browseEndpoint.browseId') === 'FEsubscriptions' && j === 0) continue; // "All"
        var title = textOf(t.title);
        if (title && !/^(all|todo|todos|tous|alle|tutti|すべて)$/i.test(title.trim())) names.push(title);
      }
    }
    return names.length ? names : null;
  }

  function learnFromSubscriptionsFeed(r) {
    var full = fullChannelList(r);
    if (full) { replaceNames(full); diag.subPath = 'full list, ' + full.length + ' channels'; }
    learnFromSubscriptionTabs(r);
    learnFromChannelList(r);
    var grids = [];
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 20) return;
      if (o.gridRenderer && o.gridRenderer.items) grids.push(o.gridRenderer.items);
      for (var k in o) if (o.hasOwnProperty(k)) walk(o[k], d + 1);
    })(r, 0);
    for (var g = 0; g < grids.length; g++) {
      for (var i = 0; i < grids[g].length; i++) {
        var it = grids[g][i];
        if (!isVideoItem(it)) continue;
        var ids = channelIdsIn(it, [], 0);
        if (ids.length === 1) addSub(ids[0], channelNameOf(it));
      }
    }
  }

  // Ask the TV app (signed in as you) for your Subscriptions page and sidebar at start,
  // so the list is ready before Home loads.
  function ytMappings() {
    if (!window._yttv) return null;
    // Same lookup TizenTube uses: the app object that has "mappings" also has get().
    for (var k in window._yttv) { var v = window._yttv[k]; if (v && v.mappings && typeof v.get === 'function') return v; }
    for (var k2 in window._yttv) { var v2 = window._yttv[k2]; if (v2 && v2.mappings && typeof v2.mappings.get === 'function') return v2.mappings; }
    return null;
  }
  var subsFetchDone = false;
  function requestGuide() {
    var mappings = ytMappings();
    if (!mappings) { diag.subsFetch = 'app not ready'; return; }
    try {
      var client = mappings.get('KabukiInnerTubeClient');
      client.fetch({ path: '/youtubei/v1/guide' }).subscribe(function (resp) { try { learnFromGuide(resp, 0); } catch (e) { } });
      if (subsFetchDone) return;
      var ids = mappings.get('CurrentIdentityService');
      ids.get().then(function (identity) {
        client.fetch({ identity: identity, isPrefetch: false, path: '/youtubei/v1/browse', payload: { browseId: 'FEsubscriptions' } })
          .subscribe(function (resp) {
            try {
              var before = subs.count;
              learnFromSubscriptionsFeed(resp);
              subsFetchDone = true;
              diag.subsFetch = 'ok';
            } catch (e) { diag.subsFetch = 'error ' + (e && e.message); }
          });
      });
    } catch (e) { diag.subsFetch = 'failed: ' + (e && e.message); }
  }

  // ── TizenTube: seed zen-friendly settings once, then load it ──
  // Later one-time setting changes. Each runs once on the TV; you can switch them back in TizenTube's menu.
  var TIZENTUBE_CHANGES = [
    { flag: 'zentube-change-no-sponsorblock-dearrow', set: { enableSponsorBlock: false, enableDeArrow: false, enableDeArrowThumbnails: false } },
    { flag: 'zentube-change-shorts-rows-on', set: { enableShorts: true } }
  ];
  function applyTizenTubeChanges() {
    for (var i = 0; i < TIZENTUBE_CHANGES.length; i++) {
      var ch = TIZENTUBE_CHANGES[i];
      try {
        if (window.localStorage.getItem(ch.flag)) continue;
        var cfg = {};
        try { cfg = JSON.parse(window.localStorage.getItem('ytaf-configuration')) || {}; } catch (e) { cfg = {}; }
        for (var k in ch.set) if (ch.set.hasOwnProperty(k)) cfg[k] = ch.set[k];
        window.localStorage.setItem('ytaf-configuration', JSON.stringify(cfg));
        window.localStorage.setItem(ch.flag, '1');
      } catch (e) { log('could not apply TizenTube change', e); }
    }
  }

  function seedTizenTubeDefaults() {
    applyTizenTubeChanges();
    try {
      if (window.localStorage.getItem(DEFAULTS_FLAG)) return;
      var cfg = {};
      try { cfg = JSON.parse(window.localStorage.getItem('ytaf-configuration')) || {}; } catch (e) { cfg = {}; }
      for (var k in TIZENTUBE_ZEN_DEFAULTS) if (TIZENTUBE_ZEN_DEFAULTS.hasOwnProperty(k)) cfg[k] = TIZENTUBE_ZEN_DEFAULTS[k];
      window.localStorage.setItem('ytaf-configuration', JSON.stringify(cfg));
      window.localStorage.setItem(DEFAULTS_FLAG, '1');
    } catch (e) { log('could not seed TizenTube settings', e); }
  }

  // ── TizenTube version lock ──
  function cmpVer(a, b) {
    var pa = String(a).split('.'), pb = String(b).split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i] || '0', 10), y = parseInt(pb[i] || '0', 10);
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { } }
  function approvedVersion() {
    var a = lsGet(TT_APPROVED_KEY);
    // Use whichever is newer: the version you approved on the TV, or the one written in this script.
    return (a && cmpVer(a, CONFIG.tizenTubeVersion) > 0) ? a : CONFIG.tizenTubeVersion;
  }
  function tizenTubeUrl() {
    return 'https://cdn.jsdelivr.net/npm/' + TT_PKG + '@' + approvedVersion() + '/dist/userScript.js';
  }
  function getJson(url, cb) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.onload = function () { var j = null; try { j = JSON.parse(x.responseText); } catch (e) { } cb(x.status >= 200 && x.status < 300 ? j : null); };
      x.onerror = function () { cb(null); };
      x.send();
    } catch (e) { cb(null); }
  }
  function latestTizenTubeVersion(cb) {
    getJson('https://data.jsdelivr.com/v1/packages/npm/' + TT_PKG + '/resolved?specifier=latest', function (j) {
      if (j && j.version) return cb(j.version);
      getJson('https://registry.npmjs.org/' + TT_PKG + '/latest', function (k) { cb(k && k.version ? k.version : null); });
    });
  }
  function checkForTizenTubeUpdate() {
    if (!CONFIG.loadTizenTube || !CONFIG.askAboutTizenTubeUpdates) return;
    latestTizenTubeVersion(function (latest) {
      if (!latest) return;
      var cur = approvedVersion();
      if (cmpVer(latest, cur) <= 0) return;
      if (lsGet(TT_SKIP_KEY) === latest) return;
      showPrompt({
        title: 'TizenTube update available',
        lines: ['You have ' + cur + '. Version ' + latest + ' is out.',
          'Updating restarts YouTube. You stay signed in.'],
        buttons: [
          { label: 'Update', action: function () { lsSet(TT_APPROVED_KEY, latest); hidePrompt(); try { window.location.reload(); } catch (e) { } } },
          { label: 'Not now', action: hidePrompt },
          { label: 'Skip this version', action: function () { lsSet(TT_SKIP_KEY, latest); hidePrompt(); } }
        ]
      });
    });
  }

  // ── small on-screen prompt, driven by the TV remote ──
  var prompt = null, pButtons = [], pFocus = 0;
  var P_CSS = '#zen-prompt{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,.85);color:#eee;' +
    'display:-webkit-box;display:-webkit-flex;display:flex;-webkit-box-align:center;-webkit-align-items:center;align-items:center;' +
    '-webkit-box-pack:center;-webkit-justify-content:center;justify-content:center;text-align:center;font-family:Roboto,Arial,sans-serif}' +
    '#zen-prompt .box{background:#18181c;border-radius:24px;padding:50px 70px;max-width:1300px}' +
    '#zen-prompt h1{font-size:52px;font-weight:500;margin:0 0 20px}#zen-prompt p{font-size:30px;color:#aaa;margin:10px 0}' +
    '#zen-prompt .row{margin-top:40px}#zen-prompt .btn{display:inline-block;font-size:34px;padding:20px 40px;margin:0 12px;border-radius:16px;border:4px solid #333;background:#222;color:#fff}' +
    '#zen-prompt .btn.f{border-color:#fff;background:#fff;color:#000}';
  function showPrompt(spec) {
    if (!document.body) return;
    if (!document.getElementById('zen-prompt-style')) {
      var st = document.createElement('style'); st.id = 'zen-prompt-style'; st.textContent = P_CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    prompt = document.createElement('div');
    prompt.id = 'zen-prompt';
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
    var box = el('div', 'box');
    box.appendChild(el('h1', '', spec.title));
    for (var i = 0; i < spec.lines.length; i++) box.appendChild(el('p', '', spec.lines[i]));
    var row = el('div', 'row');
    for (var j = 0; j < spec.buttons.length; j++) row.appendChild(el('span', 'btn', spec.buttons[j].label));
    box.appendChild(row);
    prompt.appendChild(box);
    pButtons = spec.buttons; pFocus = 0;
    document.body.appendChild(prompt);
    paintPrompt();
  }
  function hidePrompt() { if (prompt && prompt.parentNode) prompt.parentNode.removeChild(prompt); pButtons = []; }
  function promptVisible() { return !!(prompt && prompt.parentNode); }
  function paintPrompt() {
    var els = prompt.querySelectorAll('.btn');
    for (var i = 0; i < els.length; i++) els[i].className = 'btn' + (i === pFocus ? ' f' : '');
  }
  function onPromptKey(e) {
    if (!promptVisible()) return;
    e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    var c = e.keyCode;
    if (c === 37 || c === 38) { pFocus = (pFocus - 1 + pButtons.length) % pButtons.length; paintPrompt(); }
    else if (c === 39 || c === 40) { pFocus = (pFocus + 1) % pButtons.length; paintPrompt(); }
    else if (c === 13) { if (pButtons[pFocus]) pButtons[pFocus].action(); }
    else if (c === 10009 || c === 27 || c === 8) hidePrompt();   // Back = "Not now"
  }
  window.addEventListener('keydown', onPromptKey, true);
  window.addEventListener('keyup', onPromptKey, true);
  window.addEventListener('keypress', onPromptKey, true);

  function runBundledTizenTube(note) {
    try {
      window.__zenBundledTizenTube();
      diag.tt = 'running ' + CONFIG.tizenTubeVersion + ' (built in)' + (note ? ' — ' + note : '');
    } catch (e) { diag.tt = 'built-in copy FAILED: ' + (e && e.message); }
  }
  function loadTizenTube(done) {
    if (!CONFIG.loadTizenTube) return done();
    if (approvedVersion() === CONFIG.tizenTubeVersion && typeof window.__zenBundledTizenTube === 'function') {
      runBundledTizenTube('');
      return done();
    }
    var finished = false;
    function once() { if (!finished) { finished = true; done(); } }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', tizenTubeUrl(), true);
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { (0, eval)(xhr.responseText); diag.tt = 'running ' + approvedVersion() + ' (updated on TV)'; }
          catch (e) { runBundledTizenTube('the TV blocked ' + approvedVersion() + ', ask Claude to update'); }
        } else runBundledTizenTube('download of ' + approvedVersion() + ' failed');
        once();
      };
      xhr.onerror = function () { runBundledTizenTube('download failed'); once(); };
      xhr.send();
      setTimeout(function () { if (!finished) { runBundledTizenTube('download timed out'); once(); } }, 15000);
    } catch (e) { runBundledTizenTube(''); once(); }
  }

  function installJsonHook() {
    var prev = JSON.parse;
    var hooked = function () {
      var r = prev.apply(this, arguments);
      diag.parses++;
      try { zenProcess(r); } catch (e) { diag.err = 'filter: ' + (e && e.message); }
      return r;
    };
    JSON.parse = hooked;
    window.JSON.parse = hooked;
    if (window._yttv) {
      for (var k in window._yttv) {
        var o = window._yttv[k];
        if (o && o.JSON && o.JSON.parse) o.JSON.parse = hooked;
      }
    }
  }

  // ── "new version downloaded" notice ──
  function showToast(text, ms) {
    try {
      var el = document.createElement('div');
      var st = el.style;
      st.position = 'fixed'; st.left = '50%'; st.bottom = '60px'; st.zIndex = '2147483647';
      st.transform = 'translateX(-50%)'; st.webkitTransform = 'translateX(-50%)';
      st.background = 'rgba(20,20,24,0.95)'; st.color = '#fff'; st.font = '30px/1.4 Roboto, Arial, sans-serif';
      st.padding = '22px 40px'; st.borderRadius = '18px'; st.textAlign = 'center'; st.pointerEvents = 'none';
      st.border = '3px solid #fff'; st.maxWidth = '1400px';
      el.textContent = text;
      (document.body || document.documentElement).appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ms);
    } catch (e) { }
  }
  (function watchForUpdate() {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      var L = window.__zenLoader;
      if (L && /saved/.test(L.fetched || '')) {
        clearInterval(t);
        showToast('ZenTube was updated. Exit YouTube and open it again to use the new version.', 15000);
      } else if (tries > 60) clearInterval(t);
    }, 2000);
  })();

  // ── boot ──
  seedTizenTubeDefaults();
  installJsonHook();            // right away, so the first screen is filtered too (TizenTube then wraps ours)
  loadTizenTube(function () {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (subsFetchDone || tries > 20) { clearInterval(t); return; }
      requestGuide();
    }, 3000);
    setTimeout(checkForTizenTubeUpdate, 15000);   // after YouTube has finished starting
  });

  window.__zenTube = { CONFIG: CONFIG, subs: subs, zenProcess: zenProcess, addSub: addSub };
})();
