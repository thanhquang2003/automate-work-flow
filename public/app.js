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
  es.addEventListener('status', function () {
    if (reloading) return;
    reloading = true;
    setTimeout(function () { es.close(); location.reload(); }, 400);
  });
})();
