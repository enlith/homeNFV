// Minimal HTML templates served from Worker

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f5f5f5;color:#333;max-width:800px;margin:0 auto;padding:20px}
h1{font-size:1.4em;margin-bottom:16px}
h2{font-size:1.1em;margin-bottom:12px}
a{color:#2563eb;text-decoration:none}
a:hover{text-decoration:underline}
.card{background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
input,button{padding:8px 12px;border-radius:4px;border:1px solid #ddd;font-size:14px}
input{width:100%;margin-bottom:8px}
button{background:#2563eb;color:#fff;border:none;cursor:pointer;padding:8px 16px}
button:hover{background:#1d4ed8}
button.danger{background:#dc2626}
button.danger:hover{background:#b91c1c}
button.secondary{background:#6b7280}
.msg{padding:10px;border-radius:4px;margin-bottom:12px}
.msg.error{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
.msg.success{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0}
.msg.info{background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px;border-bottom:1px solid #eee}
th{font-weight:600;font-size:13px;color:#666}
.file-row{cursor:pointer}
.file-row:hover{background:#f9fafb}
.file-icon{margin-right:6px}
.breadcrumb{margin-bottom:12px;font-size:14px;color:#666}
.breadcrumb a{margin:0 4px}
.actions{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px}
.badge.pending{background:#fef3c7;color:#92400e}
.badge.active{background:#d1fae5;color:#065f46}
.badge.rejected{background:#fef2f2;color:#991b1b}
.offline-banner{background:#fef3c7;color:#92400e;padding:8px 12px;border-radius:4px;margin-bottom:12px;font-size:13px}
.nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid #eee}
.nav-links{display:flex;gap:12px;align-items:center;font-size:14px}
.size{color:#999;font-size:13px}
`;

function layout(title: string, body: string, user?: { username: string; role: string }) {
  const nav = user
    ? `<div class="nav">
        <h1>📁 HomeNFV</h1>
        <div class="nav-links">
          <a href="/browse">Files</a>
          ${user.role === "admin" ? '<a href="/admin">Admin</a>' : ""}
          <span>${user.username}</span>
          <button onclick="fetch('/api/auth/logout',{method:'POST'}).then(()=>location='/login')">Logout</button>
        </div>
      </div>`
    : `<div class="nav"><h1>📁 HomeNFV</h1><div></div></div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — HomeNFV</title><style>${STYLE}</style></head><body>${nav}${body}</body></html>`;
}

export function loginPage(error?: string) {
  return layout("Login", `
    <div class="card">
      <h2>Login</h2>
      ${error ? `<div class="msg error">${error}</div>` : ""}
      <form method="POST" action="/login">
        <input name="username" placeholder="Username" required autofocus>
        <input name="password" type="password" placeholder="Password" required>
        <button type="submit">Login</button>
      </form>
      <p style="margin-top:12px;font-size:13px">No account? <a href="/register">Register</a></p>
    </div>
  `);
}

export function registerPage(error?: string, success?: string) {
  return layout("Register", `
    <div class="card">
      <h2>Register</h2>
      ${error ? `<div class="msg error">${error}</div>` : ""}
      ${success ? `<div class="msg success">${success}</div>` : ""}
      <form method="POST" action="/register">
        <input name="username" placeholder="Username" required autofocus>
        <input name="password" type="password" placeholder="Password (min 8 chars)" required minlength="8">
        <button type="submit">Register</button>
      </form>
      <p style="margin-top:12px;font-size:13px">Have an account? <a href="/login">Login</a></p>
    </div>
  `);
}

export function browsePage(
  path: string,
  files: Array<{ name: string; is_dir: boolean; size: number; modified: number }>,
  user: { username: string; role: string },
  offline?: boolean
) {
  const parts = path.split("/").filter(Boolean);
  let breadcrumb = `<a href="/browse?path=/">root</a>`;
  let accumulated = "";
  for (const p of parts) {
    accumulated += "/" + p;
    breadcrumb += ` / <a href="/browse?path=${encodeURIComponent(accumulated)}">${p}</a>`;
  }

  const rows = files
    .sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1))
    .map((f) => {
      const filePath = path === "/" ? `/${f.name}` : `${path}/${f.name}`;
      const icon = f.is_dir ? "📁" : "📄";
      const link = f.is_dir
        ? `/browse?path=${encodeURIComponent(filePath)}`
        : `/api/files?path=${encodeURIComponent(filePath)}&download=true`;
      const size = f.is_dir ? "—" : formatSize(f.size);
      const modified = f.modified ? new Date(f.modified * 1000).toLocaleString() : "—";
      return `<tr class="file-row">
        <td><input type="checkbox" class="sel" value="${filePath}" onclick="event.stopPropagation();toggleDel()"><a href="${link}"><span class="file-icon">${icon}</span>${f.name}</a></td>
        <td class="size">${size}</td>
        <td class="size">${modified}</td>
      </tr>`;
    })
    .join("");

  return layout("Files", `
    ${offline ? '<div class="offline-banner">⚠️ Home server offline — showing cached listing</div>' : ""}
    <div class="breadcrumb">📂 ${breadcrumb}</div>
    <div class="card">
      <div class="actions">
        <button onclick="document.getElementById('upload').click()">⬆ Upload</button>
        <button class="secondary" onclick="promptMkdir()">📁 New Folder</button>
        <button class="secondary" onclick="promptUploadURL()">🔗 Upload URL</button>
        <button class="secondary" id="del-btn" style="display:none;background:#c0392b;color:#fff" onclick="deleteSelected()">🗑 Delete</button>
        <input type="file" id="upload" style="display:none" multiple onchange="uploadFiles(this.files)">
        <span id="upload-status" style="font-size:13px"></span>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Size</th><th>Modified</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" style="color:#999;text-align:center;padding:20px">Empty directory</td></tr>'}</tbody>
      </table>
    </div>
    <script>
    const currentPath = ${JSON.stringify(path)};
    async function uploadFiles(fileList) {
      const status = document.getElementById('upload-status');
      for (const file of fileList) {
        status.textContent = 'Uploading ' + file.name + '...';
        const filePath = currentPath === '/' ? '/' + file.name : currentPath + '/' + file.name;
        const resp = await fetch('/api/files?path=' + encodeURIComponent(filePath), {
          method: 'PUT',
          headers: { 'Content-Length': file.size },
          body: file
        });
        const data = await resp.json();
        if (!resp.ok) { status.textContent = 'Error: ' + data.error; return; }
      }
      status.textContent = 'Done!';
      setTimeout(() => location.reload(), 500);
    }
    function promptMkdir() {
      const name = prompt('Folder name:');
      if (!name) return;
      const dirPath = currentPath === '/' ? '/' + name : currentPath + '/' + name;
      fetch('/api/mkdir?path=' + encodeURIComponent(dirPath), { method: 'POST' })
        .then(r => r.json())
        .then(() => location.reload());
    }
    async function promptUploadURL() {
      const url = prompt('File URL to download:');
      if (!url) return;
      let name = url.split('/').pop().split('?')[0] || 'downloaded-file';
      name = prompt('Save as:', name);
      if (!name) return;
      const filePath = currentPath === '/' ? '/' + name : currentPath + '/' + name;
      const status = document.getElementById('upload-status');
      status.textContent = 'Downloading from URL...';
      const resp = await fetch('/api/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, path: filePath })
      });
      const data = await resp.json();
      if (!resp.ok) { status.textContent = 'Error: ' + data.error; return; }
      status.textContent = 'Done! (' + (data.size ? (data.size/1024/1024).toFixed(1) + 'MB' : '') + ')';
      setTimeout(() => location.reload(), 500);
    }
    function toggleDel() {
      document.getElementById('del-btn').style.display =
        document.querySelectorAll('.sel:checked').length ? '' : 'none';
    }
    async function deleteSelected() {
      const checked = [...document.querySelectorAll('.sel:checked')];
      if (!checked.length) return;
      if (!confirm('Delete ' + checked.length + ' item(s)?')) return;
      for (const cb of checked) {
        await fetch('/api/files?path=' + encodeURIComponent(cb.value), { method: 'DELETE' });
      }
      location.reload();
    }
    </script>
  `, user);
}

export function adminPage(
  users: Array<{ id: string; username: string; role: string; status: string; createdAt: number }>,
  user: { username: string; role: string },
  message?: string
) {
  const rows = users
    .map((u) => `<tr>
      <td>${u.username}</td>
      <td>${u.role}</td>
      <td><span class="badge ${u.status}">${u.status}</span></td>
      <td class="size">${new Date(u.createdAt).toLocaleDateString()}</td>
      <td>${u.status === "pending" ? `
        <button onclick="action('${u.id}','approve')">Approve</button>
        <button class="danger" onclick="action('${u.id}','reject')">Reject</button>
      ` : ""}</td>
    </tr>`)
    .join("");

  return layout("Admin", `
    ${message ? `<div class="msg success">${message}</div>` : ""}
    <div class="card">
      <h2>User Management</h2>
      <table>
        <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <script>
    async function action(id, act) {
      await fetch('/api/admin/users/' + id + '/' + act, { method: 'POST' });
      location.reload();
    }
    </script>
  `, user);
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}
