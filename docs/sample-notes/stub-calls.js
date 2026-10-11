(function (app, id) {
  // A STUBBED Fathom for the end-to-end test and for the screenshots. Nothing here reaches the network: the plugin's http function
  // is replaced, so no request leaves the app and no real key is used. Sample people are made up.
  var p = app.plugins.plugins[id];
  var KEY = 'stub-fathom-key-0000';
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var clock = function (sec) { return '00:' + pad(Math.floor(sec / 60)) + ':' + pad(sec % 60); };
  var row = function (n, title, day, min, people, summary, actions, lines) {
    var d = '2026-10-' + pad(day);
    return {
      title: title, meeting_title: title, meeting_type: null, recording_id: 4100 + n, url: 'https://fathom.video/calls/' + (4100 + n),
      share_url: 'https://fathom.video/share/stub' + n, created_at: d + 'T13:00:00Z', scheduled_start_time: d + 'T12:00:00Z',
      recording_start_time: d + 'T12:01:00Z', recording_end_time: d + 'T' + pad(12 + Math.floor((1 + min) / 60)) + ':' + pad((1 + min) % 60) + ':00Z', transcript_language: 'en',
      calendar_invitees: people.map(function (x) { return { name: x[0], email: x[1], is_external: false }; }),
      recorded_by: { name: people[0][0], email: people[0][1], team: null },
      default_summary: { template_name: 'general', markdown_formatted: summary },
      action_items: actions.map(function (a) { return { description: a[0], completed: a[1], assignee: { name: a[2], email: null, team: null } }; }),
      transcript: lines.map(function (l, i) { return { speaker: { display_name: l[0] }, text: l[1], timestamp: clock(i * 12 + 3) }; })
    };
  };
  var maria = ['Maria Lopez', 'maria@example.com'], chen = ['Chen Wei', 'chen@example.com'], sam = ['Sam Okoye', 'sam@example.com'], jo = ['Jo Park', 'jo@example.com'];
  var st = { calls: [], mode: 'ok', pro: false };
  st.fa = [
    row(1, 'Weekly product sync', 5, 32, [maria, chen, sam], 'The team agreed to ship the import screen on Friday. Sam will fix the date bug first.',
      [['Write the release notes', false, 'Maria Lopez'], ['Tell support about the new screen', false, 'Maria Lopez'], ['Fix the date bug in the importer', false, 'Sam Okoye']],
      [['Maria Lopez', 'Let us start with the import screen.'], ['Sam Okoye', 'The date bug is the last blocker.'], ['Sam Okoye', 'I can fix it today.'], ['Chen Wei', 'Then we ship on Friday.']]),
    row(2, 'Northwind renewal call', 6, 41, [maria, jo], 'Northwind wants a two year renewal with a price lock. Maria will send a draft offer.',
      [['Send the draft offer by Monday', false, 'Maria Lopez']], [['Jo Park', 'We would like a two year term.'], ['Maria Lopez', 'I can offer a price lock for the first year.']]),
    row(3, 'Design review: onboarding', 7, 25, [chen, sam], 'Three screens were approved. The welcome text needs one more edit.',
      [['Edit the welcome text', false, 'Chen Wei']], [['Chen Wei', 'The first screen is clear.']]),
    row(4, 'Quarterly planning', 8, 45, [jo, maria, chen], '## Goals\nFocus on onboarding and retention.\n\n## Risks\nThe import screen can slip by a week.',
      [['Book the planning room for November', true, 'Jo Park'], ['Share the goals with the team', false, 'Maria Lopez']],
      [['Jo Park', 'Our goal is better onboarding.'], ['Maria Lopez', 'Retention is the second goal.']]),
    row(5, 'One to one with Jo', 9, 30, [jo, maria], 'Jo and Maria talked about the hiring plan and the next review date.',
      [['Send the job post to Jo', false, 'Maria Lopez']], [['Jo Park', 'We need one more engineer.']])
  ];
  st.base = { fa: st.fa.slice() };
  st.reset = async function () {
    // Back to the first run: no notes of ours, no cursor, nothing remembered as deleted.
    var s = p.service.state;
    for (var k in s.meetings) { var f = app.vault.getFileByPath(s.meetings[k].path); if (f) await app.vault.delete(f); }
    s.cursors = { fathom: { since: null, until: null, high: null } };
    s.meetings = {}; s.deleted = []; s.lastSync = null;
    st.fa = st.base.fa.slice(); st.calls = []; st.mode = 'ok';
  };
  // Pro on or off without GitHub: the plugin asks the Sponsors manager, so the stub answers for it.
  st.setPro = function (on) { st.pro = !!on; p.pro.isPro = function () { return st.pro; }; };
  p.service.deps.client.deps.http = function (r) {
    st.calls.push({ provider: r.provider, payload: r.payload, apiKey: r.headers['X-Api-Key'] || '' });
    if (st.mode === 'offline') return Promise.resolve({ status: 0, json: null, headers: {} });
    if (st.mode === '401') return Promise.resolve({ status: 401, json: null, headers: {} });
    if (st.mode === '429') return Promise.resolve({ status: 429, json: null, headers: { 'retry-after': '1' } });
    var q = new URLSearchParams(r.payload), withTr = q.get('include_transcript') === 'true', after = q.get('created_after'), before = q.get('created_before');
    var items = st.fa.filter(function (x) { return (!after || x.created_at > after) && (!before || x.created_at < before); })
      .map(function (x) { var c = JSON.parse(JSON.stringify(x)); if (!withTr) delete c.transcript; return c; });
    return Promise.resolve({ status: 200, json: { limit: null, next_cursor: null, items: items }, headers: {} });
  };
  p.service.deps.sleep = function () { return Promise.resolve(); };
  app.secretStorage.setSecret(p.settings.fathomSecretId, KEY);
  window.__csStub = st;
  return 'ok';
})(app, 'call-notes-sync')
