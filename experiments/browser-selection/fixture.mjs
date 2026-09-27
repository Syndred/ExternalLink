import http from 'node:http';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(root, 'evidence'), { recursive: true });
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shell = (body) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>ExternalLink browser trial</title><style>body{font:18px system-ui;max-width:900px;margin:36px auto;color:#17212b}label{display:block;margin:14px 0}input,textarea,select,button{font:inherit;padding:7px}input[type=text],textarea{width:90%}pre{white-space:pre-wrap;background:#eef5f1;padding:20px;border-radius:10px}button{cursor:pointer}small{color:#567}</style>${body}</html>`;
const form = `<form method="post" action="/submit" enctype="multipart/form-data"><label>Product name <input name="product" required></label><label>Website <input type="url" name="website" required></label><label>Description <textarea name="description" required></textarea></label><label>Category <select name="category"><option value="tools">Tools</option><option value="games">Games</option></select></label><label><input type="checkbox" name="confirmed" value="yes" required> Confirm synthetic test</label><label>Attachment <input type="file" name="attachment" required></label><button type="submit">Submit test</button></form>`;
const records = [];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/records') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(records));
    }
    if (url.pathname === '/session') {
      res.writeHead(303, { 'Set-Cookie': 'trial_session=synthetic-only; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax', Location: '/' });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/submit') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request('http://127.0.0.1/submit', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) });
      const data = await request.formData();
      const file = data.get('attachment');
      const record = { id: `receipt-${records.length + 1}`, receivedAt: new Date().toISOString(), product: data.get('product'), website: data.get('website'), description: data.get('description'), category: data.get('category'), confirmed: data.get('confirmed'), fileName: file.name, fileSha256: createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex') };
      records.push(record);
      await appendFile(path.join(root, 'evidence', 'server-receipts.jsonl'), JSON.stringify(record) + '\n');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(shell(`<h1>Submission received</h1><p>Receipt: <strong id="receipt">${record.id}</strong></p><small>Local synthetic test. This is not a directory submission.</small><pre>${esc(JSON.stringify(record, null, 2))}</pre><a href="/">Return to test form</a>`));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const cookie = /trial_session=synthetic-only/.test(req.headers.cookie ?? '') ? 'present' : 'absent';
    res.end(shell(`<h1>ExternalLink browser trial</h1><p>Synthetic data only · independent browser profile</p><p>Cookie: <strong id="cookie">${cookie}</strong> · Storage: <strong id="storage"></strong></p><a href="/session">Create synthetic session</a> <button id="save-marker" onclick="localStorage.setItem('trial-marker','synthetic-only');document.querySelector('#storage').textContent='present'">Save storage marker</button>${url.pathname === '/delayed' ? `<p id="loading">Loading form…</p><template id="delayed-form">${form}</template><div id="target"></div>` : form}<script>document.querySelector('#storage').textContent=localStorage.getItem('trial-marker')==='synthetic-only'?'present':'absent';${url.pathname === '/delayed' ? "setTimeout(()=>{document.querySelector('#target').append(document.querySelector('#delayed-form').content.cloneNode(true));document.querySelector('#loading').remove()},400)" : ''}</script>`));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(root, 'endpoint.json'), JSON.stringify({ url, pid: process.pid }));
  await writeFile(path.join(root, 'attachment.txt'), 'ExternalLink synthetic upload fixture\n');
  console.log(JSON.stringify({ url, pid: process.pid }));
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
