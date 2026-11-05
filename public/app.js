(function () {
  // confirm dialogs without inline handlers
  document.addEventListener('submit', function (ev) {
    var msg = ev.target && ev.target.dataset && ev.target.dataset.confirm;
    if (msg && !window.confirm(msg)) ev.preventDefault();
  });

  var log = document.getElementById('log');
  if (!log || !window.EventSource) return;
  var es = new EventSource(log.dataset.events);
  var reloading = false;
  var pending = false;
  es.addEventListener('log', function (ev) {
    var d = JSON.parse(ev.data);
    var stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    var t = new Date(d.ts);
    var hh = [t.getHours(), t.getMinutes(), t.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
    var line = document.createElement('div');
    line.className = 'l-' + d.level;
    line.textContent = hh + ' ' + d.message;
    log.appendChild(line);
    while (log.childNodes.length > 1000) log.removeChild(log.firstChild);
    if (stick) log.scrollTop = log.scrollHeight;
  });

  // Never reload while the user is typing (e.g. reject feedback): it would discard the text.
  function typing() {
    var a = document.activeElement;
    return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.isContentEditable);
  }
  function reload() {
    if (reloading) return;
    if (typing()) { pending = true; return; }
    reloading = true;
    setTimeout(function () { es.close(); location.reload(); }, 400);
  }
  document.addEventListener('focusout', function () {
    // focus moves to the next element after focusout; check once it has settled
    setTimeout(function () { if (pending && !typing()) { pending = false; reload(); } }, 0);
  });

  // Reload only when the status or stage differs from what this page rendered.
  es.addEventListener('status', function (ev) {
    var d;
    try { d = JSON.parse(ev.data); } catch (e) { d = {}; }
    if (d.status === log.dataset.status && d.stage === log.dataset.stage) return;
    reload();
  });
})();
